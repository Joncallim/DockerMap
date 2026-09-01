use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

mod identity;
mod logs;
mod models;
mod snapshot_runtime;

pub use identity::collision_resistant_id_component;
pub use logs::{
    page_log_entries, parse_rfc3339_nano_millis, LogCursor, DEFAULT_LOG_PAGE_SIZE,
    MAX_LOG_PAGE_SIZE,
};
pub use models::*;
pub use snapshot_runtime::{derive_graph, derive_images, derive_runtime_map};

const MAX_COMPOSE_FILE_BYTES: u64 = 1_048_576;

pub fn service_entity_kind_name(kind: &ServiceEntityKind) -> &'static str {
    match kind {
        ServiceEntityKind::Service => "service",
        ServiceEntityKind::NodeApplication => "node_application",
        ServiceEntityKind::PythonApplication => "python_application",
        ServiceEntityKind::AiAgent => "ai_agent",
        ServiceEntityKind::Session => "session",
        ServiceEntityKind::Host => "host",
        ServiceEntityKind::Storage => "storage",
        ServiceEntityKind::ExternalApi => "external_api",
        ServiceEntityKind::DnsProvider => "dns_provider",
        ServiceEntityKind::ReverseProxy => "reverse_proxy",
        ServiceEntityKind::PackageDependency => "package_dependency",
    }
}

pub fn mock_snapshot() -> DockerSnapshot {
    DockerSnapshot {
        containers: vec![
            ContainerRecord {
                id: "container_gateway".into(),
                name: "gateway".into(),
                image: "nginx:1.27-alpine".into(),
                status: "running".into(),
                role: "edge proxy".into(),
                networks: vec!["network_edge".into(), "network_app".into()],
                ports: vec!["3233:80/tcp".into()],
                mounts: Vec::new(),
                depends_on: vec!["container_api".into()],
            },
            ContainerRecord {
                id: "container_api".into(),
                name: "api".into(),
                image: "python:3.11-slim".into(),
                status: "running".into(),
                role: "api".into(),
                networks: vec!["network_app".into(), "network_data".into()],
                ports: vec!["3233:3233/tcp".into()],
                mounts: vec![
                    ContainerMount {
                        id: "container_api:/workspace/src:/srv/dockermap/src".into(),
                        kind: ComposeMountKind::Bind,
                        source: Some("/srv/dockermap/src".into()),
                        target: "/workspace/src".into(),
                        read_only: false,
                    },
                    ContainerMount {
                        id: "container_api:/workspace/.cache:api-cache".into(),
                        kind: ComposeMountKind::NamedVolume,
                        source: Some("api-cache".into()),
                        target: "/workspace/.cache".into(),
                        read_only: false,
                    },
                ],
                depends_on: vec!["container_db".into(), "container_cache".into()],
            },
            ContainerRecord {
                id: "container_worker".into(),
                name: "worker".into(),
                image: "python:3.11-slim".into(),
                status: "running".into(),
                role: "worker".into(),
                networks: vec!["network_app".into(), "network_data".into()],
                ports: vec![],
                mounts: vec![ContainerMount {
                    id: "container_worker:/var/log/dockermap:logs".into(),
                    kind: ComposeMountKind::NamedVolume,
                    source: Some("logs".into()),
                    target: "/var/log/dockermap".into(),
                    read_only: false,
                }],
                depends_on: vec!["container_db".into(), "container_cache".into()],
            },
            ContainerRecord {
                id: "container_db".into(),
                name: "postgres".into(),
                image: "postgres:16-alpine".into(),
                status: "running".into(),
                role: "primary database".into(),
                networks: vec!["network_data".into()],
                ports: vec!["5432:5432/tcp".into()],
                mounts: vec![ContainerMount {
                    id: "container_db:/var/lib/postgresql/data:postgres_data".into(),
                    kind: ComposeMountKind::NamedVolume,
                    source: Some("postgres_data".into()),
                    target: "/var/lib/postgresql/data".into(),
                    read_only: false,
                }],
                depends_on: vec![],
            },
            ContainerRecord {
                id: "container_cache".into(),
                name: "redis".into(),
                image: "redis:7-alpine".into(),
                status: "running".into(),
                role: "cache and queue broker".into(),
                networks: vec!["network_data".into()],
                ports: vec!["6379:6379/tcp".into()],
                mounts: Vec::new(),
                depends_on: vec![],
            },
            ContainerRecord {
                id: "container_registry".into(),
                name: "registry".into(),
                image: "ghcr.io/dockermap/example:1.0".into(),
                status: "running".into(),
                role: "registry mirror".into(),
                networks: vec![],
                ports: vec![],
                mounts: Vec::new(),
                depends_on: vec![],
            },
        ],
        images: vec![
            ImageRecord {
                image: "nginx:1.27-alpine".into(),
                containers: vec!["gateway".into()],
                status: "running".into(),
            },
            ImageRecord {
                image: "python:3.11-slim".into(),
                containers: vec!["api".into(), "worker".into()],
                status: "running".into(),
            },
            ImageRecord {
                image: "postgres:16-alpine".into(),
                containers: vec!["postgres".into()],
                status: "running".into(),
            },
            ImageRecord {
                image: "redis:7-alpine".into(),
                containers: vec!["redis".into()],
                status: "running".into(),
            },
            ImageRecord {
                image: "ghcr.io/dockermap/example:1.0".into(),
                containers: vec!["registry".into()],
                status: "running".into(),
            },
        ],
        networks: vec![
            NetworkRecord {
                id: "network_edge".into(),
                name: "edge".into(),
                driver: "bridge".into(),
                internal: false,
                members: vec!["gateway".into()],
            },
            NetworkRecord {
                id: "network_app".into(),
                name: "application".into(),
                driver: "bridge".into(),
                internal: false,
                members: vec!["gateway".into(), "api".into(), "worker".into()],
            },
            NetworkRecord {
                id: "network_data".into(),
                name: "data".into(),
                driver: "bridge".into(),
                internal: true,
                members: vec![
                    "api".into(),
                    "worker".into(),
                    "postgres".into(),
                    "redis".into(),
                ],
            },
        ],
        volumes: vec![
            VolumeRecord {
                id: "volume_postgres_data".into(),
                name: "postgres_data".into(),
                attached_to: vec!["postgres".into()],
            },
            VolumeRecord {
                id: "volume_app_cache".into(),
                name: "app_cache".into(),
                attached_to: vec!["api".into(), "worker".into()],
            },
        ],
        last_updated: unix_timestamp_millis(),
        ..Default::default()
    }
}

pub fn unix_timestamp_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_millis() as u64
}

/// Base timestamp for mock log entries, captured ONCE per process.
///
/// A fresh `now` per request would shift the whole mock timeline by the
/// request-to-request delta: a compound cursor (`millis:offset`) produced
/// from page N would land between entries on page N+1, so the boundary
/// entry would be misclassified as already-emitted and skipped, and the
/// same-ms offset logic would never engage in mock mode. A process-wide
/// base keeps the timeline — and therefore cursor matching — stable across
/// requests.
static MOCK_LOG_BASE_MILLIS: std::sync::OnceLock<u64> = std::sync::OnceLock::new();

fn mock_log_base_millis() -> u64 {
    *MOCK_LOG_BASE_MILLIS.get_or_init(unix_timestamp_millis)
}

pub fn mock_log_entries(snapshot: &DockerSnapshot, service: Option<&str>) -> Vec<LogEntry> {
    let mut entries = Vec::new();
    let now = mock_log_base_millis();

    for (index, container) in snapshot.containers.iter().enumerate() {
        if let Some(service_filter) = service {
            if container.name != service_filter {
                continue;
            }
        }

        let candidates = [
            (
                LogLevel::Info,
                format!("{} accepted traffic on {}", container.name, container.role),
            ),
            (
                LogLevel::Info,
                format!("{} attached to {}", container.name, container.image),
            ),
            (
                LogLevel::Warn,
                format!(
                    "{} waiting on dependencies {:?}",
                    container.name, container.depends_on
                ),
            ),
        ];

        for (offset, (level, message)) in candidates.into_iter().enumerate() {
            entries.push(LogEntry {
                id: format!("{}-{}", container.id, offset),
                timestamp: now.saturating_sub(((index * 3 + offset) as u64) * 15_000),
                container: container.name.clone(),
                level,
                message,
            });
        }
    }

    entries
}

pub fn mock_logs(
    snapshot: &DockerSnapshot,
    service: Option<&str>,
    query: Option<&str>,
    cursor: Option<LogCursor>,
    limit: usize,
) -> LogsResponse {
    // Keep the raw mock generator reusable for publication layers that must
    // sanitize messages before query filtering and cursor pagination.
    let entries = mock_log_entries(snapshot, service);

    // Query filtering, sorting, and compound-cursor paging all live in the
    // shared helper so this mock agrees with the live-Docker daemon path and
    // the Node API mock on page boundaries.
    let (entries, next_cursor) = page_log_entries(entries, query, cursor, limit);

    LogsResponse {
        service: service.map(str::to_string),
        entries,
        next_cursor,
        ..Default::default()
    }
}

pub fn discover_compose_files(project_root: impl AsRef<Path>) -> Vec<PathBuf> {
    let root = project_root.as_ref();
    let base_files = [
        "compose.yaml",
        "compose.yml",
        "docker-compose.yaml",
        "docker-compose.yml",
    ]
    .into_iter()
    .map(|name| root.join(name))
    .filter(|path| path.is_file())
    .collect::<Vec<_>>();

    let mut files = Vec::new();
    for base_file in base_files {
        let overrides = compose_override_candidates(&base_file);
        files.push(base_file);
        files.extend(overrides.into_iter().filter(|path| path.is_file()));
    }
    files
}

