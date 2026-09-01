use bollard::{
    container::LogOutput,
    models::{ContainerSummary, MountPoint, MountPointTypeEnum, VolumeListResponse},
    query_parameters::{
        ListContainersOptionsBuilder, ListNetworksOptionsBuilder, ListVolumesOptionsBuilder,
        LogsOptionsBuilder,
    },
    Docker,
};
use dockermap_core::{
    page_log_entries, parse_rfc3339_nano_millis, unix_timestamp_millis, ComposeMountKind,
    ContainerMount, ContainerRecord, DockerSnapshot, LogCursor, LogEntry, LogsResponse,
    NetworkRecord, VolumeRecord, MAX_LOG_PAGE_SIZE,
};
use futures_util::stream::StreamExt;
use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::publication::truncate_chars;
use crate::{
    docker_config::{docker_gateway_socket_from_env, docker_label_filter_from_env},
    redact_runtime_display_text,
};

#[derive(Clone)]
pub(crate) struct DockerCollector {
    client: Docker,
    label_filter: Option<String>,
}

impl DockerCollector {
    pub(crate) fn connect() -> Result<Self, String> {
        let label_filter = docker_label_filter_from_env()?;
        let socket = docker_gateway_socket_from_env()?;
        let client = Docker::connect_with_unix(&socket, 120, bollard::API_DEFAULT_VERSION)
            .map_err(|error| format!("failed to connect to Docker Read Gateway: {error}"))?;
        Ok(Self {
            client,
            label_filter,
        })
    }

    #[cfg(test)]
    pub(crate) fn with_client(client: Docker, label_filter: Option<String>) -> Self {
        Self {
            client,
            label_filter,
        }
    }

    pub(crate) async fn collect_snapshot(&self) -> Result<DockerSnapshot, String> {
        let filters = self.docker_filters();
        let mut container_options = ListContainersOptionsBuilder::new().all(true);
        if let Some(filters) = filters.as_ref() {
            container_options = container_options.filters(filters);
        }
        let containers = self
            .client
            .list_containers(Some(container_options.build()))
            .await
            .map_err(|error| format!("list_containers failed: {error}"))?;

        let mut network_options = ListNetworksOptionsBuilder::new();
        if let Some(filters) = filters.as_ref() {
            network_options = network_options.filters(filters);
        }
        let networks = self
            .client
            .list_networks(Some(network_options.build()))
            .await
            .map_err(|error| format!("list_networks failed: {error}"))?;

        let mut volume_options = ListVolumesOptionsBuilder::new();
        if let Some(filters) = filters.as_ref() {
            volume_options = volume_options.filters(filters);
        }
        let volumes = self
            .client
            .list_volumes(Some(volume_options.build()))
            .await
            .map_err(|error| format!("list_volumes failed: {error}"))?;

        Ok(build_snapshot(containers, networks, volumes))
    }

    fn docker_filters(&self) -> Option<HashMap<String, Vec<String>>> {
        self.label_filter
            .as_ref()
            .map(|label| HashMap::from([("label".to_string(), vec![label.clone()])]))
    }

    pub(crate) async fn collect_logs(
        &self,
        service: &str,
        query: Option<&str>,
        cursor: Option<LogCursor>,
        limit: usize,
    ) -> Result<LogsResponse, String> {
        let limit = limit.clamp(1, MAX_LOG_PAGE_SIZE);
        let mut options = LogsOptionsBuilder::new()
            .follow(false)
            .stdout(true)
            .stderr(true)
            .timestamps(true)
            .tail(&log_tail_count().to_string());

        if let Some(cursor) = cursor {
            options = options.until(log_until_seconds(cursor.millis));
        }

        let mut stream = self.client.logs(service, Some(options.build()));

        // Docker streams the `tail(limit)` window OLDEST-first, so we cannot
        // decide page boundaries while streaming: collect the whole window
        // (bounded server-side by `tail`, plus a defensive cap in case Docker
        // returns more than requested), then page it in a pure function.
        let mut entries = Vec::new();
        // Same-millisecond ordinal, assigned in stream order. Every request
        // opens the SAME fixed tail window (MAX_LOG_CURSOR_TAIL), so a
        // physical line's ordinal (how many same-ms lines PRECEDE it in the
        // stream) is stable across requests: new lines append chronologically
        // and never re-order existing same-ms lines, so the id is a property
        // of the physical line — unlike a per-request sequence counter,
        // which would change the id and defeat the client's dedupe-by-id.
        // The ordinal is what keeps two distinct physical lines that share a
        // service, an ms-truncated timestamp, and identical message text
        // from collapsing onto one id.
        let mut same_timestamp_seen = HashMap::<u64, usize>::new();

        while let Some(item) = stream.next().await {
            let output = item.map_err(|error| format!("docker logs failed: {error}"))?;
            let (timestamp, message) = match output {
                LogOutput::StdOut { message }
                | LogOutput::StdErr { message }
                | LogOutput::Console { message }
                | LogOutput::StdIn { message } => {
                    let Some((timestamp, message)) = parse_timestamped_log_line(&message) else {
                        continue;
                    };
                    (timestamp, message)
                }
            };

            let ordinal = same_timestamp_seen.entry(timestamp).or_insert(0);
            entries.push(LogEntry {
                id: log_entry_id(service, timestamp, *ordinal),
                timestamp,
                container: service.to_string(),
                level: if message.to_ascii_lowercase().contains("error") {
                    dockermap_core::LogLevel::Error
                } else if message.to_ascii_lowercase().contains("warn") {
                    dockermap_core::LogLevel::Warn
                } else {
                    dockermap_core::LogLevel::Info
                },
                message,
            });
            *ordinal += 1;

            if entries.len() >= MAX_LOG_STREAM_CAP {
                break;
            }
        }

        Ok(publish_log_response(
            Some(service),
            entries,
            query,
            cursor,
            limit,
        ))
    }
}

