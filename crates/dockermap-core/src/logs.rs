//! Shared log cursor, pagination, and timestamp parsing primitives.

use crate::LogEntry;

/// Upper bound for a single log page returned by any provider path.
pub const MAX_LOG_PAGE_SIZE: usize = 500;

/// Default page size when the caller does not request one.
pub const DEFAULT_LOG_PAGE_SIZE: usize = 100;

/// Compound log cursor: a boundary timestamp (milliseconds) plus how many
/// entries at that exact millisecond were already emitted on previous pages.
///
/// Serialized as `"<millis>:<offset>"` (e.g. `"1787198706123:2"`); a bare
/// `"<millis>"` parses as offset 0. The offset lets cursor pagination resume
/// mid-run when many lines share one millisecond (Docker timestamps are
/// truncated to ms) instead of silently dropping every same-ms entry beyond
/// the page boundary — a plain `timestamp < cursor` filter could never
/// revisit them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LogCursor {
    pub millis: u64,
    pub offset: usize,
}

impl LogCursor {
    pub fn parse(value: &str) -> Option<Self> {
        let (millis, offset) = value.split_once(':').unwrap_or((value, ""));
        let millis = millis.parse::<u64>().ok()?;
        let offset = if offset.is_empty() {
            0
        } else {
            offset.parse::<usize>().ok()?
        };
        Some(Self { millis, offset })
    }
}

impl std::fmt::Display for LogCursor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}:{}", self.millis, self.offset)
    }
}

/// Pure log pagination shared by every log source (live Docker, daemon mock,
/// Node API mock) so all three paths agree on page boundaries.
///
/// Entries are filtered by query, sorted NEWEST-first, and truncated to
/// `limit`. The returned `next_cursor` is a compound `"millis:offset"` cursor
/// (see [`LogCursor`]): entries sharing the boundary millisecond are resumed
/// exactly where the previous page stopped. A cursor is emitted only when
/// more entries exist behind the page, so "Load older" terminates with
/// `None` on the last page (including pages that end exactly on a multiple of
/// `limit`) and never overlaps the previous one.
pub fn page_log_entries(
    entries: Vec<LogEntry>,
    query: Option<&str>,
    cursor: Option<LogCursor>,
    limit: usize,
) -> (Vec<LogEntry>, Option<String>) {
    let limit = limit.clamp(1, MAX_LOG_PAGE_SIZE);
    let filter = query.map(|value| value.to_ascii_lowercase());

    let mut entries = entries
        .into_iter()
        .filter(|entry| {
            filter
                .as_ref()
                .is_none_or(|needle| entry.message.to_ascii_lowercase().contains(needle))
        })
        .collect::<Vec<_>>();

    // Stable sort: same-millisecond entries keep their stream order, so the
    // per-timestamp index below is deterministic across requests.
    entries.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));

    if let Some(cursor) = cursor {
        // Newest-first order means entries newer than the boundary come
        // first (already emitted — drop), then the boundary millisecond's
        // run (keep from `offset` onward), then everything older (keep).
        let mut same_timestamp_seen = 0usize;
        entries = entries
            .into_iter()
            .filter(|entry| {
                if entry.timestamp < cursor.millis {
                    true
                } else if entry.timestamp > cursor.millis {
                    false
                } else {
                    let keep = same_timestamp_seen >= cursor.offset;
                    same_timestamp_seen += 1;
                    keep
                }
            })
            .collect::<Vec<_>>();
    }

    // Decide whether older entries exist BEHIND this page BEFORE truncating:
    // a cursor is emitted only when the filtered page holds more than `limit`
    // entries. On totals that are exact multiples of limit, the last page is
    // exactly full but nothing is older behind it, so a full-page heuristic
    // would emit a trailing cursor that yields an empty next page.
    let has_more = entries.len() > limit;

    let next_cursor = if has_more {
        // The cursor points at the oldest kept entry: its millisecond plus
        // how many entries at that millisecond were emitted through THIS
        // page — the incoming cursor's count for that ms (if it is the same
        // ms) plus the same-ms entries this page keeps — so the next page
        // resumes past them.
        let boundary = &entries[limit - 1];
        let first_at_boundary = entries[..limit]
            .iter()
            .position(|entry| entry.timestamp == boundary.timestamp)
            .unwrap_or(limit - 1);
        let previously_emitted = cursor
            .filter(|cursor| cursor.millis == boundary.timestamp)
            .map_or(0, |cursor| cursor.offset);
        Some(
            LogCursor {
                millis: boundary.timestamp,
                offset: previously_emitted + limit - first_at_boundary,
            }
            .to_string(),
        )
    } else {
        None
    };

    entries.truncate(limit);

    (entries, next_cursor)
}

/// Parse an RFC 3339 / RFC 3339 Nano timestamp prefix (as emitted by
/// `docker logs --timestamps`, e.g. `2026-08-20T04:05:06.123456789Z`) into
/// milliseconds since the Unix epoch. Returns `None` when the value does not
/// match the expected shape. The parser is intentionally dependency-free and
/// covers the fixed-width UTC layout Docker emits; offsets other than `Z` are
/// rejected so callers can rely on the result being UTC.
pub fn parse_rfc3339_nano_millis(value: &str) -> Option<u64> {
    if value.len() < 20 || !value.ends_with('Z') {
        return None;
    }

    let bytes = value.as_bytes();
    let digit = |index: usize| -> Option<u64> {
        let byte = *bytes.get(index)?;
        byte.is_ascii_digit().then_some(u64::from(byte - b'0'))
    };

    let year = 1000 * digit(0)? + 100 * digit(1)? + 10 * digit(2)? + digit(3)?;
    let month = 10 * digit(5)? + digit(6)?;
    let day = 10 * digit(8)? + digit(9)?;
    let hour = 10 * digit(11)? + digit(12)?;
    let minute = 10 * digit(14)? + digit(15)?;
    let second = 10 * digit(17)? + digit(18)?;

    if bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return None;
    }

    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }

    // Fractional seconds: `.` followed by 1..=9 digits, truncated to ms.
    let mut fraction_ms = 0u64;
    if bytes.get(19) == Some(&b'.') {
        let mut multiplier = 100u64;
        let mut consumed = 0usize;
        for index in 20..value.len() {
            let Some(byte) = bytes.get(index) else {
                break;
            };
            if !byte.is_ascii_digit() {
                break;
            }
            if consumed < 3 {
                fraction_ms += u64::from(byte - b'0') * multiplier;
                multiplier /= 10;
            }
            consumed += 1;
        }
        if consumed == 0 {
            return None;
        }
    }

    let days = days_from_civil(year, month, day)?;
    let seconds = days * 86_400 + hour as i64 * 3_600 + minute as i64 * 60 + second as i64;
    u64::try_from(seconds)
        .ok()?
        .checked_mul(1_000)?
        .checked_add(fraction_ms)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil` algorithm). Returns `None` for invalid dates.
fn days_from_civil(year: u64, month: u64, day: u64) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let year = i64::try_from(year).ok()?;
    let month = i64::try_from(month).ok()?;
    let day = i64::try_from(day).ok()?;
    let adjusted_year = year - i64::from(month <= 2);
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let year_of_era = adjusted_year - era * 400;
    let month_adjusted = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_adjusted + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}