pub fn scan_compose_files(
    project_root: impl AsRef<Path>,
    files: &[PathBuf],
) -> Result<ComposeScan, String> {
    let project_root = project_root.as_ref();
    let mut scan = ComposeScan {
        files: files
            .iter()
            .map(|path| display_path(path))
            .collect::<Vec<_>>(),
        project_root: display_path(project_root),
        services: Vec::new(),
        mounts: Vec::new(),
        correlations: Vec::new(),
        diagnostics: Vec::new(),
    };

    if files.is_empty() {
        scan.diagnostics.push(ComposeDiagnostic {
            id: "compose_no_files".into(),
            severity: DiagnosticSeverity::Warning,
            message: "No Compose files were discovered or supplied.".into(),
            origin: ComposeFileOrigin {
                file: display_path(project_root),
                service: None,
                field: "files".into(),
            },
        });
        return Ok(scan);
    }

    for file in files {
        let metadata = fs::metadata(file)
            .map_err(|error| format!("failed to inspect {}: {error}", file.display()))?;
        if metadata.len() > MAX_COMPOSE_FILE_BYTES {
            return Err(format!(
                "compose file `{}` is too large; limit is {MAX_COMPOSE_FILE_BYTES} bytes",
                file.display()
            ));
        }
        let content = fs::read_to_string(file)
            .map_err(|error| format!("failed to read {}: {error}", file.display()))?;
        parse_compose_file(file, &content, &mut scan);
    }

    coalesce_compose_services(&mut scan);
    validate_compose_scan(&mut scan);
    Ok(scan)
}

pub fn correlate_compose_runtime(
    scan: &ComposeScan,
    snapshot: &DockerSnapshot,
) -> Vec<MountCorrelation> {
    let mut correlations = Vec::new();
    let mut matched_runtime_mounts = BTreeSet::new();

    for mount in &scan.mounts {
        let containers = snapshot
            .containers
            .iter()
            .filter(|container| container_matches_service(container, &mount.service))
            .collect::<Vec<_>>();

        let match_result = containers.iter().find_map(|container| {
            container
                .mounts
                .iter()
                .find(|runtime_mount| mounts_match(mount, runtime_mount))
                .map(|runtime_mount| (*container, runtime_mount))
        });

        if let Some((container, runtime_mount)) = match_result {
            matched_runtime_mounts.insert(runtime_mount.id.clone());
            correlations.push(MountCorrelation {
                id: format!("matched:{}", mount.id),
                service: mount.service.clone(),
                container: Some(container.name.clone()),
                compose_mount_id: Some(mount.id.clone()),
                kind: mount.kind.clone(),
                target: mount.target.clone(),
                declared_source: declared_mount_source(mount),
                runtime_source: runtime_mount.source.clone(),
                status: MountCorrelationStatus::Matched,
            });
        } else {
            correlations.push(MountCorrelation {
                id: format!("missing:{}", mount.id),
                service: mount.service.clone(),
                container: containers.first().map(|container| container.name.clone()),
                compose_mount_id: Some(mount.id.clone()),
                kind: mount.kind.clone(),
                target: mount.target.clone(),
                declared_source: declared_mount_source(mount),
                runtime_source: None,
                status: MountCorrelationStatus::Missing,
            });
        }
    }

    for service in &scan.services {
        for container in snapshot
            .containers
            .iter()
            .filter(|container| container_matches_service(container, &service.name))
        {
            for runtime_mount in &container.mounts {
                if matched_runtime_mounts.contains(&runtime_mount.id) {
                    continue;
                }
                correlations.push(MountCorrelation {
                    id: format!("extra:{}:{}", container.id, runtime_mount.id),
                    service: service.name.clone(),
                    container: Some(container.name.clone()),
                    compose_mount_id: None,
                    kind: runtime_mount.kind.clone(),
                    target: runtime_mount.target.clone(),
                    declared_source: None,
                    runtime_source: runtime_mount.source.clone(),
                    status: MountCorrelationStatus::Extra,
                });
            }
        }
    }

    correlations.sort_by(|left, right| left.id.cmp(&right.id));
    correlations
}

pub fn derive_compose_graph(scan: &ComposeScan) -> ComposeGraph {
    let mut nodes_by_id: BTreeMap<String, ComposeGraphNode> = BTreeMap::new();
    let mut edges = Vec::new();

    for service in &scan.services {
        let id = compose_service_node_id(&service.name);
        nodes_by_id.entry(id.clone()).or_insert(ComposeGraphNode {
            id,
            kind: ComposeNodeKind::Service,
            label: service.name.clone(),
        });
    }

    for mount in &scan.mounts {
        let service_id = compose_service_node_id(&mount.service);
        nodes_by_id
            .entry(service_id.clone())
            .or_insert(ComposeGraphNode {
                id: service_id.clone(),
                kind: ComposeNodeKind::Service,
                label: mount.service.clone(),
            });

        let target_id = format!(
            "compose_container_path_{}_{}",
            collision_resistant_id_component(&mount.service),
            collision_resistant_id_component(&mount.target)
        );
        nodes_by_id
            .entry(target_id.clone())
            .or_insert(ComposeGraphNode {
                id: target_id.clone(),
                kind: ComposeNodeKind::ContainerPath,
                label: format!("{}:{}", mount.service, mount.target),
            });
        edges.push(ComposeGraphEdge {
            source: service_id,
            target: target_id.clone(),
            relationship: ComposeRelationshipKind::DeclaresMount,
        });

        let source_node = match mount.kind {
            ComposeMountKind::Bind => mount
                .resolved_source
                .as_ref()
                .or(mount.source.as_ref())
                .map(|source| {
                    let id = format!(
                        "compose_host_path_{}",
                        collision_resistant_id_component(source)
                    );
                    (id, ComposeNodeKind::HostPath, source.clone())
                }),
            ComposeMountKind::NamedVolume => mount.source.as_ref().map(|source| {
                let id = format!(
                    "compose_named_volume_{}",
                    collision_resistant_id_component(source)
                );
                (id, ComposeNodeKind::NamedVolume, source.clone())
            }),
            ComposeMountKind::AnonymousVolume => Some((
                format!(
                    "compose_anonymous_volume_{}",
                    collision_resistant_id_component(&mount.id)
                ),
                ComposeNodeKind::AnonymousVolume,
                "anonymous volume".into(),
            )),
            ComposeMountKind::Unsupported => None,
        };

        if let Some((source_id, kind, label)) = source_node {
            nodes_by_id
                .entry(source_id.clone())
                .or_insert(ComposeGraphNode {
                    id: source_id.clone(),
                    kind,
                    label,
                });
            edges.push(ComposeGraphEdge {
                source: source_id,
                target: target_id,
                relationship: ComposeRelationshipKind::MountedAt,
            });
        }
    }

    ComposeGraph {
        nodes: nodes_by_id.into_values().collect(),
        edges,
    }
}

pub fn plan_compose_mount_edit(
    file: &Path,
    content: &str,
    mount: &ComposeMount,
    new_source: Option<&str>,
    new_target: Option<&str>,
) -> ComposeEditPlan {
    let mut diagnostics = Vec::new();
    let clean_source = new_source.map(str::trim).filter(|value| !value.is_empty());
    let clean_target = new_target.map(str::trim).filter(|value| !value.is_empty());

    if clean_source.is_none() && clean_target.is_none() {
        diagnostics.push(ComposeDiagnostic {
            id: "edit_noop".into(),
            severity: DiagnosticSeverity::Error,
            message: "Edit plan requires a new source, target, or both.".into(),
            origin: mount.origin.clone(),
        });
    }

    if clean_source.is_some() && !matches!(mount.kind, ComposeMountKind::Bind) {
        diagnostics.push(ComposeDiagnostic {
            id: "edit_source_requires_bind".into(),
            severity: DiagnosticSeverity::Blocked,
            message: "Only bind mount sources can be changed by this dry-run planner.".into(),
            origin: mount.origin.clone(),
        });
    }

    if let Some(target) = clean_target {
        if target.contains('\0') || !looks_like_container_path(target) {
            diagnostics.push(ComposeDiagnostic {
                id: "edit_invalid_target".into(),
                severity: DiagnosticSeverity::Blocked,
                message: "New mount target must be an absolute container path.".into(),
                origin: mount.origin.clone(),
            });
        }
    }

    if let Some(source) = clean_source {
        if source.contains('\0') {
            diagnostics.push(ComposeDiagnostic {
                id: "edit_invalid_source".into(),
                severity: DiagnosticSeverity::Blocked,
                message: "New mount source contains a NUL byte.".into(),
                origin: mount.origin.clone(),
            });
        }
    }

    let mut planned = content.to_string();
    if diagnostics
        .iter()
        .any(|diagnostic| matches!(diagnostic.severity, DiagnosticSeverity::Blocked))
    {
        return edit_plan(
            file,
            mount,
            clean_source,
            clean_target,
            String::new(),
            diagnostics,
        );
    }

    if let Some(source) = clean_source {
        if has_parent_traversal(Path::new(source)) {
            diagnostics.push(ComposeDiagnostic {
                id: "edit_source_parent_traversal".into(),
                severity: DiagnosticSeverity::Blocked,
                message: "New mount source must not contain parent traversal.".into(),
                origin: mount.origin.clone(),
            });
        }

        if let Some(original) = &mount.source {
            planned = replace_mount_line_token(
                &planned,
                mount,
                original,
                source,
                "edit_original_source_not_found",
                "Original mount source could not be uniquely found on the mount declaration line.",
                &mut diagnostics,
            );
        } else {
            diagnostics.push(ComposeDiagnostic {
                id: "edit_missing_original_source".into(),
                severity: DiagnosticSeverity::Blocked,
                message: "Mount has no original source to replace.".into(),
                origin: mount.origin.clone(),
            });
        }
    }

    if let Some(target) = clean_target {
        planned = replace_mount_line_token(
            &planned,
            mount,
            &mount.target,
            target,
            "edit_original_target_not_found",
            "Original mount target could not be uniquely found on the mount declaration line.",
            &mut diagnostics,
        );
    }

    let diff = if diagnostics
        .iter()
        .any(|diagnostic| matches!(diagnostic.severity, DiagnosticSeverity::Blocked))
        || planned == content
    {
        String::new()
    } else {
        unified_diff(&display_path(file), content, &planned)
    };

    edit_plan(file, mount, clean_source, clean_target, diff, diagnostics)
}

