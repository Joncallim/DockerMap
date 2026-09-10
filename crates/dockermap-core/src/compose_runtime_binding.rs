//! Private Compose-to-Docker coherence contract used by the findings cache.
//!
//! This type intentionally has no serde/schema derives: project names, config
//! file paths, Docker labels and raw container IDs never cross the API boundary.

use std::collections::{BTreeMap, BTreeSet};

use crate::{
    ComposeMountKind, ComposeScan, ContainerMount, Finding, FindingRule, FindingSeverity,
    RuntimeEvidenceAssertionKind, RuntimeEvidenceFreshness, RuntimeEvidenceKind,
    RuntimeEvidenceProvider, RuntimeEvidenceRef,
};
use sha2::{Digest, Sha256};

const SUMMARY: &str = "A Compose-declared mount is absent from its exactly bound runtime container";
const RECOMMENDATION: &str =
    "Inspect the Compose mount declaration and the bound container's current mount configuration.";
pub const MAX_COMPOSE_RUNTIME_BINDING_CONTAINERS: usize = 64;
pub const MAX_COMPOSE_RUNTIME_BINDING_CONFIG_FILES: usize = 8;
const MAX_COMPOSE_RUNTIME_BINDING_SERVICES: usize = 128;
const MAX_COMPOSE_RUNTIME_BINDING_MOUNTS: usize = 256;
pub const MAX_RUNTIME_MOUNTS_PER_BOUND_CONTAINER: usize = 128;
const MAX_PRIVATE_ID_CHARS: usize = 259;

/// One Docker container's private Compose identity captured from fixed Docker
/// summary labels during the same observation as its mount list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposeRuntimeContainer {
    pub container_id: String,
    pub project: String,
    pub service: String,
    pub config_files: BTreeSet<String>,
    pub mounts: Vec<ContainerMount>,
}

/// A bounded, internal only declaration/runtime binding request. `project` is
/// accepted only after structured YAML parsing found one explicit top-level
/// Compose `name`; callers must pass no value when it is absent or conflicted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposeRuntimeBinding {
    pub project: String,
    pub config_files: BTreeSet<String>,
    pub containers: Vec<ComposeRuntimeContainer>,
    pub collected_at: u64,
    pub provider_revision: String,
    pub fresh: bool,
}

