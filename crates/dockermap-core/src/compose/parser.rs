//! Parses Docker Compose YAML files into typed domain structs.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;

use super::{
    AnonymousVolume, BindMount, ComposeDiagnostic, ComposeFile, ComposeMountDeclaration,
    ComposeService, DiagnosticSeverity, NamedVolume, TmpfsMount,
};

// ---------------------------------------------------------------------------
// Raw YAML structs (private)
// ---------------------------------------------------------------------------

/// Top-level compose document.
#[derive(Debug, Deserialize)]
struct RawComposeDocument {
    #[serde(default)]
    version: Option<serde_yaml::Value>,
    #[serde(default)]
    services: BTreeMap<String, RawService>,
    #[serde(default)]
    volumes: BTreeMap<String, serde_yaml::Value>,
    #[serde(default)]
    #[allow(dead_code)]
    networks: serde_yaml::Value,
    #[serde(default)]
    name: Option<String>,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_yaml::Value>,
}

#[derive(Debug, Deserialize, Default)]
struct RawService {
    image: Option<String>,
    build: Option<RawBuild>,
    #[serde(default)]
    volumes: Vec<RawVolumeEntry>,
    #[serde(default)]
    depends_on: RawDependsOn,
    #[serde(default)]
    labels: RawLabels,
}

/// `build` can be either a plain string or a mapping with a `context` key.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawBuild {
    String(String),
    Object { context: Option<String> },
}

/// A volume entry is either a short-form string or a long-form mapping.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawVolumeEntry {
    Short(String),
    Long(RawLongVolume),
}

#[derive(Debug, Deserialize)]
struct RawLongVolume {
    #[serde(rename = "type")]
    kind: String,
    source: Option<String>,
    target: String,
    #[serde(default)]
    read_only: bool,
}

/// `depends_on` is either a list of strings or a map of service → condition.
#[derive(Debug, Deserialize, Default)]
#[serde(untagged)]
enum RawDependsOn {
    #[default]
    None,
    List(Vec<String>),
    Map(BTreeMap<String, serde_yaml::Value>),
}

/// `labels` is either a list of `KEY=VALUE` strings or a mapping.
#[derive(Debug, Deserialize, Default)]
#[serde(untagged)]
enum RawLabels {
    #[default]
    None,
    List(Vec<String>),
    Map(BTreeMap<String, String>),
}

// ---------------------------------------------------------------------------
// Known top-level keys (anything else → UNKNOWN_FIELD warning)
// ---------------------------------------------------------------------------