fn replace_mount_line_token(
    content: &str,
    mount: &ComposeMount,
    old: &str,
    new: &str,
    diagnostic_id: &str,
    diagnostic_message: &str,
    diagnostics: &mut Vec<ComposeDiagnostic>,
) -> String {
    let lines = content.lines().collect::<Vec<_>>();
    let candidates = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.contains(old) && line.contains(&mount.target))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();

    if candidates.len() != 1 {
        diagnostics.push(ComposeDiagnostic {
            id: diagnostic_id.into(),
            severity: DiagnosticSeverity::Blocked,
            message: diagnostic_message.into(),
            origin: mount.origin.clone(),
        });
        return content.to_string();
    }

    let mut output = String::new();
    let had_trailing_newline = content.ends_with('\n');
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            output.push('\n');
        }
        if index == candidates[0] {
            output.push_str(&line.replacen(old, new, 1));
        } else {
            output.push_str(line);
        }
    }
    if had_trailing_newline {
        output.push('\n');
    }
    output
}

fn parse_compose_file(file: &Path, content: &str, scan: &mut ComposeScan) {
    let base_dir = file.parent().unwrap_or_else(|| Path::new("."));
    let document = match yaml_serde::from_str::<yaml_serde::Value>(content) {
        Ok(value) => value,
        Err(error) => {
            scan.diagnostics.push(ComposeDiagnostic {
                id: "compose_yaml_parse_error".into(),
                severity: DiagnosticSeverity::Blocked,
                message: format!("Compose YAML could not be parsed: {error}"),
                origin: origin(file, None, "document"),
            });
            return;
        }
    };

    let Some(services) = mapping_get(&document, "services").and_then(|value| value.as_mapping())
    else {
        scan.diagnostics.push(ComposeDiagnostic {
            id: "compose_missing_services".into(),
            severity: DiagnosticSeverity::Error,
            message: "Compose file does not contain a services mapping.".into(),
            origin: origin(file, None, "services"),
        });
        return;
    };

    for (service_key, service_value) in services {
        let Some(service_name) = service_key.as_str() else {
            scan.diagnostics.push(ComposeDiagnostic {
                id: "compose_non_string_service_name".into(),
                severity: DiagnosticSeverity::Error,
                message: "Service names must be strings.".into(),
                origin: origin(file, None, "services"),
            });
            continue;
        };

        let image = mapping_get(service_value, "image")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        let environment = parse_environment(mapping_get(service_value, "environment"));
        let depends_on = parse_depends_on(mapping_get(service_value, "depends_on"));
        scan.services.push(ComposeService {
            name: service_name.to_string(),
            image,
            environment,
            depends_on,
        });

        let Some(volumes) = mapping_get(service_value, "volumes") else {
            continue;
        };

        let Some(items) = volumes.as_sequence() else {
            scan.diagnostics.push(ComposeDiagnostic {
                id: "compose_invalid_volumes".into(),
                severity: DiagnosticSeverity::Error,
                message: "Service volumes must be a sequence.".into(),
                origin: origin(file, Some(service_name), "services.volumes"),
            });
            continue;
        };

        for (index, item) in items.iter().enumerate() {
            match parse_mount(file, base_dir, service_name, index, item) {
                Ok(mount) => scan.mounts.push(mount),
                Err(diagnostic) => scan.diagnostics.push(*diagnostic),
            }
        }
    }
}

fn parse_mount(
    file: &Path,
    base_dir: &Path,
    service_name: &str,
    index: usize,
    item: &yaml_serde::Value,
) -> Result<ComposeMount, Box<ComposeDiagnostic>> {
    let field = format!("services.{service_name}.volumes[{index}]");
    let mount_origin = origin(file, Some(service_name), &field);

    if let Some(short) = item.as_str() {
        return parse_short_mount(file, base_dir, service_name, index, short);
    }

    let Some(mapping) = item.as_mapping() else {
        return Err(Box::new(ComposeDiagnostic {
            id: "compose_unsupported_mount".into(),
            severity: DiagnosticSeverity::Error,
            message: "Volume entries must be strings or mappings.".into(),
            origin: mount_origin,
        }));
    };

    let mount_type = mapping
        .get(yaml_serde::Value::String("type".into()))
        .and_then(|value| value.as_str())
        .unwrap_or("volume");
    let source = mapping
        .get(yaml_serde::Value::String("source".into()))
        .or_else(|| mapping.get(yaml_serde::Value::String("src".into())))
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let Some(target) = mapping
        .get(yaml_serde::Value::String("target".into()))
        .or_else(|| mapping.get(yaml_serde::Value::String("dst".into())))
        .or_else(|| mapping.get(yaml_serde::Value::String("destination".into())))
        .and_then(|value| value.as_str())
    else {
        return Err(Box::new(ComposeDiagnostic {
            id: "compose_mount_missing_target".into(),
            severity: DiagnosticSeverity::Error,
            message: "Volume mapping is missing a target path.".into(),
            origin: mount_origin,
        }));
    };

    let read_only = mapping
        .get(yaml_serde::Value::String("read_only".into()))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let kind = match mount_type {
        "bind" => ComposeMountKind::Bind,
        "volume" if source.is_some() => ComposeMountKind::NamedVolume,
        "volume" => ComposeMountKind::AnonymousVolume,
        _ => ComposeMountKind::Unsupported,
    };
    let resolved_source = resolve_source(base_dir, &kind, source.as_deref());

    Ok(ComposeMount {
        id: format!("{}:{service_name}:{index}", display_path(file)),
        service: service_name.to_string(),
        kind,
        source,
        resolved_source,
        target: target.to_string(),
        read_only,
        origin: mount_origin,
    })
}

fn parse_short_mount(
    file: &Path,
    base_dir: &Path,
    service_name: &str,
    index: usize,
    raw: &str,
) -> Result<ComposeMount, Box<ComposeDiagnostic>> {
    let parts = split_short_volume(raw);
    let field = format!("services.{service_name}.volumes[{index}]");
    let mount_origin = origin(file, Some(service_name), &field);

    if parts.is_empty() || parts.len() > 3 {
        return Err(Box::new(ComposeDiagnostic {
            id: "compose_invalid_short_mount".into(),
            severity: DiagnosticSeverity::Error,
            message: "Short volume syntax must be target, source:target, or source:target:mode."
                .into(),
            origin: mount_origin,
        }));
    }

    let (source, target, mode) = match parts.as_slice() {
        [target] => (None, (*target).to_string(), None),
        [source, target] => (Some((*source).to_string()), (*target).to_string(), None),
        [source, target, mode] => (
            Some((*source).to_string()),
            (*target).to_string(),
            Some((*mode).to_string()),
        ),
        _ => unreachable!("parts length checked above"),
    };

    let read_only = mode
        .as_deref()
        .map(|value| {
            value
                .split(',')
                .any(|part| part == "ro" || part == "readonly")
        })
        .unwrap_or(false);
    let kind = classify_short_source(source.as_deref());
    let resolved_source = resolve_source(base_dir, &kind, source.as_deref());

    Ok(ComposeMount {
        id: format!("{}:{service_name}:{index}", display_path(file)),
        service: service_name.to_string(),
        kind,
        source,
        resolved_source,
        target,
        read_only,
        origin: mount_origin,
    })
}

fn coalesce_compose_services(scan: &mut ComposeScan) {
    let mut services_by_name: BTreeMap<String, ComposeService> = BTreeMap::new();

    for service in scan.services.drain(..) {
        services_by_name
            .entry(service.name.clone())
            .and_modify(|existing| {
                if service.image.is_some() {
                    existing.image = service.image.clone();
                }
                for (key, value) in &service.environment {
                    existing.environment.insert(key.clone(), value.clone());
                }
                for dependency in &service.depends_on {
                    if !existing.depends_on.contains(dependency) {
                        existing.depends_on.push(dependency.clone());
                    }
                }
            })
            .or_insert(service);
    }

    scan.services = services_by_name.into_values().collect();
}