/// Derive only the one high-signal missing-mount rule. All identity checks are
/// exact and private; failure to establish any one of them emits nothing.
pub fn derive_compose_runtime_mount_findings(
    scan: &ComposeScan,
    binding: &ComposeRuntimeBinding,
) -> Vec<Finding> {
    if !binding.fresh
        || binding.project.is_empty()
        || binding.project.chars().count() > MAX_PRIVATE_ID_CHARS
        || binding.config_files.is_empty()
        || binding.config_files.len() > MAX_COMPOSE_RUNTIME_BINDING_CONFIG_FILES
        || binding.provider_revision.is_empty()
        || binding.containers.len() > MAX_COMPOSE_RUNTIME_BINDING_CONTAINERS
        || scan.services.len() > MAX_COMPOSE_RUNTIME_BINDING_SERVICES
        || scan.mounts.len() > MAX_COMPOSE_RUNTIME_BINDING_MOUNTS
        || scan.files.iter().cloned().collect::<BTreeSet<_>>() != binding.config_files
        || scan
            .diagnostics
            .iter()
            .any(|d| d.severity != crate::DiagnosticSeverity::Info)
        || binding
            .config_files
            .iter()
            .any(|path| path.chars().count() > MAX_PRIVATE_ID_CHARS)
        || binding.containers.iter().any(|container| {
            container.container_id.is_empty()
                || !is_docker_container_id(&container.container_id)
                || container.container_id.chars().count() > MAX_PRIVATE_ID_CHARS
                || container.project.chars().count() > MAX_PRIVATE_ID_CHARS
                || container.service.is_empty()
                || container.service.chars().count() > MAX_PRIVATE_ID_CHARS
                || container.config_files.len() > MAX_COMPOSE_RUNTIME_BINDING_CONFIG_FILES
                || container
                    .config_files
                    .iter()
                    .any(|path| path.chars().count() > MAX_PRIVATE_ID_CHARS)
                || container.mounts.len() > MAX_RUNTIME_MOUNTS_PER_BOUND_CONTAINER
        })
    {
        return Vec::new();
    }

    let mut container_id_counts = BTreeMap::<&str, usize>::new();
    let mut service_counts = BTreeMap::<&str, usize>::new();
    for container in &binding.containers {
        *container_id_counts
            .entry(&container.container_id)
            .or_default() += 1;
        if container.project == binding.project && container.config_files == binding.config_files {
            *service_counts.entry(&container.service).or_default() += 1;
        }
    }

    let mut findings = Vec::new();
    for (mount_ordinal, mount) in scan.mounts.iter().enumerate() {
        if !matches!(
            mount.kind,
            ComposeMountKind::Bind | ComposeMountKind::NamedVolume
        ) {
            continue;
        }
        let mut candidate = None;
        for container in &binding.containers {
            if container.project == binding.project
                && container.config_files == binding.config_files
                && container.service == mount.service
                && !container.container_id.is_empty()
                && container_id_counts.get(container.container_id.as_str()) == Some(&1)
                && service_counts.get(container.service.as_str()) == Some(&1)
            {
                candidate = Some(container);
                break;
            }
        }
        let Some(container) = candidate else {
            continue;
        };
        if container
            .mounts
            .iter()
            .any(|runtime| mounts_match(mount, runtime))
        {
            continue;
        }
        // This is a private binding subject, deliberately separate from the
        // display/runtime node identity so raw Docker IDs cannot leak here.
        let subject_ref = format!(
            "compose_runtime_binding_{}",
            opaque_id(&container.container_id)
        );
        // Raw project/service/mount strings can have low entropy and are
        // therefore unsuitable even as a digest oracle. The Docker container
        // identity is already opaque/high-entropy; a bounded ordinal keeps
        // repeated declarations deterministic without exposing their content.
        let evidence_seed = format!("{}\u{1f}{mount_ordinal}", container.container_id);
        findings.push(Finding {
            id: format!(
                "finding_compose_declared_mount_missing_at_bound_container_{}",
                opaque_id(&evidence_seed)
            ),
            rule_id: FindingRule::ComposeDeclaredMountMissingAtBoundContainer,
            severity: FindingSeverity::Warning,
            summary: SUMMARY.into(),
            recommendation: RECOMMENDATION.into(),
            subject_ref: subject_ref.clone(),
            target_ref: subject_ref.clone(),
            evidence_refs: vec![
                evidence(
                    "compose_declared_mount",
                    RuntimeEvidenceProvider::Compose,
                    RuntimeEvidenceKind::ComposeDeclaredMount,
                    RuntimeEvidenceAssertionKind::Declared,
                    &subject_ref,
                    binding,
                    &evidence_seed,
                ),
                evidence(
                    "docker_compose_runtime_binding",
                    RuntimeEvidenceProvider::Docker,
                    RuntimeEvidenceKind::DockerComposeRuntimeBinding,
                    RuntimeEvidenceAssertionKind::Observed,
                    &subject_ref,
                    binding,
                    &evidence_seed,
                ),
            ],
        });
    }
    findings.sort_by(|a, b| a.id.cmp(&b.id));
    findings
}

fn evidence(
    prefix: &str,
    provider: RuntimeEvidenceProvider,
    kind: RuntimeEvidenceKind,
    assertion_kind: RuntimeEvidenceAssertionKind,
    subject_ref: &str,
    binding: &ComposeRuntimeBinding,
    seed: &str,
) -> RuntimeEvidenceRef {
    RuntimeEvidenceRef {
        version: 6,
        id: format!("{prefix}_{}", opaque_id(seed)),
        provider,
        kind,
        assertion_kind,
        summary: match kind {
            RuntimeEvidenceKind::ComposeDeclaredMount => {
                "Compose declared a mount for the bound service"
            }
            RuntimeEvidenceKind::DockerComposeRuntimeBinding => {
                "Docker confirmed an exact Compose project, service, and config binding"
            }
            _ => unreachable!(),
        }
        .into(),
        subject_ref: subject_ref.into(),
        collected_at: binding.collected_at,
        provider_revision: binding.provider_revision.clone(),
        provider_slot: None,
        freshness: RuntimeEvidenceFreshness::Fresh,
    }
}

