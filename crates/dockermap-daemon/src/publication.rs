//! The single boundary that turns provider and Docker observations into data
//! safe to publish through the daemon API or its diagnostics.  Keep this
//! separate from collection so a future provider cannot accidentally bypass
//! redaction, Unicode normalization, or collision handling.

use dockermap_core::{
    collision_resistant_id_component, ComposeDiagnostic, ComposeEditPlan, ComposeFileOrigin,
    ComposeScan, ContainerRecord, DiagnosticSeverity, DockerSnapshot, HealthResponse,
    RuntimeLocation, RuntimeMap, RuntimeMapDiagnostic, RuntimeMapEdge, RuntimeMapNode,
    RuntimeOwnership, RuntimePackageEntity, RuntimeProviderKind, RuntimeServiceEntity,
};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) const REDACTED_VALUE: &str = "[redacted]";
/// Evidence is a compact explanation reference, not an alternate raw-source
/// transport. Keep its human-facing fields independently bounded even if a
/// future provider constructs it outside the Docker derivation path.
const MAX_RUNTIME_EVIDENCE_TEXT_CHARS: usize = 256;

/// Character-bounded display truncation shared by Docker logs and bounded
/// project metadata. It lives at the publication boundary rather than the
/// daemon entrypoint so collectors cannot acquire bootstrap responsibilities.
pub(crate) fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut output = value.chars().take(max_chars).collect::<String>();
    if value.chars().count() > max_chars {
        output.push_str("...");
    }
    output
}

pub(crate) fn redact_runtime_map(runtime_map: &mut RuntimeMap) {
    redact_runtime_nodes(&mut runtime_map.nodes);
    redact_runtime_edges(&mut runtime_map.edges);
    redact_runtime_diagnostics(&mut runtime_map.diagnostics);
    normalize_runtime_map_topology(runtime_map);
}

/// Identifier normalization can collapse distinct hostile strings to the same
/// replacement form. Preserve every observed node and make collision ownership
/// explicit: the web model removes collided IDs from its selection index, so
/// no client can route an ambiguous ID to an arbitrary record.
fn normalize_runtime_map_topology(runtime_map: &mut RuntimeMap) {
    let duplicate_node_ids = duplicate_runtime_node_ids(&runtime_map.nodes);
    runtime_map.nodes.sort_by_key(runtime_node_sort_key);
    for _ in duplicate_node_ids {
        runtime_map.diagnostics.push(RuntimeMapDiagnostic {
            provider: RuntimeProviderKind::Other,
            severity: DiagnosticSeverity::Warning,
            message: "Duplicate runtime topology ID after publication normalization; records remain visible and non-routable".into(),
        });
    }

    let node_ids = runtime_map
        .nodes
        .iter()
        .map(|node| node.id.as_str())
        .collect::<BTreeSet<_>>();
    runtime_map.edges.retain(|edge| {
        node_ids.contains(edge.source.as_str()) && node_ids.contains(edge.target.as_str())
    });
    runtime_map.edges.sort_by_key(runtime_edge_sort_key);
    runtime_map.edges.dedup();
}

fn duplicate_runtime_node_ids(nodes: &[RuntimeMapNode]) -> BTreeSet<String> {
    let mut counts = BTreeMap::<&str, usize>::new();
    for node in nodes {
        *counts.entry(&node.id).or_default() += 1;
    }
    counts
        .into_iter()
        .filter(|(_, count)| *count > 1)
        .map(|(id, _)| id.to_string())
        .collect()
}

fn runtime_node_sort_key(node: &RuntimeMapNode) -> String {
    serde_json::to_string(node).expect("runtime nodes must serialize")
}

fn runtime_edge_sort_key(edge: &RuntimeMapEdge) -> String {
    serde_json::to_string(edge).expect("runtime edges must serialize")
}

pub(crate) fn redact_runtime_nodes(nodes: &mut [RuntimeMapNode]) {
    for node in nodes {
        redact_runtime_node(node);
    }
}

pub(crate) fn redact_runtime_node(node: &mut RuntimeMapNode) {
    node.id = redact_runtime_display_text(&node.id);
    node.label = redact_runtime_display_text(&node.label);
    if let Some(status) = &mut node.status {
        *status = redact_runtime_display_text(status);
    }
    for value in node.metadata.values_mut() {
        *value = redact_runtime_display_text(value);
    }
    redact_service_entity(node.service.as_mut());
    redact_package_entity(node.package.as_mut());
}