fn validate_compose_scan(scan: &mut ComposeScan) {
    let mut targets_by_service: BTreeMap<(String, String), Vec<ComposeFileOrigin>> =
        BTreeMap::new();

    for mount in &scan.mounts {
        if mount.target.trim().is_empty() || !looks_like_container_path(&mount.target) {
            scan.diagnostics.push(ComposeDiagnostic {
                id: "compose_invalid_container_target".into(),
                severity: DiagnosticSeverity::Error,
                message: format!(
                    "Mount target `{}` is not an absolute container path.",
                    mount.target
                ),
                origin: mount.origin.clone(),
            });
        }

        targets_by_service
            .entry((mount.service.clone(), mount.target.clone()))
            .or_default()
            .push(mount.origin.clone());

        if matches!(mount.kind, ComposeMountKind::Unsupported) {
            scan.diagnostics.push(ComposeDiagnostic {
                id: "compose_unsupported_mount_type".into(),
                severity: DiagnosticSeverity::Warning,
                message: "Unsupported mount type was preserved but cannot be validated yet.".into(),
                origin: mount.origin.clone(),
            });
        }

        if let Some(source) = &mount.source {
            if source.contains("${") || source.contains('$') {
                scan.diagnostics.push(ComposeDiagnostic {
                    id: "compose_unresolved_variable".into(),
                    severity: DiagnosticSeverity::Warning,
                    message: format!("Mount source `{source}` contains an unresolved variable."),
                    origin: mount.origin.clone(),
                });
            }

            if source.contains('\0') {
                scan.diagnostics.push(ComposeDiagnostic {
                    id: "compose_invalid_source_path".into(),
                    severity: DiagnosticSeverity::Blocked,
                    message: "Mount source contains a NUL byte.".into(),
                    origin: mount.origin.clone(),
                });
            }
        }

        if matches!(mount.kind, ComposeMountKind::Bind) {
            if let Some(resolved) = &mount.resolved_source {
                if let Some((severity, message)) = unsafe_bind_source_diagnostic(resolved) {
                    scan.diagnostics.push(ComposeDiagnostic {
                        id: "compose_unsafe_bind_source".into(),
                        severity,
                        message,
                        origin: mount.origin.clone(),
                    });
                }

                let path = Path::new(resolved);
                if has_parent_traversal(path) {
                    scan.diagnostics.push(ComposeDiagnostic {
                        id: "compose_parent_traversal".into(),
                        severity: DiagnosticSeverity::Warning,
                        message: format!(
                            "Bind source `{resolved}` traverses outside its compose directory."
                        ),
                        origin: mount.origin.clone(),
                    });
                }

                match fs::symlink_metadata(path) {
                    Ok(metadata) if metadata.file_type().is_symlink() => {
                        scan.diagnostics.push(ComposeDiagnostic {
                            id: "compose_bind_source_symlink".into(),
                            severity: DiagnosticSeverity::Warning,
                            message: format!("Bind source `{resolved}` is a symlink; DockerMap will not follow it during validation."),
                            origin: mount.origin.clone(),
                        });
                    }
                    Ok(_) => {}
                    Err(_) => {
                        scan.diagnostics.push(ComposeDiagnostic {
                            id: "compose_missing_bind_source".into(),
                            severity: DiagnosticSeverity::Warning,
                            message: format!(
                                "Bind source `{resolved}` does not exist on the host."
                            ),
                            origin: mount.origin.clone(),
                        });
                    }
                }
            }
        }
    }

    for ((service, target), origins) in targets_by_service {
        if origins.len() > 1 {
            for origin in origins {
                scan.diagnostics.push(ComposeDiagnostic {
                    id: "compose_duplicate_target".into(),
                    severity: DiagnosticSeverity::Error,
                    message: format!(
                        "Service `{service}` declares multiple mounts for `{target}`."
                    ),
                    origin,
                });
            }
        }
    }
}

/// Host directories that should never be mounted into containers because they
/// expose system internals. Matched at path boundaries (`/etc` and `/etc/...`).
const SENSITIVE_SYSTEM_ROOTS: &[&str] = &[
    "/etc", "/proc", "/sys", "/dev", "/boot", "/usr", "/bin", "/sbin", "/lib", "/lib64",
    "/var/log", "/root",
];

/// Directory names anywhere in a bind source that indicate credential material.
const CREDENTIAL_DIR_NAMES: &[&str] = &[
    ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".netrc", "gcloud",
];

/// Classify a resolved bind source as unsafe to expose to containers.
/// Returns `(severity, message)` or `None` when the source looks safe.
fn unsafe_bind_source_diagnostic(resolved: &str) -> Option<(DiagnosticSeverity, String)> {
    let path = Path::new(resolved);

    let is_docker_socket = path
        .components()
        .any(|component| component.as_os_str() == "docker.sock");
    let is_docker_data = resolved == "/var/lib/docker" || resolved.starts_with("/var/lib/docker/");
    if is_docker_socket || is_docker_data {
        return Some((
            DiagnosticSeverity::Blocked,
            format!(
                "Bind source `{resolved}` exposes Docker daemon state; a compromised container could control the host daemon."
            ),
        ));
    }

    if path.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        CREDENTIAL_DIR_NAMES.iter().any(|needle| name == *needle)
    }) {
        return Some((
            DiagnosticSeverity::Blocked,
            format!("Bind source `{resolved}` exposes credential material to the container."),
        ));
    }

    if SENSITIVE_SYSTEM_ROOTS
        .iter()
        .any(|root| resolved == *root || resolved.starts_with(&format!("{root}/")))
    {
        return Some((
            DiagnosticSeverity::Warning,
            format!("Bind source `{resolved}` mounts a sensitive host path."),
        ));
    }

    None
}

fn mounts_match(compose_mount: &ComposeMount, runtime_mount: &ContainerMount) -> bool {
    compose_mount.kind == runtime_mount.kind
        && compose_mount.target == runtime_mount.target
        && match compose_mount.kind {
            ComposeMountKind::Bind | ComposeMountKind::NamedVolume => {
                declared_mount_source(compose_mount) == runtime_mount.source
            }
            ComposeMountKind::AnonymousVolume => true,
            ComposeMountKind::Unsupported => false,
        }
}

fn declared_mount_source(mount: &ComposeMount) -> Option<String> {
    match mount.kind {
        ComposeMountKind::Bind => mount
            .resolved_source
            .clone()
            .or_else(|| mount.source.clone()),
        ComposeMountKind::NamedVolume => mount.source.clone(),
        ComposeMountKind::AnonymousVolume | ComposeMountKind::Unsupported => mount.source.clone(),
    }
}

fn container_matches_service(container: &ContainerRecord, service: &str) -> bool {
    container.role == service
        || container.name == service
        || container.name.ends_with(&format!("_{service}_1"))
        || container.name.ends_with(&format!("-{service}-1"))
}

