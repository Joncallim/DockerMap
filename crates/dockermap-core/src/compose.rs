use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::{
    collision_resistant_id_component, ComposeDiagnostic, ComposeEditPlan, ComposeFileOrigin,
    ComposeGraph, ComposeGraphEdge, ComposeGraphNode, ComposeMount, ComposeMountKind,
    ComposeNodeKind, ComposeRelationshipKind, ComposeScan, ComposeService, ContainerMount,
    ContainerRecord, DiagnosticSeverity, DockerSnapshot, MountCorrelation, MountCorrelationStatus,
};

pub(crate) const MAX_COMPOSE_FILE_BYTES: u64 = 1_048_576;

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

pub(crate) fn parse_compose_file(file: &Path, content: &str, scan: &mut ComposeScan) {
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

pub(crate) fn coalesce_compose_services(scan: &mut ComposeScan) {
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

pub(crate) fn validate_compose_scan(scan: &mut ComposeScan) {
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
pub(crate) fn unsafe_bind_source_diagnostic(
    resolved: &str,
) -> Option<(DiagnosticSeverity, String)> {
    if is_docker_daemon_state_bind_source(resolved) {
        return Some((
            DiagnosticSeverity::Blocked,
            format!(
                "Bind source `{resolved}` exposes Docker daemon state; a compromised container could control the host daemon."
            ),
        ));
    }

    let path = Path::new(resolved);
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

/// Closed, path-boundary predicate shared by Compose diagnostics and runtime
/// derivation. Callers must never publish the matching source path.
pub(crate) fn is_docker_daemon_state_bind_source(resolved: &str) -> bool {
    let path = Path::new(resolved);
    path.components()
        .any(|component| component.as_os_str() == "docker.sock")
        || resolved == "/var/lib/docker"
        || resolved.starts_with("/var/lib/docker/")
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

pub(crate) fn split_short_volume(raw: &str) -> Vec<&str> {
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

pub(crate) fn resolve_source(
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

pub(crate) fn display_path(path: &Path) -> String {
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