fn redact_service_entity(service: Option<&mut RuntimeServiceEntity>) {
    let Some(service) = service else {
        return;
    };
    service.name = redact_runtime_display_text(&service.name);
    for value in &mut service.dependencies {
        *value = redact_runtime_display_text(value);
    }
    for value in &mut service.dependents {
        *value = redact_runtime_display_text(value);
    }
    if let Some(health) = &mut service.health {
        if let Some(source) = &mut health.source {
            *source = redact_runtime_display_text(source);
        }
        if let Some(message) = &mut health.message {
            *message = redact_runtime_display_text(message);
        }
    }
    for log in &mut service.logs {
        log.id = redact_runtime_display_text(&log.id);
        log.source = redact_runtime_display_text(&log.source);
    }
    for event in &mut service.events {
        event.id = redact_runtime_display_text(&event.id);
        event.kind = redact_runtime_display_text(&event.kind);
        if let Some(message) = &mut event.message {
            *message = redact_runtime_display_text(message);
        }
    }
    redact_ownership(service.owner.as_mut());
    redact_location(service.location.as_mut());
}

fn redact_package_entity(package: Option<&mut RuntimePackageEntity>) {
    let Some(package) = package else {
        return;
    };
    package.name = redact_runtime_display_text(&package.name);
    package.version = redact_runtime_display_text(&package.version);
    for value in &mut package.dependencies {
        *value = redact_runtime_display_text(value);
    }
    for value in &mut package.dependents {
        *value = redact_runtime_display_text(value);
    }
    if let Some(update) = &mut package.update {
        update.current_version = redact_runtime_display_text(&update.current_version);
        if let Some(latest) = &mut update.latest_version {
            *latest = redact_runtime_display_text(latest);
        }
        for advisory in &mut update.advisories {
            advisory.id = redact_runtime_display_text(&advisory.id);
            advisory.title = redact_runtime_display_text(&advisory.title);
            advisory.source = redact_runtime_display_text(&advisory.source);
            if let Some(fixed) = &mut advisory.fixed_version {
                *fixed = redact_runtime_display_text(fixed);
            }
            if let Some(url) = &mut advisory.url {
                *url = redact_runtime_display_text(url);
            }
        }
    }
    redact_ownership(package.owner.as_mut());
    redact_location(package.location.as_mut());
}

fn redact_ownership(owner: Option<&mut RuntimeOwnership>) {
    let Some(owner) = owner else {
        return;
    };
    owner.name = redact_runtime_display_text(&owner.name);
    if let Some(id) = &mut owner.id {
        *id = redact_runtime_display_text(id);
    }
}

fn redact_location(location: Option<&mut RuntimeLocation>) {
    let Some(location) = location else {
        return;
    };
    location.value = redact_runtime_display_text(&location.value);
    if let Some(detail) = &mut location.detail {
        *detail = redact_runtime_display_text(detail);
    }
}

pub(crate) fn redact_runtime_edges(edges: &mut [RuntimeMapEdge]) {
    for edge in edges {
        edge.source = redact_runtime_display_text(&edge.source);
        edge.target = redact_runtime_display_text(&edge.target);
        for value in edge.metadata.values_mut() {
            *value = redact_runtime_display_text(value);
        }
        redact_runtime_evidence_refs(&mut edge.evidence_refs);
    }
}

fn redact_runtime_evidence_refs(evidence_refs: &mut [dockermap_core::RuntimeEvidenceRef]) {
    for evidence in evidence_refs.iter_mut() {
        // `subjectRef` is a runtime edge endpoint rather than presentation
        // detail, so do not truncate it independently of its owning edge.
        // This preserves the existing collision/non-routability semantics.
        evidence.subject_ref = redact_runtime_display_text(&evidence.subject_ref);
        evidence.id = truncate_chars(
            &redact_runtime_display_text(&evidence.id),
            MAX_RUNTIME_EVIDENCE_TEXT_CHARS,
        );
        evidence.summary = truncate_chars(
            &redact_runtime_display_text(&evidence.summary),
            MAX_RUNTIME_EVIDENCE_TEXT_CHARS,
        );
        evidence.provider_revision = truncate_chars(
            &redact_runtime_display_text(&evidence.provider_revision),
            MAX_RUNTIME_EVIDENCE_TEXT_CHARS,
        );
    }
    // Keep distinct post-redaction occurrences visible. Evidence IDs are not
    // routing keys (each record remains inline with its edge), so deduping a
    // normalized collision would silently erase an observation. Sorting gives
    // clients deterministic output without selecting one collision winner.
    evidence_refs.sort_by_key(|evidence| {
        serde_json::to_string(evidence).expect("runtime evidence must serialize")
    });
}