fn parse_depends_on(value: Option<&yaml_serde::Value>) -> Vec<String> {
    match value {
        Some(yaml_serde::Value::Sequence(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        Some(yaml_serde::Value::Mapping(mapping)) => mapping
            .keys()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

fn parse_environment(value: Option<&yaml_serde::Value>) -> BTreeMap<String, String> {
    match value {
        Some(yaml_serde::Value::Mapping(mapping)) => mapping
            .iter()
            .filter_map(|(key, value)| Some((key.as_str()?.to_string(), scalar_to_string(value)?)))
            .collect(),
        Some(yaml_serde::Value::Sequence(items)) => items
            .iter()
            .filter_map(|item| {
                let entry = item.as_str()?;
                let (key, value) = entry.split_once('=').unwrap_or((entry, ""));
                Some((key.to_string(), value.to_string()))
            })
            .collect(),
        _ => BTreeMap::new(),
    }
}

fn scalar_to_string(value: &yaml_serde::Value) -> Option<String> {
    match value {
        yaml_serde::Value::String(value) => Some(value.clone()),
        yaml_serde::Value::Bool(value) => Some(value.to_string()),
        yaml_serde::Value::Number(value) => Some(value.to_string()),
        yaml_serde::Value::Null => Some(String::new()),
        _ => None,
    }
}

fn split_short_volume(raw: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    for (index, ch) in raw.char_indices() {
        if ch != ':' {
            continue;
        }
        if index == 1 && raw.as_bytes().first().is_some_and(u8::is_ascii_alphabetic) {
            continue;
        }
        parts.push(&raw[start..index]);
        start = index + 1;
    }
    parts.push(&raw[start..]);
    parts
}

fn classify_short_source(source: Option<&str>) -> ComposeMountKind {
    match source {
        None => ComposeMountKind::AnonymousVolume,
        Some(value) if looks_like_host_path(value) => ComposeMountKind::Bind,
        Some(_) => ComposeMountKind::NamedVolume,
    }
}

fn resolve_source(
    base_dir: &Path,
    kind: &ComposeMountKind,
    source: Option<&str>,
) -> Option<String> {
    let source = source?;
    if !matches!(kind, ComposeMountKind::Bind) {
        return None;
    }

    let interpolated = interpolate_default(source);
    let interpolated = expand_tilde(&interpolated);
    let source_path = Path::new(&interpolated);
    let resolved = if source_path.is_absolute() || is_windows_absolute_path(&interpolated) {
        PathBuf::from(interpolated)
    } else {
        base_dir.join(interpolated)
    };
    Some(display_path(&normalize_lexical(&resolved)))
}

/// Docker Compose expands a leading `~` or `~/...` in a bind source to the
/// user's home directory. Without this, `~/data:/data` would resolve under the
/// project directory as `<project>/~/data`, so unsafe-bind and missing-source
/// checks would operate on the wrong path.
fn expand_tilde(value: &str) -> String {
    let home = match std::env::var("HOME") {
        Ok(home) if !home.is_empty() => home,
        _ => return value.to_string(),
    };

    if value == "~" {
        return home;
    }
    match value.strip_prefix("~/") {
        Some(rest) => format!("{home}/{rest}"),
        None => value.to_string(),
    }
}

fn interpolate_default(value: &str) -> String {
    let Some(start) = value.find("${") else {
        return value.to_string();
    };
    let Some(end_offset) = value[start + 2..].find('}') else {
        return value.to_string();
    };
    let end = start + 2 + end_offset;
    let expression = &value[start + 2..end];
    let default = expression
        .split_once(":-")
        .or_else(|| expression.split_once('-'))
        .map(|(_, default)| default);

    if let Some(default) = default {
        let mut output = String::new();
        output.push_str(&value[..start]);
        output.push_str(default);
        output.push_str(&value[end + 1..]);
        output
    } else {
        value.to_string()
    }
}

fn looks_like_host_path(value: &str) -> bool {
    value.starts_with('.')
        || value.starts_with('/')
        || value.starts_with('~')
        || value.starts_with('\\')
        || is_windows_absolute_path(value)
}

fn looks_like_container_path(value: &str) -> bool {
    value.starts_with('/') || is_windows_absolute_path(value)
}

fn is_windows_absolute_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn has_parent_traversal(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::ParentDir))
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn mapping_get<'a>(value: &'a yaml_serde::Value, key: &str) -> Option<&'a yaml_serde::Value> {
    value
        .as_mapping()?
        .get(yaml_serde::Value::String(key.to_string()))
}

fn origin(file: &Path, service: Option<&str>, field: &str) -> ComposeFileOrigin {
    ComposeFileOrigin {
        file: display_path(file),
        service: service.map(str::to_string),
        field: field.to_string(),
    }
}

fn compose_override_candidates(base: &Path) -> Vec<PathBuf> {
    let Some(file_name) = base.file_name().and_then(|value| value.to_str()) else {
        return Vec::new();
    };
    let Some(parent) = base.parent() else {
        return Vec::new();
    };

    let names = if file_name.starts_with("docker-compose") {
        [
            "docker-compose.override.yml",
            "docker-compose.override.yaml",
        ]
    } else {
        ["compose.override.yml", "compose.override.yaml"]
    };

    names.into_iter().map(|name| parent.join(name)).collect()
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn edit_plan(
    file: &Path,
    mount: &ComposeMount,
    new_source: Option<&str>,
    new_target: Option<&str>,
    unified_diff: String,
    diagnostics: Vec<ComposeDiagnostic>,
) -> ComposeEditPlan {
    ComposeEditPlan {
        file: display_path(file),
        service: mount.service.clone(),
        mount_id: mount.id.clone(),
        original_source: mount.source.clone(),
        original_target: mount.target.clone(),
        new_source: new_source.map(str::to_string),
        new_target: new_target.map(str::to_string),
        unified_diff,
        diagnostics,
        will_write: false,
    }
}

fn unified_diff(file: &str, original: &str, planned: &str) -> String {
    let mut output = format!("--- {file}\n+++ {file} (dry-run)\n");
    let original_lines = original.lines().collect::<Vec<_>>();
    let planned_lines = planned.lines().collect::<Vec<_>>();
    let max_len = original_lines.len().max(planned_lines.len());

    for index in 0..max_len {
        match (original_lines.get(index), planned_lines.get(index)) {
            (Some(left), Some(right)) if left == right => {
                output.push(' ');
                output.push_str(left);
                output.push('\n');
            }
            (Some(left), Some(right)) => {
                output.push('-');
                output.push_str(left);
                output.push('\n');
                output.push('+');
                output.push_str(right);
                output.push('\n');
            }
            (Some(left), None) => {
                output.push('-');
                output.push_str(left);
                output.push('\n');
            }
            (None, Some(right)) => {
                output.push('+');
                output.push_str(right);
                output.push('\n');
            }
            (None, None) => {}
        }
    }

    output
}

fn compose_service_node_id(service: &str) -> String {
    format!(
        "compose_service_{}",
        collision_resistant_id_component(service)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_fixture_path(parts: &[&str]) -> PathBuf {
        let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        for part in parts {
            path.push(part);
        }
        path
    }

    fn scan_content(file: &Path, project_root: &Path, content: &str) -> ComposeScan {
        let mut scan = ComposeScan {
            files: vec![display_path(file)],
            project_root: display_path(project_root),
            services: Vec::new(),
            mounts: Vec::new(),
            correlations: Vec::new(),
            diagnostics: Vec::new(),
        };
        parse_compose_file(file, content, &mut scan);
        coalesce_compose_services(&mut scan);
        validate_compose_scan(&mut scan);
        scan
    }

    fn scan_invalid_fixture(name: &str) -> ComposeScan {
        let root = repo_fixture_path(&["tests", "fixtures", "compose", "invalid"]);
        let file = root.join(name);
        scan_compose_files(&root, &[file]).expect("invalid fixture should scan with diagnostics")
    }

    #[test]
    fn mock_snapshot_has_expected_shape() {
        let snapshot = mock_snapshot();
        assert_eq!(snapshot.containers.len(), 6);
        assert_eq!(snapshot.networks.len(), 3);
        assert_eq!(snapshot.volumes.len(), 2);
        assert!(snapshot.last_updated > 0);
    }

    #[test]
    fn derives_images_from_containers() {
        let snapshot = mock_snapshot();
        let images = derive_images(&snapshot);
        let python = images
            .iter()
            .find(|image| image.image == "python:3.11-slim")
            .expect("python image should exist");
        assert_eq!(
            python.containers,
            vec!["api".to_string(), "worker".to_string()]
        );
    }

    #[test]
    fn derives_graph_with_nodes_and_edges() {
        let snapshot = mock_snapshot();
        let graph = derive_graph(&snapshot);
        // 6 containers + 3 networks + 2 volumes.
        assert_eq!(graph.nodes.len(), 11);
        assert!(graph.edges.iter().any(|edge| edge.target == "network_data"));
        assert!(graph
            .edges
            .iter()
            .any(|edge| edge.target == "volume_postgres_data"));
    }

    #[test]
    fn resolves_depends_on_by_role_when_names_differ() {
        // Real-world shape: compose depends_on refs name the compose SERVICE
        // (the daemon's `container_<service>` refs), while live container
        // names are project-prefixed and the service name is recorded as the
        // container's role (com.docker.compose.service label).
        let snapshot = DockerSnapshot {
            containers: vec![
                ContainerRecord {
                    id: "deadbeef_api".into(),
                    name: "immich_api".into(),
                    image: "immich-server:latest".into(),
                    status: "running".into(),
                    role: "api".into(),
                    networks: vec![],
                    ports: vec![],
                    mounts: vec![],
                    depends_on: vec!["container_redis".into(), "container_database".into()],
                },
                ContainerRecord {
                    id: "deadbeef_redis".into(),
                    name: "immich_redis".into(),
                    image: "redis:7-alpine".into(),
                    status: "running".into(),
                    role: "redis".into(),
                    networks: vec![],
                    ports: vec![],
                    mounts: vec![],
                    depends_on: vec![],
                },
                ContainerRecord {
                    id: "deadbeef_db".into(),
                    name: "immich_database".into(),
                    image: "postgres:16-alpine".into(),
                    status: "running".into(),
                    role: "database".into(),
                    networks: vec![],
                    ports: vec![],
                    mounts: vec![],
                    depends_on: vec![],
                },
            ],
            images: vec![],
            networks: vec![],
            volumes: vec![],
            last_updated: unix_timestamp_millis(),
            ..Default::default()
        };

        let graph = derive_graph(&snapshot);
        let api_dependencies = graph
            .edges
            .iter()
            .filter(|edge| edge.source == "deadbeef_api")
            .map(|edge| edge.target.as_str())
            .collect::<Vec<_>>();
        assert_eq!(api_dependencies.len(), 2);
        assert!(api_dependencies.contains(&"deadbeef_redis"));
        assert!(api_dependencies.contains(&"deadbeef_db"));
        assert!(
            !graph
                .edges
                .iter()
                .any(|edge| edge.target.starts_with("container_")),
            "unresolved depends_on refs must not leak into the graph"
        );
    }

    #[test]
    fn filters_mock_logs_by_service_and_query() {
        let snapshot = mock_snapshot();
        let logs = mock_logs(
            &snapshot,
            Some("api"),
            Some("python"),
            None,
            DEFAULT_LOG_PAGE_SIZE,
        );
        assert!(logs.entries.iter().all(|entry| entry.container == "api"));
        assert!(!logs.entries.is_empty());
    }

    #[test]
    fn paginates_mock_logs_with_cursor_and_limit() {
        let snapshot = mock_snapshot();
        let first = mock_logs(&snapshot, None, None, None, 2);
        assert_eq!(first.entries.len(), 2);
        let cursor = first.next_cursor.expect("a full first page has a cursor");

        let second = mock_logs(
            &snapshot,
            None,
            None,
            Some(LogCursor::parse(&cursor).expect("compound cursor")),
            2,
        );
        assert!(!second.entries.is_empty());
        assert!(
            second
                .entries
                .iter()
                .all(|entry| entry.timestamp < first.entries[0].timestamp),
            "second page must be strictly older than the first page"
        );
        assert!(
            second.entries.iter().all(|entry| first
                .entries
                .iter()
                .all(|first_entry| first_entry.id != entry.id)),
            "pages must not overlap"
        );
    }

    #[test]
    fn mock_logs_honors_cursor_without_service_filter() {
        // Regression: live-Docker mode with no service query used to hard-code
        // the cursor to None, so "Load older" re-returned page 1 forever. The
        // mock path must page older entries when given a cursor.
        let snapshot = mock_snapshot();
        let first = mock_logs(&snapshot, None, None, None, 3);
        assert_eq!(first.entries.len(), 3);
        let cursor = first.next_cursor.expect("a full first page has a cursor");

        let older = mock_logs(
            &snapshot,
            None,
            None,
            Some(LogCursor::parse(&cursor).expect("compound cursor")),
            3,
        );
        assert!(!older.entries.is_empty(), "older page must not be empty");
        assert!(
            older
                .entries
                .iter()
                .all(|entry| entry.timestamp < first.entries[0].timestamp),
            "older page must be strictly older than the first page"
        );
    }

    #[test]
    fn mock_log_timestamps_are_stable_across_requests() {
        // Regression (round 8, F3): mock entry timestamps used to derive
        // from a FRESH `now` per request, so a compound cursor from page N
        // never matched an entry on page N+1 — the boundary entry was
        // misclassified as already-emitted and skipped, and the same-ms
        // offset logic never engaged in mock mode. The base must be captured
        // once per process.
        let snapshot = mock_snapshot();
        let first = mock_logs(&snapshot, None, None, None, 2);
        let cursor = first
            .next_cursor
            .clone()
            .expect("a full first page has a cursor");

        // The same cursor must select the identical entries on every
        // subsequent request (the timeline must not drift between requests).
        let again = mock_logs(&snapshot, None, None, LogCursor::parse(&cursor), 2);
        let again_2 = mock_logs(&snapshot, None, None, LogCursor::parse(&cursor), 2);
        assert_eq!(
            again.entries, again_2.entries,
            "the same cursor must yield identical entries across requests"
        );

        // Paginating through the compound cursor must return strictly older
        // pages and cover every mock entry exactly once (no loss, no
        // overlap).
        let mut seen = first
            .entries
            .iter()
            .map(|entry| entry.id.clone())
            .collect::<std::collections::HashSet<_>>();
        let mut next = Some(cursor);
        let mut pages = 1usize;
        while let Some(current) = next {
            let page = mock_logs(&snapshot, None, None, LogCursor::parse(&current), 2);
            assert!(!page.entries.is_empty(), "cursor pagination must not stall");
            assert!(
                page.entries
                    .iter()
                    .all(|entry| entry.timestamp < first.entries[0].timestamp),
                "every cursor page must be strictly older than the first page"
            );
            for entry in &page.entries {
                assert!(seen.insert(entry.id.clone()), "pages must not overlap");
            }
            next = page.next_cursor;
            pages += 1;
            assert!(pages < 100, "cursor pagination must terminate");
        }

        let all = mock_logs(&snapshot, None, None, None, MAX_LOG_PAGE_SIZE);
        assert_eq!(
            seen.len(),
            all.entries.len(),
            "no mock entry may be lost across pages"
        );
    }

    #[test]
    fn paginates_same_timestamp_entries_with_compound_cursor() {
        // Regression (round 7, F3): entries sharing one millisecond used to
        // be silently dropped at page boundaries — a plain `ts` cursor could
        // never resume mid-run, so 5 entries at ts=1000 with limit=2 lost
        // three entries. The compound "ts:offset" cursor must page them all.
        let entries = (0..5)
            .map(|index| LogEntry {
                id: format!("svc-{index}"),
                timestamp: 1_000,
                container: "svc".into(),
                level: LogLevel::Info,
                message: format!("line {index}"),
            })
            .collect::<Vec<_>>();

        let (page1, cursor1) = page_log_entries(entries.clone(), None, None, 2);
        assert_eq!(page1.len(), 2);
        assert_eq!(
            cursor1.as_deref(),
            Some("1000:2"),
            "cursor encodes the boundary ms and the 2 entries already emitted at it"
        );

        let (page2, cursor2) = page_log_entries(
            entries.clone(),
            None,
            LogCursor::parse("1000:2").as_ref().copied(),
            2,
        );
        assert_eq!(page2.len(), 2);
        assert_eq!(
            cursor2.as_deref(),
            Some("1000:4"),
            "the second page resumes past the first 2 same-ms entries"
        );
        assert!(
            page2
                .iter()
                .all(|entry| page1.iter().all(|first| first.id != entry.id)),
            "pages must not overlap"
        );

        let (page3, cursor3) = page_log_entries(
            entries.clone(),
            None,
            LogCursor::parse("1000:4").as_ref().copied(),
            2,
        );
        assert_eq!(page3.len(), 1, "the last same-ms entry is still delivered");
        assert_eq!(page3[0].id, "svc-4");
        assert_eq!(cursor3, None, "the last page has no cursor");

        // A plain "ts" cursor (backward compatible) still pages older entries.
        let (page_plain, _) = page_log_entries(
            entries.clone(),
            None,
            LogCursor::parse("999").as_ref().copied(),
            2,
        );
        assert!(page_plain.is_empty(), "nothing is older than 999 here");
        assert_eq!(
            LogCursor::parse("1000"),
            Some(LogCursor {
                millis: 1_000,
                offset: 0
            })
        );
        assert_eq!(
            LogCursor::parse("1000:7"),
            Some(LogCursor {
                millis: 1_000,
                offset: 7
            })
        );
        assert_eq!(LogCursor::parse("not-a-cursor"), None);
    }

    #[test]
    fn parses_rfc3339_nano_timestamps() {
        assert_eq!(parse_rfc3339_nano_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_rfc3339_nano_millis("2026-08-20T04:05:06Z"),
            Some(1_787_198_706_000)
        );
        assert_eq!(
            parse_rfc3339_nano_millis("2026-08-20T04:05:06.123456789Z"),
            Some(1_787_198_706_123)
        );
        assert_eq!(
            parse_rfc3339_nano_millis("2026-08-20T04:05:06.5Z"),
            Some(1_787_198_706_500)
        );
        assert_eq!(parse_rfc3339_nano_millis("not-a-timestamp"), None);
        assert_eq!(parse_rfc3339_nano_millis("2026-08-20T04:05:06+02:00"), None);
        assert_eq!(parse_rfc3339_nano_millis("2026-13-20T04:05:06Z"), None);
        assert_eq!(parse_rfc3339_nano_millis("2026-08-20T24:05:06Z"), None);
        assert_eq!(parse_rfc3339_nano_millis("2026-08-20T04:05:06.Z"), None);
    }

    #[test]
    fn derives_runtime_map_from_docker_snapshot() {
        let snapshot = mock_snapshot();
        let runtime_map = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new());

        assert!(runtime_map
            .nodes
            .iter()
            .any(|node| node.provider == RuntimeProviderKind::Docker
                && node.kind == RuntimeNodeKind::Container
                && node.label == "api"));
        assert!(runtime_map
            .nodes
            .iter()
            .any(|node| node.kind == RuntimeNodeKind::DockerNetwork));
        assert!(runtime_map
            .edges
            .iter()
            .any(|edge| edge.relationship == RuntimeRelationshipKind::ConnectedTo));
    }

    #[test]
    fn collision_resistant_topology_ids_preserve_distinct_raw_identities() {
        // Every raw identity below used to collide after lowercasing and
        // punctuation/control replacement. Docker inventory, Compose services,
        // bind paths, and package-shaped identifiers must remain distinct.
        let identities = [
            "sol-r4-a-b",
            "sol-r4-a_b",
            "SOL-R4-A",
            "sol-r4-a",
            "bidi\u{202e}value",
            "bidi\u{202d}value",
            "/srv/sol-r4-a-b",
            "/srv/sol-r4-a_b",
            "@scope/sol-r4-a-b",
            "@scope_sol-r4-a-b",
        ];

        let mut snapshot = mock_snapshot();
        snapshot.volumes = identities
            .iter()
            .map(|identity| VolumeRecord {
                id: (*identity).into(),
                name: (*identity).into(),
                attached_to: Vec::new(),
            })
            .collect();
        let runtime_map = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new());
        let volume_ids = runtime_map
            .nodes
            .iter()
            .filter(|node| node.kind == RuntimeNodeKind::DockerVolume)
            .map(|node| node.id.as_str())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            volume_ids.len(),
            identities.len(),
            "distinct Docker volume identities must not merge"
        );

        let scan = ComposeScan {
            files: Vec::new(),
            project_root: "/project".into(),
            services: identities
                .iter()
                .map(|identity| ComposeService {
                    name: (*identity).into(),
                    image: None,
                    environment: BTreeMap::new(),
                    depends_on: Vec::new(),
                })
                .collect(),
            mounts: identities
                .iter()
                .enumerate()
                .map(|(index, identity)| ComposeMount {
                    id: format!("mount-{index}"),
                    service: (*identity).into(),
                    kind: ComposeMountKind::Bind,
                    source: Some((*identity).into()),
                    resolved_source: Some((*identity).into()),
                    target: format!("/target/{index}"),
                    read_only: false,
                    origin: ComposeFileOrigin {
                        file: "/project/compose.yaml".into(),
                        service: Some((*identity).into()),
                        field: format!("services.{index}.volumes"),
                    },
                })
                .collect(),
            correlations: Vec::new(),
            diagnostics: Vec::new(),
        };
        let graph = derive_compose_graph(&scan);
        let service_nodes = graph
            .nodes
            .iter()
            .filter(|node| node.kind == ComposeNodeKind::Service)
            .collect::<Vec<_>>();
        let host_path_nodes = graph
            .nodes
            .iter()
            .filter(|node| node.kind == ComposeNodeKind::HostPath)
            .collect::<Vec<_>>();
        assert_eq!(service_nodes.len(), identities.len());
        assert_eq!(host_path_nodes.len(), identities.len());
        assert_eq!(
            service_nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<BTreeSet<_>>()
                .len(),
            identities.len()
        );
        assert_eq!(
            host_path_nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<BTreeSet<_>>()
                .len(),
            identities.len()
        );
    }

    #[test]
    fn container_listener_ids_include_the_container_identity() {
        let mut snapshot = mock_snapshot();
        snapshot.containers = snapshot.containers[..2].to_vec();
        for (container, (id, name)) in snapshot
            .containers
            .iter_mut()
            .zip([("container_one", "one"), ("container_two", "two")])
        {
            container.id = id.into();
            container.name = name.into();
            container.ports = vec!["8080/tcp".into()];
        }
        snapshot.networks.clear();
        snapshot.volumes.clear();

        let runtime_map = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new());
        let listeners = runtime_map
            .nodes
            .iter()
            .filter(|node| node.kind == RuntimeNodeKind::NetworkListener)
            .collect::<Vec<_>>();

        assert_eq!(
            listeners.len(),
            2,
            "each container port is a distinct runtime entity"
        );
        assert_eq!(
            listeners
                .iter()
                .map(|node| node.id.as_str())
                .collect::<BTreeSet<_>>()
                .len(),
            2,
            "equivalent port text must not collapse listeners belonging to distinct containers"
        );
        assert!(runtime_map.diagnostics.iter().all(|diagnostic| {
            !diagnostic
                .message
                .contains("Duplicate generated runtime topology ID")
        }));
    }

    #[test]
    fn equivalent_reordered_snapshots_produce_the_same_runtime_topology() {
        let first = mock_snapshot();
        let mut reordered = first.clone();
        reordered.containers.reverse();
        reordered.networks.reverse();
        reordered.volumes.reverse();

        let first_map = derive_runtime_map(&first, Vec::new(), Vec::new(), Vec::new());
        let reordered_map = derive_runtime_map(&reordered, Vec::new(), Vec::new(), Vec::new());

        assert_eq!(reordered_map.nodes, first_map.nodes);
        assert_eq!(reordered_map.edges, first_map.edges);
        assert_eq!(reordered_map.diagnostics, first_map.diagnostics);
    }

    #[test]
    fn malformed_duplicate_runtime_ids_remain_visible_and_diagnostic() {
        let mut snapshot = mock_snapshot();
        snapshot.volumes = vec![
            VolumeRecord {
                id: "duplicate-volume".into(),
                name: "first".into(),
                attached_to: Vec::new(),
            },
            VolumeRecord {
                id: "duplicate-volume".into(),
                name: "second".into(),
                attached_to: Vec::new(),
            },
        ];

        let runtime_map = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new());
        let duplicated = runtime_map
            .nodes
            .iter()
            .filter(|node| node.kind == RuntimeNodeKind::DockerVolume)
            .collect::<Vec<_>>();

        assert_eq!(
            duplicated.len(),
            2,
            "malformed records must remain visible instead of being discarded"
        );
        assert!(runtime_map.diagnostics.iter().any(|diagnostic| {
            diagnostic
                .message
                .contains("remain visible and non-routable")
        }));
    }

    #[test]
    fn daemon_emitted_runtime_map_round_trips_through_json() {
        // Round-trip the REAL daemon derivation path (mock snapshot → map →
        // JSON → Rust) instead of a hand-written fixture, so the contract test
        // validates output collectors actually produce.
        let snapshot = mock_snapshot();
        let runtime_map = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new());

        let serialized = serde_json::to_string(&runtime_map).expect("map should serialize");
        let deserialized: RuntimeMap =
            serde_json::from_str(&serialized).expect("map JSON should deserialize");
        assert_eq!(
            deserialized, runtime_map,
            "JSON round-trip must be lossless"
        );

        assert!(
            !serialized.contains("\"status\":\"unknown\""),
            "mock containers serialize their real status"
        );

        let container = deserialized
            .nodes
            .iter()
            .find(|node| node.kind == RuntimeNodeKind::Container)
            .expect("mock snapshot yields container nodes");
        assert_eq!(container.layer, Some(RuntimeNodeLayer::Container));
        let service = container
            .service
            .as_ref()
            .expect("container nodes carry a service entity");
        assert_eq!(service.status, RuntimeServiceStatus::Running);
        assert_eq!(service.name, container.label);
    }

    #[test]
    fn contract_fixtures_deserialize_into_rust_types() {
        let snapshot: DockerSnapshot = read_contract_fixture("mock-snapshot.json");
        let compose_scan: ComposeScan = read_contract_fixture("compose-scan.json");
        let compose_graph: ComposeGraph = read_contract_fixture("compose-graph.json");
        let runtime_map: RuntimeMap = read_contract_fixture("runtime-map.json");
        let expanded_runtime_map: RuntimeMap = read_contract_fixture("runtime-map-expanded.json");

        assert_eq!(
            snapshot.containers[0].mounts[0].kind,
            ComposeMountKind::Bind
        );
        assert_eq!(
            compose_scan.correlations[0].status,
            MountCorrelationStatus::Matched
        );
        assert_eq!(
            compose_graph.edges[0].relationship,
            ComposeRelationshipKind::DeclaresMount
        );
        assert_eq!(runtime_map.nodes[0].provider, RuntimeProviderKind::Docker);
        assert!(expanded_runtime_map
            .nodes
            .iter()
            .any(|node| node.provider == RuntimeProviderKind::Cloudflare));
        assert!(expanded_runtime_map
            .edges
            .iter()
            .any(|edge| edge.relationship == RuntimeRelationshipKind::Wants));
    }

    #[test]
    fn scans_compose_fixture_mounts_and_diagnostics() {
        let root = repo_fixture_path(&["tests", "fixtures", "compose"]);
        let file = root.join("path-mapping.compose.yaml");
        let scan = scan_compose_files(&root, &[file]).expect("fixture should scan");

        assert_eq!(scan.services.len(), 2);
        assert_eq!(scan.mounts.len(), 7);
        assert!(scan.mounts.iter().any(|mount| {
            mount.service == "api"
                && mount.kind == ComposeMountKind::Bind
                && mount.target == "/workspace/src"
        }));
        assert!(scan.mounts.iter().any(|mount| {
            mount.service == "api"
                && mount.kind == ComposeMountKind::NamedVolume
                && mount.source.as_deref() == Some("api-cache")
        }));
        assert!(scan
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "compose_missing_bind_source"));
    }

    #[test]
    fn handles_windows_drive_short_volume_syntax() {
        let parts = split_short_volume(r"C:\Users\me\project:/workspace:ro");
        assert_eq!(parts, vec![r"C:\Users\me\project", "/workspace", "ro"]);
    }

    #[test]
    fn reports_duplicate_container_targets() {
        let root = PathBuf::from("/tmp/dockermap-test");
        let file = root.join("compose.yaml");
        let yaml = r#"
services:
  api:
    volumes:
      - ./a:/workspace
      - ./b:/workspace
"#;
        let scan = scan_content(&file, &root, yaml);

        assert_eq!(
            scan.diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.id == "compose_duplicate_target")
                .count(),
            2
        );
    }

    #[test]
    fn flags_unsafe_bind_sources() {
        let root = PathBuf::from("/tmp/dockermap-unsafe");
        let file = root.join("compose.yaml");
        let yaml = r#"
services:
  docker-cli:
    image: docker:cli
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /var/lib/docker:/var/lib/docker:ro
      - /etc:/host/etc:ro
      - /root/.ssh:/root/.ssh:ro
      - ./data:/workspace
      - /home/jon/project/data:/workspace2
"#;
        let scan = scan_content(&file, &root, yaml);

        let unsafe_diagnostics = scan
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.id == "compose_unsafe_bind_source")
            .collect::<Vec<_>>();

        assert_eq!(
            unsafe_diagnostics.len(),
            4,
            "docker.sock, docker data, /etc, and .ssh should be flagged: {unsafe_diagnostics:?}"
        );
        assert_eq!(
            unsafe_diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.severity == DiagnosticSeverity::Blocked)
                .count(),
            3
        );
        assert_eq!(
            unsafe_diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.severity == DiagnosticSeverity::Warning)
                .count(),
            1
        );
        let safe_paths_flagged = unsafe_diagnostics.iter().any(|diagnostic| {
            diagnostic.message.contains("./data")
                || diagnostic.message.contains("/home/jon/project/data")
        });
        assert!(
            !safe_paths_flagged,
            "project-local and user-project bind sources must not be flagged"
        );
    }

    #[test]
    fn tilde_bind_sources_resolve_under_home_and_flag_credentials() {
        let base_dir = Path::new("/project");
        let home = std::env::var("HOME").expect("HOME must be set for this test");

        let data = resolve_source(base_dir, &ComposeMountKind::Bind, Some("~/data"))
            .expect("~/data should resolve");
        assert_eq!(data, format!("{home}/data"));
        assert!(
            !data.contains("/project/"),
            "~/data must resolve under $HOME, not the project dir: {data}"
        );

        let ssh = resolve_source(base_dir, &ComposeMountKind::Bind, Some("~/.ssh"))
            .expect("~/.ssh should resolve");
        assert_eq!(ssh, format!("{home}/.ssh"));

        // The unsafe-bind check operates on the EXPANDED path, so `~/.ssh` is
        // flagged as credential material instead of being reported "missing".
        let (severity, message) = unsafe_bind_source_diagnostic(&ssh)
            .expect("~/.ssh must be flagged as credential material");
        assert_eq!(severity, DiagnosticSeverity::Blocked);
        assert!(message.contains("credential material"), "{message}");
    }

    #[test]
    fn malformed_compose_fixtures_emit_expected_diagnostics() {
        let cases = [
            (
                "duplicate-target.compose.yaml",
                "compose_duplicate_target",
                DiagnosticSeverity::Error,
            ),
            (
                "invalid-target.compose.yaml",
                "compose_invalid_container_target",
                DiagnosticSeverity::Error,
            ),
            (
                "invalid-volumes.compose.yaml",
                "compose_invalid_volumes",
                DiagnosticSeverity::Error,
            ),
            (
                "missing-services.compose.yaml",
                "compose_missing_services",
                DiagnosticSeverity::Error,
            ),
            (
                "missing-target.compose.yaml",
                "compose_mount_missing_target",
                DiagnosticSeverity::Error,
            ),
            (
                "unresolved-variable.compose.yaml",
                "compose_unresolved_variable",
                DiagnosticSeverity::Warning,
            ),
            (
                "unsupported-mount.compose.yaml",
                "compose_unsupported_mount_type",
                DiagnosticSeverity::Warning,
            ),
            (
                "unsafe-bind-source.compose.yaml",
                "compose_unsafe_bind_source",
                DiagnosticSeverity::Blocked,
            ),
            (
                "yaml-parse-error.compose.yaml",
                "compose_yaml_parse_error",
                DiagnosticSeverity::Blocked,
            ),
        ];

        for (fixture, expected_id, expected_severity) in cases {
            let scan = scan_invalid_fixture(fixture);
            assert!(
                scan.diagnostics.iter().any(|diagnostic| {
                    diagnostic.id == expected_id && diagnostic.severity == expected_severity
                }),
                "expected {expected_id}/{expected_severity:?} for {fixture}, got {:?}",
                scan.diagnostics
            );
        }

        let duplicate_scan = scan_invalid_fixture("duplicate-target.compose.yaml");
        assert_eq!(
            duplicate_scan
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.id == "compose_duplicate_target")
                .count(),
            2
        );
    }

    #[test]
    fn empty_compose_file_list_returns_warning_scan() {
        let root = PathBuf::from("/tmp/dockermap-empty-compose");
        let scan =
            scan_compose_files(&root, &[]).expect("empty file list should be diagnostic only");

        assert!(scan.services.is_empty());
        assert!(scan.mounts.is_empty());
        assert!(scan
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "compose_no_files"
                && diagnostic.severity == DiagnosticSeverity::Warning));
    }

    #[cfg(unix)]
    #[test]
    fn reports_symlink_bind_sources_without_following() {
        let root = tempfile::TempDir::new().expect("temp dir should be created");
        let real_dir = root.path().join("real-data");
        let linked_dir = root.path().join("linked-data");
        std::fs::create_dir_all(&real_dir).expect("real source should be created");
        std::os::unix::fs::symlink(&real_dir, &linked_dir)
            .expect("symlink source should be created");
        let file = root.path().join("compose.yaml");
        std::fs::write(
            &file,
            r#"
services:
  api:
    image: alpine
    volumes:
      - ./linked-data:/workspace/data
"#,
        )
        .expect("compose fixture should be written");

        let scan =
            scan_compose_files(root.path(), std::slice::from_ref(&file)).expect("scan should pass");

        assert!(scan
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "compose_bind_source_symlink"
                && diagnostic.severity == DiagnosticSeverity::Warning));
    }

    #[test]
    fn rejects_oversized_compose_file_before_parsing() {
        let root = std::env::temp_dir().join(format!(
            "dockermap-oversized-compose-{}",
            unix_timestamp_millis()
        ));
        std::fs::create_dir_all(&root).expect("temp dir should be created");
        let file = root.join("compose.yaml");
        std::fs::write(&file, vec![b'a'; (MAX_COMPOSE_FILE_BYTES + 1) as usize])
            .expect("oversized fixture should be written");

        let error = scan_compose_files(&root, std::slice::from_ref(&file))
            .expect_err("oversized file should be rejected");
        assert!(error.contains("too large"));

        let _ = std::fs::remove_file(file);
        let _ = std::fs::remove_dir(root);
    }

    #[test]
    fn derives_compose_graph_from_scan() {
        let root = repo_fixture_path(&["tests", "fixtures", "compose"]);
        let file = root.join("path-mapping.compose.yaml");
        let scan = scan_compose_files(&root, &[file]).expect("fixture should scan");
        let graph = derive_compose_graph(&scan);

        assert!(graph
            .nodes
            .iter()
            .any(|node| node.kind == ComposeNodeKind::Service && node.label == "api"));
        assert!(graph
            .nodes
            .iter()
            .any(|node| node.kind == ComposeNodeKind::HostPath));
        assert!(graph
            .nodes
            .iter()
            .any(|node| node.kind == ComposeNodeKind::NamedVolume));
        assert!(graph
            .edges
            .iter()
            .any(|edge| edge.relationship == ComposeRelationshipKind::MountedAt));
    }

    #[test]
    fn coalesces_compose_override_services() {
        let root = repo_fixture_path(&["tests", "fixtures", "compose"]);
        let base = root.join("path-mapping.compose.yaml");
        let override_file = root.join("override.compose.yaml");
        let scan = scan_compose_files(&root, &[base, override_file]).expect("fixtures should scan");

        assert_eq!(scan.services.len(), 2);
        let api = scan
            .services
            .iter()
            .find(|service| service.name == "api")
            .expect("api service should exist once");
        assert_eq!(api.image.as_deref(), Some("python:3.12-slim"));
        assert!(scan.mounts.iter().any(|mount| {
            mount.service == "api"
                && mount.target == "/workspace/config"
                && mount.read_only
                && mount.origin.file.ends_with("override.compose.yaml")
        }));
        let worker = scan
            .services
            .iter()
            .find(|service| service.name == "worker")
            .expect("worker service should exist once");
        assert_eq!(
            worker.environment.get("WORKER_MODE").map(String::as_str),
            Some("fixture")
        );
    }

    #[test]
    fn correlates_compose_mounts_with_runtime_mounts() {
        let root = tempfile::TempDir::new().expect("temp dir should be created");
        let source_dir = root.path().join("src");
        std::fs::create_dir_all(&source_dir).expect("source dir should be created");
        let file = root.path().join("compose.yaml");
        std::fs::write(
            &file,
            r#"
services:
  api:
    image: alpine
    volumes:
      - ./src:/app/src
"#,
        )
        .expect("compose fixture should be written");

        let scan =
            scan_compose_files(root.path(), std::slice::from_ref(&file)).expect("scan should pass");
        let snapshot = DockerSnapshot {
            containers: vec![ContainerRecord {
                id: "runtime-api".into(),
                name: "api".into(),
                image: "alpine".into(),
                status: "running".into(),
                role: "api".into(),
                networks: Vec::new(),
                ports: Vec::new(),
                mounts: vec![
                    ContainerMount {
                        id: "runtime-api:/app/src".into(),
                        kind: ComposeMountKind::Bind,
                        source: Some(display_path(&source_dir)),
                        target: "/app/src".into(),
                        read_only: false,
                    },
                    ContainerMount {
                        id: "runtime-api:/tmp/cache".into(),
                        kind: ComposeMountKind::AnonymousVolume,
                        source: None,
                        target: "/tmp/cache".into(),
                        read_only: false,
                    },
                ],
                depends_on: Vec::new(),
            }],
            images: Vec::new(),
            networks: Vec::new(),
            volumes: Vec::new(),
            last_updated: 1,
            ..Default::default()
        };

        let correlations = correlate_compose_runtime(&scan, &snapshot);
        assert!(correlations.iter().any(
            |item| item.status == MountCorrelationStatus::Matched && item.target == "/app/src"
        ));
        assert!(correlations.iter().any(
            |item| item.status == MountCorrelationStatus::Extra && item.target == "/tmp/cache"
        ));
    }

    #[test]
    fn plans_bind_mount_edit_without_writing() {
        let file = PathBuf::from("/tmp/compose.yaml");
        let content = r#"
services:
  api:
    volumes:
      - ./src:/workspace/src:ro
"#;
        let scan = scan_content(&file, Path::new("/tmp"), content);

        let plan = plan_compose_mount_edit(
            &file,
            content,
            &scan.mounts[0],
            Some("./app"),
            Some("/workspace/app"),
        );

        assert!(!plan.will_write);
        assert!(plan
            .unified_diff
            .contains("-      - ./src:/workspace/src:ro"));
        assert!(plan
            .unified_diff
            .contains("+      - ./app:/workspace/app:ro"));
    }

    #[test]
    fn blocks_parent_traversal_in_planned_source() {
        let file = PathBuf::from("/tmp/compose.yaml");
        let content = r#"
services:
  api:
    volumes:
      - ./src:/workspace/src:ro
"#;
        let scan = scan_content(&file, Path::new("/tmp"), content);

        let plan =
            plan_compose_mount_edit(&file, content, &scan.mounts[0], Some("../secrets"), None);

        assert!(plan.unified_diff.is_empty());
        assert!(plan
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "edit_source_parent_traversal"));
    }

    #[test]
    fn blocks_ambiguous_mount_line_replacements() {
        let file = PathBuf::from("/tmp/compose.yaml");
        let content = r#"
services:
  api:
    environment:
      NOTE: "./src:/workspace/src appears in documentation"
    volumes:
      - ./src:/workspace/src:ro
"#;
        let scan = scan_content(&file, Path::new("/tmp"), content);

        let plan = plan_compose_mount_edit(&file, content, &scan.mounts[0], Some("./app"), None);

        assert!(plan.unified_diff.is_empty());
        assert!(plan
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "edit_original_source_not_found"));
    }

    #[test]
    fn edit_plan_reports_noop_without_writing() {
        let file = PathBuf::from("/tmp/compose.yaml");
        let content = r#"
services:
  api:
    volumes:
      - ./src:/workspace/src
"#;
        let scan = scan_content(&file, Path::new("/tmp"), content);

        let plan = plan_compose_mount_edit(&file, content, &scan.mounts[0], None, None);

        assert!(!plan.will_write);
        assert!(plan.unified_diff.is_empty());
        assert!(plan
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "edit_noop"
                && diagnostic.severity == DiagnosticSeverity::Error));
    }

    #[test]
    fn edit_plan_blocks_invalid_target_without_diff() {
        let file = PathBuf::from("/tmp/compose.yaml");
        let content = r#"
services:
  api:
    volumes:
      - ./src:/workspace/src
"#;
        let scan = scan_content(&file, Path::new("/tmp"), content);

        let plan =
            plan_compose_mount_edit(&file, content, &scan.mounts[0], None, Some("relative/path"));

        assert!(plan.unified_diff.is_empty());
        assert!(plan
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "edit_invalid_target"
                && diagnostic.severity == DiagnosticSeverity::Blocked));
    }

    #[test]
    fn edit_plan_blocks_named_volume_source_changes() {
        let file = PathBuf::from("/tmp/compose.yaml");
        let content = r#"
services:
  api:
    volumes:
      - cache:/workspace/cache
"#;
        let scan = scan_content(&file, Path::new("/tmp"), content);

        let plan = plan_compose_mount_edit(&file, content, &scan.mounts[0], Some("./cache"), None);

        assert!(plan.unified_diff.is_empty());
        assert!(plan
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "edit_source_requires_bind"
                && diagnostic.severity == DiagnosticSeverity::Blocked));
    }

    fn read_contract_fixture<T: serde::de::DeserializeOwned>(name: &str) -> T {
        let path = repo_fixture_path(&["tests", "fixtures", "contracts", name]);
        let content = std::fs::read_to_string(&path).expect("contract fixture should be readable");
        serde_json::from_str(&content).expect("contract fixture should deserialize")
    }
}