/// Parse one timestamped Docker log line (collected with `--timestamps`) into
/// a `(timestamp_millis, message)` pair, or `None` when the line carries no
/// usable message.
///
/// Docker prefixes ONLY the first line of a multi-line message with a
/// timestamp; continuation lines are bare text. A prefix is therefore only
/// stripped when it actually parses as an RFC 3339 timestamp — continuation
/// lines and blank lines are SKIPPED (`None`) rather than fabricated into a
/// now()-timestamped entry, and their first token is never eaten. A blank
/// line arrives from Docker as `"<timestamp> "` (timestamp, space, empty
/// body); the empty body also yields `None`.
pub(crate) fn parse_timestamped_log_line(line: &[u8]) -> Option<(u64, String)> {
    let text = String::from_utf8_lossy(line);
    let (prefix, rest) = text.split_once(' ')?;
    let timestamp = parse_rfc3339_nano_millis(prefix)?;
    let message = truncate_chars(rest.trim(), MAX_LOG_MESSAGE_CHARS);
    if message.is_empty() {
        return None;
    }
    Some((timestamp, message))
}

/// Number of lines requested from Docker's `tail` for one log page.
///
/// EVERY page — first and cursor — opens the same fixed window
/// (`MAX_LOG_CURSOR_TAIL`). Docker's `--tail N` selects the last N lines of
/// the FULL log and `--until` only FILTERS that fixed window — it never moves
/// the window older — so a cursor page needs a large window for
/// `until(cursor)` and `page_log_entries`' precise `< cursor` filter to reach
/// older lines. The FIRST page must open the very same window: the
/// same-millisecond ordinal counts the same-ms lines PRECEDING a line in the
/// collected window, so a narrower first-page window (the old `limit + 1`)
/// assigned different ordinals to the same physical lines than a cursor
/// page's window did — the two id sets collided, and the client's
/// dedupe-by-id silently discarded whole cursor pages. With one fixed window,
/// a same-ms run of up to `MAX_LOG_CURSOR_TAIL` lines gets identical ids on
/// every fetch.
///
/// `page_log_entries` truncates the collected window to `limit` and emits a
/// cursor whenever the window holds more than `limit` entries; the fixed
/// window is wider than any page, so a next page is still detected for live
/// Docker logs and "Load older" stays visible. Trade-off: history older than
/// `MAX_LOG_CURSOR_TAIL` is unreachable.
pub(crate) fn log_tail_count() -> usize {
    MAX_LOG_CURSOR_TAIL
}

/// Docker's `until` filter is second-resolution and EXCLUSIVE: a line at
/// exactly `until` seconds is omitted. The cursor is compound (`millis:offset`,
/// see `LogCursor`), so the boundary millisecond's not-yet-emitted entries
/// must still be returned: `until` must cover the second that CONTAINS the
/// boundary millisecond, i.e. `floor(millis / 1000) + 1`. That also returns
/// the rest of the boundary second (entries newer than the boundary that were
/// already emitted) — `page_log_entries`' precise cursor filter is the sole
/// arbiter of what belongs to the next page.
pub(crate) fn log_until_seconds(cursor_millis: u64) -> i32 {
    (cursor_millis / 1_000 + 1).min(i32::MAX as u64) as i32
}