fn opaque_id(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn is_docker_container_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn mounts_match(declared: &crate::ComposeMount, runtime: &ContainerMount) -> bool {
    declared.kind == runtime.kind
        && declared.target == runtime.target
        && match declared.kind {
            ComposeMountKind::Bind => {
                declared
                    .resolved_source
                    .as_ref()
                    .or(declared.source.as_ref())
                    == runtime.source.as_ref()
            }
            ComposeMountKind::NamedVolume => declared.source.as_ref() == runtime.source.as_ref(),
            _ => false,
        }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ComposeFileOrigin, ComposeMount, ComposeMountKind};

    fn scan() -> ComposeScan {
        ComposeScan {
            files: vec!["/project/compose.yaml".into()],
            project_root: "/project".into(),
            services: Vec::new(),
            correlations: Vec::new(),
            diagnostics: Vec::new(),
            mounts: vec![ComposeMount {
                id: "mount-api-0".into(),
                service: "api".into(),
                kind: ComposeMountKind::Bind,
                source: Some("./data".into()),
                resolved_source: Some("/project/data".into()),
                target: "/data".into(),
                read_only: false,
                origin: ComposeFileOrigin {
                    file: "/project/compose.yaml".into(),
                    service: Some("api".into()),
                    field: "services.api.volumes[0]".into(),
                },
            }],
        }
    }
    fn binding(mounts: Vec<ContainerMount>) -> ComposeRuntimeBinding {
        ComposeRuntimeBinding {
            project: "demo".into(),
            config_files: BTreeSet::from(["/project/compose.yaml".into()]),
            containers: vec![ComposeRuntimeContainer {
                container_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .into(),
                project: "demo".into(),
                service: "api".into(),
                config_files: BTreeSet::from(["/project/compose.yaml".into()]),
                mounts,
            }],
            collected_at: 42,
            provider_revision: "opaque-observation".into(),
            fresh: true,
        }
    }
    #[test]
    fn emits_only_path_free_missing_mount_finding_for_exact_binding() {
        let findings = derive_compose_runtime_mount_findings(&scan(), &binding(Vec::new()));
        assert_eq!(findings.len(), 1);
        let finding = &findings[0];
        assert_eq!(
            finding.rule_id,
            FindingRule::ComposeDeclaredMountMissingAtBoundContainer
        );
        assert_eq!(finding.evidence_refs.len(), 2);
        let json = serde_json::to_string(finding).unwrap();
        for secret in [
            "/project",
            "./data",
            "/data",
            "demo",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ] {
            assert!(!json.contains(secret), "{json}");
        }
    }
    #[test]
    fn fails_closed_for_matching_mount_stale_or_ambiguous_binding() {
        let matching = ContainerMount {
            id: "private".into(),
            kind: ComposeMountKind::Bind,
            source: Some("/project/data".into()),
            target: "/data".into(),
            read_only: false,
        };
        assert!(
            derive_compose_runtime_mount_findings(&scan(), &binding(vec![matching])).is_empty()
        );
        let mut stale = binding(Vec::new());
        stale.fresh = false;
        assert!(derive_compose_runtime_mount_findings(&scan(), &stale).is_empty());
        let mut ambiguous = binding(Vec::new());
        ambiguous.containers.push(ambiguous.containers[0].clone());
        assert!(derive_compose_runtime_mount_findings(&scan(), &ambiguous).is_empty());
    }

    #[test]
    fn fails_closed_for_any_diagnostic_or_bound_cap_and_ids_do_not_oracle_project_names() {
        for diagnostic_id in [
            "compose_unresolved_variable",
            "compose_invalid_mount_target",
            "compose_duplicate_mount_target",
            "compose_mount_missing_source",
            "compose_bind_source_symlink",
        ] {
            let mut warned = scan();
            warned.diagnostics.push(crate::ComposeDiagnostic {
                id: diagnostic_id.into(),
                severity: crate::DiagnosticSeverity::Warning,
                message: "private".into(),
                origin: warned.mounts[0].origin.clone(),
            });
            assert!(
                derive_compose_runtime_mount_findings(&warned, &binding(Vec::new())).is_empty(),
                "{diagnostic_id}"
            );
        }
        let mut over_cap = binding(Vec::new());
        over_cap.containers = std::iter::repeat_n(
            over_cap.containers[0].clone(),
            MAX_COMPOSE_RUNTIME_BINDING_CONTAINERS + 1,
        )
        .collect();
        assert!(derive_compose_runtime_mount_findings(&scan(), &over_cap).is_empty());

        let first = derive_compose_runtime_mount_findings(&scan(), &binding(Vec::new()));
        let mut renamed_scan = scan();
        renamed_scan.mounts[0].id = "low-entropy-mount-name".into();
        renamed_scan.mounts[0].service = "other-service".into();
        let mut renamed_binding = binding(Vec::new());
        renamed_binding.project = "different-low-entropy-project".into();
        renamed_binding.containers[0].project = renamed_binding.project.clone();
        renamed_binding.containers[0].service = "other-service".into();
        let second = derive_compose_runtime_mount_findings(&renamed_scan, &renamed_binding);
        assert_eq!(first[0].id, second[0].id);
        assert_eq!(first[0].evidence_refs[0].id, second[0].evidence_refs[0].id);

        let mut malformed_id = binding(Vec::new());
        malformed_id.containers[0].container_id = "not-a-docker-id".into();
        assert!(derive_compose_runtime_mount_findings(&scan(), &malformed_id).is_empty());
    }
}