pub(crate) fn redact_runtime_diagnostics(diagnostics: &mut [RuntimeMapDiagnostic]) {
    for diagnostic in diagnostics {
        diagnostic.message = redact_runtime_display_text(&diagnostic.message);
    }
}

/// Apply the same redact-and-normalize publication boundary to compose data
/// before it is returned directly or used to derive a graph.
pub(crate) fn redact_compose_scan(scan: &mut ComposeScan) {
    for file in &mut scan.files {
        *file = redact_runtime_display_text(file);
    }
    scan.project_root = redact_runtime_display_text(&scan.project_root);
    let diagnostic_file = scan.files.first().cloned().unwrap_or_default();
    let mut environment_key_collisions = Vec::new();
    for service in &mut scan.services {
        service.name = redact_runtime_display_text(&service.name);
        if let Some(image) = &mut service.image {
            *image = redact_runtime_display_text(image);
        }
        let mut environment = BTreeMap::new();
        for (key, value) in std::mem::take(&mut service.environment) {
            let published_key = redact_runtime_display_text(&key);
            let published_value = redact_runtime_display_text(&value);
            if environment.contains_key(&published_key) {
                environment_key_collisions.push(ComposeDiagnostic {
                    id: "compose_environment_key_collision".into(),
                    severity: DiagnosticSeverity::Warning,
                    message: "An environment key was dropped after publication normalization"
                        .into(),
                    origin: ComposeFileOrigin {
                        file: diagnostic_file.clone(),
                        service: Some(service.name.clone()),
                        field: "environment".into(),
                    },
                });
                continue;
            }
            environment.insert(published_key, published_value);
        }
        service.environment = environment;
        for dependency in &mut service.depends_on {
            *dependency = redact_runtime_display_text(dependency);
        }
    }
    scan.diagnostics.extend(environment_key_collisions);
    for mount in &mut scan.mounts {
        mount.id = redact_runtime_display_text(&mount.id);
        mount.service = redact_runtime_display_text(&mount.service);
        if let Some(source) = &mut mount.source {
            *source = redact_runtime_display_text(source);
        }
        if let Some(source) = &mut mount.resolved_source {
            *source = redact_runtime_display_text(source);
        }
        mount.target = redact_runtime_display_text(&mount.target);
        redact_compose_origin(&mut mount.origin);
    }
    for correlation in &mut scan.correlations {
        correlation.id = redact_runtime_display_text(&correlation.id);
        correlation.service = redact_runtime_display_text(&correlation.service);
        if let Some(container) = &mut correlation.container {
            *container = redact_runtime_display_text(container);
        }
        if let Some(mount_id) = &mut correlation.compose_mount_id {
            *mount_id = redact_runtime_display_text(mount_id);
        }
        correlation.target = redact_runtime_display_text(&correlation.target);
        if let Some(source) = &mut correlation.declared_source {
            *source = redact_runtime_display_text(source);
        }
        if let Some(source) = &mut correlation.runtime_source {
            *source = redact_runtime_display_text(source);
        }
    }
    for diagnostic in &mut scan.diagnostics {
        diagnostic.id = redact_runtime_display_text(&diagnostic.id);
        diagnostic.message = redact_runtime_display_text(&diagnostic.message);
        redact_compose_origin(&mut diagnostic.origin);
    }
}

fn redact_compose_origin(origin: &mut ComposeFileOrigin) {
    origin.file = redact_runtime_display_text(&origin.file);
    if let Some(service) = &mut origin.service {
        *service = redact_runtime_display_text(service);
    }
    origin.field = redact_runtime_display_text(&origin.field);
}