/// Fixed `tail` window opened for EVERY log page (first page and cursor
/// pages alike). See `log_tail_count` for why the window must be identical
/// across requests: a window-relative same-ms ordinal would make log entry
/// ids unstable, colliding id sets between pages and defeating the client's
/// dedupe-by-id.
pub(crate) const MAX_LOG_CURSOR_TAIL: usize = 4_096;

const MAX_LOG_MESSAGE_CHARS: usize = 4_096;

/// Defensive cap on the raw log stream collected from Docker. The stream is
/// already bounded by `tail(...)`, so this only guards against a daemon
/// returning more than requested — but it must be at least as large as the
/// tail window (`MAX_LOG_CURSOR_TAIL`), or a page's window would be truncated
/// before `page_log_entries` sees it.
const MAX_LOG_STREAM_CAP: usize = MAX_LOG_CURSOR_TAIL + 1;

/// Stable id for a live-Docker log entry, unique per PHYSICAL line.
///
/// The id is `service-timestamp-ordinal`, where `ordinal` is the line's
/// index among same-millisecond entries in stream order (how many same-ms
/// lines precede it). Docker streams a log's tail window in stable
/// chronological order and every request opens the same fixed window
/// (`MAX_LOG_CURSOR_TAIL`, see `log_tail_count`), so the ordinal — unlike a
/// per-request sequence counter — is deterministic across requests: the same
/// physical line always gets the same id, while two DISTINCT lines sharing a
/// service, an
/// ms-truncated timestamp, and identical message text still get distinct
/// ids. Content hashing alone (service + timestamp + message) collapsed
/// such lines onto one id, and the client's dedupe-by-id silently dropped
/// the second one — even though the compound cursor was built to preserve
/// same-ms entries at page boundaries.
pub(crate) fn log_entry_id(service: &str, timestamp: u64, ordinal: usize) -> String {
    format!("{service}-{timestamp}-{ordinal:04x}")
}

/// Apply the common publication boundary to every log source BEFORE matching a
/// query or calculating a cursor. This makes live Docker and mock logs agree
/// on both what is visible and what can affect pagination.
pub(crate) fn publish_log_response(
    service: Option<&str>,
    mut entries: Vec<LogEntry>,
    query: Option<&str>,
    cursor: Option<LogCursor>,
    limit: usize,
) -> LogsResponse {
    for entry in &mut entries {
        entry.id = redact_runtime_display_text(&entry.id);
        entry.container = redact_runtime_display_text(&entry.container);
        entry.message = redact_runtime_display_text(&entry.message);
    }
    let (entries, next_cursor) = page_log_entries(entries, query, cursor, limit);
    LogsResponse {
        service: service.map(redact_runtime_display_text),
        entries,
        next_cursor,
        ..Default::default()
    }
}

// Log page boundaries are decided by `dockermap_core::page_log_entries`
// (imported above) — the single source of truth shared with mock_logs so the
// live-Docker, daemon-mock, and Node-API-mock paths agree on cursor format.

/// Parse the `com.docker.compose.depends_on` label into container refs.
///
/// Compose stores the label as `service:condition:required,service2:...`
/// (e.g. `redis:service_started:false,database:service_started:false`) where
/// each item is the compose SERVICE name plus a condition suffix. Only the
/// service name matters for graph derivation — the suffix must be stripped
/// before the ref can resolve (the refs match compose service names, which
/// the snapshot records as each container's `role`).
pub(crate) fn parse_depends_on_label(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|item| item.split(':').next().unwrap_or("").trim())
        .filter(|name| !name.is_empty())
        .map(|name| format!("container_{name}"))
        .collect()
}