const KNOWN_TOP_LEVEL: &[&str] = &["version", "services", "volumes", "networks", "name"];

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Parse a Docker Compose file at `path` into a [`ComposeFile`].
///
/// Returns `Ok(ComposeFile)` even when there are non-fatal diagnostics; the
/// caller should inspect `ComposeFile::diagnostics` to check for warnings.
/// Returns `Err(Vec<ComposeDiagnostic>)` only for hard parse failures.
pub fn parse_compose_file(path: &Path) -> Result<ComposeFile, Vec<ComposeDiagnostic>> {
    let path_str = path.to_string_lossy().to_string();
    let project_dir = path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string());

    let content = std::fs::read_to_string(path).map_err(|e| {
        vec![ComposeDiagnostic {
            severity: DiagnosticSeverity::Error,
            code: "IO_ERROR".to_string(),
            message: format!("Failed to read {path_str}: {e}"),
            file: Some(path_str.clone()),
            line: None,
        }]
    })?;

    let raw: RawComposeDocument = serde_yaml::from_str(&content).map_err(|e| {
        vec![ComposeDiagnostic {
            severity: DiagnosticSeverity::Error,
            code: "YAML_PARSE_ERROR".to_string(),
            message: format!("YAML parse error in {path_str}: {e}"),
            file: Some(path_str.clone()),
            line: e.location().map(|l| l.line()),
        }]
    })?;

    let mut diagnostics: Vec<ComposeDiagnostic> = Vec::new();

    // Warn about unknown top-level fields.
    for key in raw.extra.keys() {
        if !KNOWN_TOP_LEVEL.contains(&key.as_str()) {
            diagnostics.push(ComposeDiagnostic {
                severity: DiagnosticSeverity::Warning,
                code: "UNKNOWN_FIELD".to_string(),
                message: format!("Unknown top-level field '{key}' in compose file"),
                file: Some(path_str.clone()),
                line: None,
            });
        }
    }

    // Suppress unused-variable warning for `version` and `name`
    let _ = raw.version;
    let _ = raw.name;

    // Collect named volumes.
    let named_volumes: Vec<String> = raw.volumes.keys().cloned().collect();

    // Convert services.
    let mut services: Vec<ComposeService> = Vec::new();
    for (service_name, raw_service) in &raw.services {
        let build = match &raw_service.build {
            None => None,
            Some(RawBuild::String(s)) => Some(s.clone()),
            Some(RawBuild::Object { context }) => context.clone(),
        };

        let depends_on = match &raw_service.depends_on {
            RawDependsOn::None => vec![],
            RawDependsOn::List(list) => list.clone(),
            RawDependsOn::Map(map) => map.keys().cloned().collect(),
        };

        let labels = match &raw_service.labels {
            RawLabels::None => BTreeMap::new(),
            RawLabels::List(list) => list
                .iter()
                .filter_map(|entry| {
                    let mut parts = entry.splitn(2, '=');
                    let k = parts.next()?.to_string();
                    let v = parts.next().unwrap_or("").to_string();
                    Some((k, v))
                })
                .collect(),
            RawLabels::Map(map) => map.clone(),
        };

        let mounts = raw_service
            .volumes
            .iter()
            .filter_map(|entry| parse_volume_entry(entry, &path_str, &mut diagnostics))
            .collect();

        services.push(ComposeService {
            name: service_name.clone(),
            image: raw_service.image.clone(),
            build,
            mounts,
            depends_on,
            labels,
        });
    }

    // Sort services deterministically.
    services.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(ComposeFile {
        path: path_str,
        project_dir,
        services,
        named_volumes,
        diagnostics,
    })
}

// ---------------------------------------------------------------------------
// Volume entry conversion
// ---------------------------------------------------------------------------

fn parse_volume_entry(
    entry: &RawVolumeEntry,
    source_file: &str,
    diagnostics: &mut Vec<ComposeDiagnostic>,
) -> Option<ComposeMountDeclaration> {
    match entry {
        RawVolumeEntry::Short(s) => parse_short_volume(s, source_file, diagnostics),
        RawVolumeEntry::Long(long) => parse_long_volume(long, source_file, diagnostics),
    }
}

/// Parse a short-form volume string: `[source:]target[:options]`.
///
/// Classification rules:
/// - No `:` → anonymous volume (target only)
/// - Source starts with `.` or `/` → bind mount
/// - Otherwise → named volume
fn parse_short_volume(
    s: &str,
    source_file: &str,
    diagnostics: &mut Vec<ComposeDiagnostic>,
) -> Option<ComposeMountDeclaration> {
    let parts: Vec<&str> = s.splitn(3, ':').collect();

    match parts.as_slice() {
        // Anonymous volume: just the target path
        [target] => Some(ComposeMountDeclaration::Anonymous(AnonymousVolume {
            target: (*target).to_string(),
            source_file: source_file.to_string(),
            source_line: None,
        })),

        [source, target] | [source, target, _] => {
            let read_only = parts.get(2).map(|m| m.contains("ro")).unwrap_or(false);
            let source = *source;
            let target = *target;

            if source.starts_with('.') || source.starts_with('/') {
                // Bind mount
                Some(ComposeMountDeclaration::Bind(BindMount {
                    source: source.to_string(),
                    resolved_source: None,
                    target: target.to_string(),
                    read_only,
                    source_file: source_file.to_string(),
                    source_line: None,
                }))
            } else {
                // Named volume
                Some(ComposeMountDeclaration::Volume(NamedVolume {
                    volume_name: source.to_string(),
                    target: target.to_string(),
                    read_only,
                    source_file: source_file.to_string(),
                    source_line: None,
                }))
            }
        }

        _ => {
            diagnostics.push(ComposeDiagnostic {
                severity: DiagnosticSeverity::Warning,
                code: "INVALID_VOLUME".to_string(),
                message: format!("Could not parse volume entry '{s}'"),
                file: Some(source_file.to_string()),
                line: None,
            });
            None
        }
    }
}