/// Planning needs raw fields to locate and diff a mount, but no
/// provider-derived value may cross the HTTP boundary unredacted.
pub(crate) fn redact_compose_edit_plan(plan: &mut ComposeEditPlan) {
    plan.file = redact_runtime_display_text(&plan.file);
    plan.service = redact_runtime_display_text(&plan.service);
    plan.mount_id = redact_runtime_display_text(&plan.mount_id);
    if let Some(source) = &mut plan.original_source {
        *source = redact_runtime_display_text(source);
    }
    plan.original_target = redact_runtime_display_text(&plan.original_target);
    if let Some(source) = &mut plan.new_source {
        *source = redact_runtime_display_text(source);
    }
    if let Some(target) = &mut plan.new_target {
        *target = redact_runtime_display_text(target);
    }
    plan.unified_diff = normalize_runtime_display_string(&redact_unified_diff(&plan.unified_diff));
    for diagnostic in &mut plan.diagnostics {
        diagnostic.id = redact_runtime_display_text(&diagnostic.id);
        diagnostic.message = redact_runtime_display_text(&diagnostic.message);
        redact_compose_origin(&mut diagnostic.origin);
    }
}

pub(crate) fn redact_health_response(health: &mut HealthResponse) {
    if let Some(message) = &mut health.message {
        *message = redact_runtime_display_text(message);
    }
}

/// Clone cached Docker inventory at the HTTP publication boundary. Raw cache
/// entries remain available for internal correlation and exact-name lookup.
pub(crate) fn publish_docker_snapshot(snapshot: &DockerSnapshot) -> DockerSnapshot {
    let mut published = snapshot.clone();
    redact_docker_snapshot(&mut published);
    published
}

pub(crate) fn redact_docker_snapshot(snapshot: &mut DockerSnapshot) {
    for container in &mut snapshot.containers {
        redact_container_record(container);
    }
    for image in &mut snapshot.images {
        image.image = redact_runtime_display_text(&image.image);
        redact_display_strings(&mut image.containers);
        image.status = redact_runtime_display_text(&image.status);
    }
    for network in &mut snapshot.networks {
        network.id = redact_runtime_display_text(&network.id);
        network.name = redact_runtime_display_text(&network.name);
        network.driver = redact_runtime_display_text(&network.driver);
        redact_display_strings(&mut network.members);
    }
    for volume in &mut snapshot.volumes {
        volume.id = redact_runtime_display_text(&volume.id);
        volume.name = redact_runtime_display_text(&volume.name);
        redact_display_strings(&mut volume.attached_to);
    }
}

pub(crate) fn redact_container_record(container: &mut ContainerRecord) {
    container.id = redact_runtime_display_text(&container.id);
    container.name = redact_runtime_display_text(&container.name);
    container.image = redact_runtime_display_text(&container.image);
    container.status = redact_runtime_display_text(&container.status);
    container.role = redact_runtime_display_text(&container.role);
    redact_display_strings(&mut container.networks);
    redact_display_strings(&mut container.ports);
    redact_display_strings(&mut container.depends_on);
    for mount in &mut container.mounts {
        mount.id = redact_runtime_display_text(&mount.id);
        if let Some(source) = &mut mount.source {
            *source = redact_runtime_display_text(source);
        }
        mount.target = redact_runtime_display_text(&mount.target);
    }
}

fn redact_display_strings(values: &mut [String]) {
    for value in values {
        *value = redact_runtime_display_text(value);
    }
}