fn build_snapshot(
    containers: Vec<ContainerSummary>,
    networks: Vec<bollard::models::Network>,
    volume_response: VolumeListResponse,
) -> DockerSnapshot {
    let mut member_sets: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut volume_sets: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut container_records = Vec::new();

    for container in containers {
        let id = container.id.unwrap_or_else(|| "unknown-container".into());
        let name = container
            .names
            .as_ref()
            .and_then(|names| names.first())
            .map(|value| value.trim_start_matches('/').to_string())
            .unwrap_or_else(|| id.clone());

        let network_ids = container
            .network_settings
            .and_then(|settings| settings.networks)
            .map(|mapping| {
                mapping
                    .into_iter()
                    .filter_map(|(_, endpoint)| endpoint.network_id)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        for network_id in &network_ids {
            member_sets
                .entry(network_id.clone())
                .or_default()
                .insert(name.clone());
        }

        if let Some(mounts) = &container.mounts {
            for mount in mounts {
                if let Some(volume_name) = &mount.name {
                    volume_sets
                        .entry(volume_name.clone())
                        .or_default()
                        .insert(name.clone());
                }
            }
        }
        let mounts = collect_container_mounts(&id, container.mounts.as_deref());

        let depends_on = container
            .labels
            .as_ref()
            .and_then(|labels| labels.get("com.docker.compose.depends_on"))
            .map(|value| parse_depends_on_label(value))
            .unwrap_or_default();

        container_records.push(ContainerRecord {
            id,
            name,
            image: container.image.unwrap_or_else(|| "unknown".into()),
            status: container.status.unwrap_or_else(|| "unknown".into()),
            role: container
                .labels
                .as_ref()
                .and_then(|labels| labels.get("com.docker.compose.service"))
                .cloned()
                .unwrap_or_else(|| "service".into()),
            networks: network_ids,
            ports: container
                .ports
                .unwrap_or_default()
                .into_iter()
                .map(|port| {
                    let private = port.private_port;
                    let public = port.public_port.unwrap_or_default();
                    let kind = port
                        .typ
                        .map(|value| format!("{value:?}").to_ascii_lowercase())
                        .unwrap_or_else(|| "tcp".into());
                    if public > 0 {
                        format!("{public}:{private}/{kind}")
                    } else {
                        format!("{private}/{kind}")
                    }
                })
                .collect(),
            mounts,
            depends_on,
        });
    }

    let mut network_records = networks
        .into_iter()
        .map(|network| {
            let id = network.id.unwrap_or_else(|| "unknown-network".into());
            NetworkRecord {
                members: member_sets
                    .remove(&id)
                    .unwrap_or_default()
                    .into_iter()
                    .collect(),
                id,
                name: network.name.unwrap_or_else(|| "unnamed".into()),
                driver: network.driver.unwrap_or_else(|| "bridge".into()),
                internal: network.internal.unwrap_or(false),
            }
        })
        .collect::<Vec<_>>();
    network_records.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then(left.name.cmp(&right.name))
            .then(left.driver.cmp(&right.driver))
            .then(left.internal.cmp(&right.internal))
            .then(left.members.cmp(&right.members))
    });

    let mut volume_records = volume_response
        .volumes
        .unwrap_or_default()
        .into_iter()
        .map(|volume| {
            let name = volume.name;
            VolumeRecord {
                id: name.clone(),
                name: name.clone(),
                attached_to: volume_sets
                    .remove(&name)
                    .unwrap_or_default()
                    .into_iter()
                    .collect(),
            }
        })
        .collect::<Vec<_>>();
    volume_records.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then(left.name.cmp(&right.name))
            .then(left.attached_to.cmp(&right.attached_to))
    });

    DockerSnapshot {
        // Images are derived once by the caller (`collect_snapshot`) after
        // the snapshot is built — deriving here would deep-clone the
        // container records and re-derive O(n) on every refresh for nothing.
        images: Vec::new(),
        containers: container_records,
        networks: network_records,
        volumes: volume_records,
        last_updated: unix_timestamp_millis(),
        ..Default::default()
    }
}

fn collect_container_mounts(
    container_id: &str,
    mounts: Option<&[MountPoint]>,
) -> Vec<ContainerMount> {
    mounts
        .unwrap_or(&[])
        .iter()
        .filter_map(|mount| {
            let target = mount.destination.clone()?;
            let kind = match mount.typ {
                Some(MountPointTypeEnum::BIND) => ComposeMountKind::Bind,
                Some(MountPointTypeEnum::VOLUME) if mount.name.is_some() => {
                    ComposeMountKind::NamedVolume
                }
                Some(MountPointTypeEnum::VOLUME) => ComposeMountKind::AnonymousVolume,
                _ => ComposeMountKind::Unsupported,
            };
            let source = match kind {
                ComposeMountKind::Bind => mount.source.clone(),
                ComposeMountKind::NamedVolume => {
                    mount.name.clone().or_else(|| mount.source.clone())
                }
                ComposeMountKind::AnonymousVolume => None,
                ComposeMountKind::Unsupported => {
                    mount.source.clone().or_else(|| mount.name.clone())
                }
            };

            Some(ContainerMount {
                id: format!(
                    "{container_id}:{}:{}",
                    target,
                    source.as_deref().unwrap_or("anonymous")
                ),
                kind,
                source,
                target,
                read_only: mount.rw.map(|rw| !rw).unwrap_or(false),
            })
        })
        .collect()
}