fn parse_long_volume(
    long: &RawLongVolume,
    source_file: &str,
    diagnostics: &mut Vec<ComposeDiagnostic>,
) -> Option<ComposeMountDeclaration> {
    match long.kind.as_str() {
        "bind" => {
            let source = match &long.source {
                Some(s) => s.clone(),
                None => {
                    diagnostics.push(ComposeDiagnostic {
                        severity: DiagnosticSeverity::Error,
                        code: "MISSING_BIND_SOURCE".to_string(),
                        message: "Bind mount is missing required 'source' field".to_string(),
                        file: Some(source_file.to_string()),
                        line: None,
                    });
                    return None;
                }
            };
            Some(ComposeMountDeclaration::Bind(BindMount {
                source,
                resolved_source: None,
                target: long.target.clone(),
                read_only: long.read_only,
                source_file: source_file.to_string(),
                source_line: None,
            }))
        }

        "volume" => {
            let volume_name = match &long.source {
                Some(s) => s.clone(),
                None => {
                    diagnostics.push(ComposeDiagnostic {
                        severity: DiagnosticSeverity::Warning,
                        code: "MISSING_VOLUME_NAME".to_string(),
                        message: "Named volume mount has no 'source'; treating as anonymous"
                            .to_string(),
                        file: Some(source_file.to_string()),
                        line: None,
                    });
                    return Some(ComposeMountDeclaration::Anonymous(AnonymousVolume {
                        target: long.target.clone(),
                        source_file: source_file.to_string(),
                        source_line: None,
                    }));
                }
            };
            Some(ComposeMountDeclaration::Volume(NamedVolume {
                volume_name,
                target: long.target.clone(),
                read_only: long.read_only,
                source_file: source_file.to_string(),
                source_line: None,
            }))
        }

        "tmpfs" => Some(ComposeMountDeclaration::Tmpfs(TmpfsMount {
            target: long.target.clone(),
            source_file: source_file.to_string(),
            source_line: None,
        })),

        other => {
            diagnostics.push(ComposeDiagnostic {
                severity: DiagnosticSeverity::Warning,
                code: "UNKNOWN_VOLUME_TYPE".to_string(),
                message: format!("Unknown volume type '{other}'"),
                file: Some(source_file.to_string()),
                line: None,
            });
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    /// Write `content` to a temp file and parse it.
    fn parse_str(content: &str) -> ComposeFile {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(content.as_bytes()).unwrap();
        parse_compose_file(f.path()).expect("parse should succeed")
    }

    #[test]
    fn test_parse_bind_mount_short_form() {
        let cf = parse_str(
            r#"
services:
  app:
    image: alpine
    volumes:
      - ./src:/app/src
"#,
        );
        let app = cf.services.iter().find(|s| s.name == "app").unwrap();
        assert_eq!(app.mounts.len(), 1);
        match &app.mounts[0] {
            ComposeMountDeclaration::Bind(b) => {
                assert_eq!(b.source, "./src");
                assert_eq!(b.target, "/app/src");
                assert!(!b.read_only);
            }
            other => panic!("expected Bind, got {other:?}"),
        }
    }

    #[test]
    fn test_parse_bind_mount_long_form() {
        let cf = parse_str(
            r#"
services:
  app:
    image: alpine
    volumes:
      - type: bind
        source: ./data
        target: /data
        read_only: true
"#,
        );
        let app = cf.services.iter().find(|s| s.name == "app").unwrap();
        match &app.mounts[0] {
            ComposeMountDeclaration::Bind(b) => {
                assert_eq!(b.source, "./data");
                assert_eq!(b.target, "/data");
                assert!(b.read_only);
            }
            other => panic!("expected Bind, got {other:?}"),
        }
    }

    #[test]
    fn test_parse_named_volume() {
        let cf = parse_str(
            r#"
services:
  app:
    image: alpine
    volumes:
      - type: volume
        source: my_vol
        target: /data
volumes:
  my_vol:
"#,
        );
        let app = cf.services.iter().find(|s| s.name == "app").unwrap();
        match &app.mounts[0] {
            ComposeMountDeclaration::Volume(v) => {
                assert_eq!(v.volume_name, "my_vol");
                assert_eq!(v.target, "/data");
            }
            other => panic!("expected Volume, got {other:?}"),
        }
        assert!(cf.named_volumes.contains(&"my_vol".to_string()));
    }

    #[test]
    fn test_parse_anonymous_volume() {
        let cf = parse_str(
            r#"
services:
  app:
    image: alpine
    volumes:
      - /app/tmp
"#,
        );
        let app = cf.services.iter().find(|s| s.name == "app").unwrap();
        match &app.mounts[0] {
            ComposeMountDeclaration::Anonymous(a) => {
                assert_eq!(a.target, "/app/tmp");
            }
            other => panic!("expected Anonymous, got {other:?}"),
        }
    }

    #[test]
    fn test_parse_tmpfs() {
        let cf = parse_str(
            r#"
services:
  app:
    image: alpine
    volumes:
      - type: tmpfs
        target: /tmp
"#,
        );
        let app = cf.services.iter().find(|s| s.name == "app").unwrap();
        match &app.mounts[0] {
            ComposeMountDeclaration::Tmpfs(t) => {
                assert_eq!(t.target, "/tmp");
            }
            other => panic!("expected Tmpfs, got {other:?}"),
        }
    }

    #[test]
    fn test_parse_depends_on_list() {
        let cf = parse_str(
            r#"
services:
  app:
    image: alpine
    depends_on:
      - db
      - redis
"#,
        );
        let app = cf.services.iter().find(|s| s.name == "app").unwrap();
        let mut deps = app.depends_on.clone();
        deps.sort();
        assert_eq!(deps, vec!["db", "redis"]);
    }

    #[test]
    fn test_parse_depends_on_condition_form() {
        let cf = parse_str(
            r#"
services:
  app:
    image: alpine
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started
"#,
        );
        let app = cf.services.iter().find(|s| s.name == "app").unwrap();
        let mut deps = app.depends_on.clone();
        deps.sort();
        assert_eq!(deps, vec!["db", "redis"]);
    }

    #[test]
    fn test_parse_full_fixture() {
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("tests/fixtures/compose/path-mapping.compose.yaml");

        let cf = parse_compose_file(&fixture_path).expect("fixture should parse");

        // Should have two services
        assert_eq!(cf.services.len(), 2, "expected 2 services");

        let api = cf.services.iter().find(|s| s.name == "api").unwrap();
        assert_eq!(api.image.as_deref(), Some("python:3.12-slim"));

        // api should have 4 mounts: 2 long bind, 1 long volume, 1 short bind
        assert_eq!(api.mounts.len(), 4, "api should have 4 mounts");

        // Check that at least one bind mount targets /workspace/src
        let has_src_bind = api.mounts.iter().any(|m| match m {
            ComposeMountDeclaration::Bind(b) => b.target == "/workspace/src",
            _ => false,
        });
        assert!(
            has_src_bind,
            "api should have a bind mount to /workspace/src"
        );

        // Check named volume mount
        let has_cache_volume = api.mounts.iter().any(|m| match m {
            ComposeMountDeclaration::Volume(v) => v.volume_name == "api-cache",
            _ => false,
        });
        assert!(has_cache_volume, "api should have api-cache volume mount");

        let worker = cf.services.iter().find(|s| s.name == "worker").unwrap();
        assert_eq!(worker.depends_on, vec!["api"]);

        // worker has: 1 short bind (../shared), 1 short named vol (logs), 1 long bind
        assert_eq!(worker.mounts.len(), 3, "worker should have 3 mounts");

        // Named volumes at top level
        assert!(cf.named_volumes.contains(&"api-cache".to_string()));
        assert!(cf.named_volumes.contains(&"logs".to_string()));
    }

    #[test]
    fn test_unknown_top_level_field_emits_warning() {
        let cf = parse_str(
            r#"
services:
  app:
    image: alpine
x_custom: some_value
"#,
        );
        let has_warning = cf.diagnostics.iter().any(|d| d.code == "UNKNOWN_FIELD");
        assert!(
            has_warning,
            "should emit UNKNOWN_FIELD warning for x_custom"
        );
    }
}