/// Redact secret-bearing lines from a unified diff while retaining its markers.
pub(crate) fn redact_unified_diff(diff: &str) -> String {
    diff.lines()
        .map(|line| {
            let (marker, rest) = match line.chars().next() {
                Some('+') => ("+", &line[1..]),
                Some('-') => ("-", &line[1..]),
                Some(' ') => (" ", &line[1..]),
                _ => ("", line),
            };
            if is_sensitive_text(rest) {
                format!("{marker}{REDACTED_VALUE}")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn redact_sensitive_text(value: &str) -> String {
    if is_sensitive_text(value) {
        REDACTED_VALUE.into()
    } else {
        value.to_string()
    }
}

/// Single post-redaction gate for provider-controlled display strings.
pub(crate) fn redact_runtime_display_text(value: &str) -> String {
    normalize_runtime_display_string(&redact_sensitive_text(value))
}

pub(crate) fn normalize_runtime_display_string(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if unsafe_runtime_display_character(character) {
                '\u{FFFD}'
            } else {
                character
            }
        })
        .collect()
}

pub(crate) fn unsafe_runtime_display_character(character: char) -> bool {
    let code = character as u32;
    character.is_control()
        || (0x200B..=0x200F).contains(&code)
        || (0x2028..=0x202E).contains(&code)
        || (0x2060..=0x2069).contains(&code)
        || code == 0xFEFF
        || (0xFDD0..=0xFDEF).contains(&code)
        || matches!(code & 0xFFFF, 0xFFFE | 0xFFFF)
}

fn is_sensitive_text(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("dockermap_test_fake_")
        || contains_url_userinfo(value)
        || contains_sensitive_assignment(&lower)
        || contains_sensitive_flag(&lower)
        || contains_auth_scheme(&lower)
}

fn contains_url_userinfo(value: &str) -> bool {
    let Some(scheme_index) = value.find("://") else {
        return false;
    };
    let authority = &value[scheme_index + 3..];
    let authority_end = authority.find(['/', '?', '#']).unwrap_or(authority.len());
    authority[..authority_end].contains('@')
}

fn contains_sensitive_assignment(value: &str) -> bool {
    [
        "token=",
        "token:",
        "auth_token=",
        "auth_token:",
        "_authtoken=",
        "_authtoken:",
        "_auth=",
        "_auth:",
        "api_key=",
        "api_key:",
        "api-key=",
        "api-key:",
        "apikey=",
        "apikey:",
        "x-api-key=",
        "x-api-key:",
        "secret_key=",
        "secret_key:",
        "secret-key=",
        "secret-key:",
        "secret_access_key=",
        "secret_access_key:",
        "secret-access-key=",
        "secret-access-key:",
        "aws_secret_access_key=",
        "aws_secret_access_key:",
        "authorization=",
        "authorization:",
        "password=",
        "password:",
        "passwd=",
        "passwd:",
        "secret=",
        "secret:",
        "client_secret=",
        "client_secret:",
        "private_key=",
        "private_key:",
        "credential=",
        "credential:",
        "access_token=",
        "access_token:",
        "refresh_token=",
        "refresh_token:",
    ]
    .into_iter()
    .any(|needle| value.contains(needle))
}

fn contains_sensitive_flag(value: &str) -> bool {
    let flags = [
        "--token",
        "--auth",
        "--api-key",
        "--authorization",
        "--password",
        "--secret",
        "--client-secret",
        "--private-key",
    ];
    value.split_whitespace().any(|token| {
        flags
            .into_iter()
            .any(|flag| token == flag || token.starts_with(&format!("{flag}=")))
    })
}

fn contains_auth_scheme(value: &str) -> bool {
    let trimmed = value.trim_start();
    trimmed.starts_with("bearer ")
        || value.contains("authorization: bearer")
        || value.contains("authorization: basic")
        || value.contains("authorization=bearer")
        || value.contains("authorization=basic")
}

pub(crate) fn safe_runtime_id_component(value: &str, fallback: &str) -> String {
    if redact_sensitive_text(value) == REDACTED_VALUE {
        let generated = collision_resistant_id_component(value);
        let hash = generated
            .rsplit_once("--")
            .map_or("identity", |(_, hash)| hash);
        format!("{fallback}--{hash}")
    } else {
        collision_resistant_id_component(value)
    }
}

pub(crate) fn push_provider_diagnostic(
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
    provider: RuntimeProviderKind,
    severity: DiagnosticSeverity,
    message: String,
) {
    let safe = normalize_runtime_display_string(&redact_sensitive_text(&message));
    let mut stderr = std::io::stderr();
    let _ = write_provider_diagnostic(&mut stderr, &provider, &severity, &safe);
    diagnostics.push(RuntimeMapDiagnostic {
        provider,
        severity,
        message: safe,
    });
}

pub(crate) fn write_provider_diagnostic(
    writer: &mut impl std::io::Write,
    provider: &RuntimeProviderKind,
    severity: &DiagnosticSeverity,
    message: &str,
) -> std::io::Result<()> {
    writeln!(
        writer,
        "provider diagnostic ({provider:?}, {severity:?}): {message}"
    )
}

#[cfg(test)]
mod shared_helper_tests {
    use super::truncate_chars;

    #[test]
    fn truncates_log_messages_on_character_boundaries() {
        assert_eq!(truncate_chars("abcdef", 3), "abc...");
        assert_eq!(truncate_chars("ok", 3), "ok");
    }
}
