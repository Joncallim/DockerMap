//! Test-only stage attribution for the time-to-answer benchmark (#335).
//!
//! This module measures the *current* implementation without changing it. The
//! Docker observation and the Compose filesystem projection are timed as two
//! separately attributable stages even though they still execute inside one
//! publication budget; #336 owns moving the projection off that critical path.
//!
//! It is inert unless `DOCKERMAP_BENCH_STAGE_TIMING_PATH` names an absolute
//! path. When unset or unusable, nothing is measured, nothing is written, and
//! no public response changes. There is no route, no response field, and no
//! production telemetry: the sink is an append-only newline-delimited JSON file
//! chosen by the benchmark harness.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

const BENCH_STAGE_TIMING_PATH_ENV: &str = "DOCKERMAP_BENCH_STAGE_TIMING_PATH";

/// Docker inventory observation (containers, networks, volumes).
pub(crate) const STAGE_DOCKER_OBSERVATION: &str = "dockerObservationMs";
/// Compose filesystem projection for the same publication.
pub(crate) const STAGE_COMPOSE_ENRICHMENT: &str = "composeEnrichmentMs";
/// Findings derivation for the published runtime map.
pub(crate) const STAGE_FINDINGS_DERIVATION: &str = "findingsDerivationMs";

/// Resolve the configured sink. Only an absolute path is accepted, so a
/// relative value cannot silently land inside a working directory, and an
/// empty or malformed value disables the hook instead of failing a publication.
pub(crate) fn sink_from_env_value(value: Option<String>) -> Option<PathBuf> {
    let value = value?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return None;
    }
    Some(path.to_path_buf())
}

pub(crate) fn sink() -> Option<PathBuf> {
    sink_from_env_value(std::env::var(BENCH_STAGE_TIMING_PATH_ENV).ok())
}

/// One NDJSON record. Kept pure so its shape is testable without touching the
/// process environment or the filesystem.
pub(crate) fn stage_timing_line(stage: &str, milliseconds: f64) -> String {
    format!("{{\"stage\":\"{stage}\",\"ms\":{milliseconds:.3}}}\n")
}

fn write_line(sink: Option<&Path>, line: &str) {
    let Some(path) = sink else {
        return;
    };
    // A benchmark sink must never be able to interrupt collection: a write
    // failure is dropped, not propagated.
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Record one stage duration. A no-op when the hook is disabled.
pub(crate) fn record(sink: Option<&Path>, stage: &str, start: Instant) {
    if sink.is_none() {
        return;
    }
    let elapsed = start.elapsed();
    write_line(
        sink,
        &stage_timing_line(stage, elapsed.as_secs_f64() * 1000.0),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn sink_requires_an_absolute_non_empty_path() {
        assert!(sink_from_env_value(None).is_none());
        assert!(sink_from_env_value(Some(String::new())).is_none());
        assert!(sink_from_env_value(Some("   ".into())).is_none());
        assert!(sink_from_env_value(Some("relative/bench.jsonl".into())).is_none());
        assert!(sink_from_env_value(Some("./bench.jsonl".into())).is_none());
        assert_eq!(
            sink_from_env_value(Some("/tmp/dockermap-bench.jsonl".into())).as_deref(),
            Some(Path::new("/tmp/dockermap-bench.jsonl"))
        );
        assert_eq!(
            sink_from_env_value(Some("  /tmp/dockermap-bench.jsonl  ".into())).as_deref(),
            Some(Path::new("/tmp/dockermap-bench.jsonl"))
        );
    }

    #[test]
    fn stage_lines_are_closed_newline_delimited_json() {
        assert_eq!(
            stage_timing_line(STAGE_DOCKER_OBSERVATION, 12.3456),
            "{\"stage\":\"dockerObservationMs\",\"ms\":12.346}\n"
        );
        assert_eq!(
            stage_timing_line(STAGE_COMPOSE_ENRICHMENT, 0.0),
            "{\"stage\":\"composeEnrichmentMs\",\"ms\":0.000}\n"
        );
        assert!(stage_timing_line(STAGE_DOCKER_OBSERVATION, 1.0).ends_with('\n'));
    }

    #[test]
    fn disabled_hook_writes_nothing() {
        let directory = tempfile::tempdir().expect("temporary bench directory");
        let target = directory.path().join("bench.jsonl");
        record(None, STAGE_DOCKER_OBSERVATION, Instant::now());
        for _ in 0..3 {
            record(None, STAGE_COMPOSE_ENRICHMENT, Instant::now());
        }
        assert!(
            !target.exists(),
            "a disabled bench hook must not create a sink file"
        );
        assert!(std::fs::read_dir(directory.path())
            .expect("bench directory")
            .next()
            .is_none());
    }

    #[test]
    fn enabled_hook_appends_one_line_per_stage() {
        let directory = tempfile::tempdir().expect("temporary bench directory");
        let target = directory.path().join("bench.jsonl");
        let start = Instant::now();
        std::thread::sleep(Duration::from_millis(1));
        record(Some(&target), STAGE_DOCKER_OBSERVATION, start);
        record(Some(&target), STAGE_COMPOSE_ENRICHMENT, start);
        let written = std::fs::read_to_string(&target).expect("bench sink is readable");
        let lines = written.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with("{\"stage\":\"dockerObservationMs\",\"ms\":"));
        assert!(lines[1].starts_with("{\"stage\":\"composeEnrichmentMs\",\"ms\":"));
        for line in lines {
            assert!(line.ends_with('}'));
            let value: serde_json::Value = serde_json::from_str(line).expect("valid JSON line");
            let ms = value
                .get("ms")
                .and_then(|ms| ms.as_f64())
                .expect("numeric ms");
            assert!(ms.is_finite() && ms >= 0.0);
        }
    }
}
