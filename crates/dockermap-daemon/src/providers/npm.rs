//! Bounded, read-only npm project discovery rooted at DockerMap's configured
//! project directory. No registry commands or external network calls occur.

use crate::pid_namespace::PidNamespaceScope;
use crate::providers::looks_like_ai_agent;
use crate::publication::truncate_chars;
use crate::{
    push_provider_diagnostic, redact_sensitive_text, safe_runtime_id_component, REDACTED_VALUE,
};
#[cfg(test)]
use crate::{redact_runtime_diagnostics, redact_runtime_edges, redact_runtime_nodes};
use dockermap_core::{
    service_entity_kind_name, DiagnosticSeverity, RuntimeMapDiagnostic, RuntimeMapEdge,
    RuntimeMapNode, RuntimeNodeKind, RuntimeNodeLayer, RuntimePackageEntity, RuntimeProviderKind,
    RuntimeRelationshipKind, ServiceEntityKind,
};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    ffi::CString,
    fs,
    io::Read,
    os::unix::{
        ffi::OsStrExt,
        io::{AsRawFd, FromRawFd},
    },
    path::{Component, Path, PathBuf},
};

const MAX_DISCOVERY_DIRS: usize = 4_096;
const MAX_NPM_PROJECTS: usize = 64;
const MAX_NPM_DEPENDENCIES_PER_PROJECT: usize = 64;
const MAX_PACKAGE_JSON_BYTES: u64 = 262_144;
const MAX_NPM_SCRIPTS: usize = 16;
const MAX_SCRIPT_CHARS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
struct PackageDependencyRecord {
    name: String,
    version: String,
    scope: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NpmProjectSummary {
    directory: PathBuf,
    package_name: Option<String>,
    display_name: String,
    kind: RuntimeNodeKind,
    service_entity_kind: ServiceEntityKind,
    package_manager: Option<String>,
    lockfiles: Vec<String>,
    dependencies: Vec<PackageDependencyRecord>,
    scripts: BTreeMap<String, String>,
    framework_hints: Vec<String>,
    private: bool,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct PackageManifestDocument {
    name: Option<String>,
    private: bool,
    #[serde(rename = "packageManager")]
    package_manager: Option<String>,
    scripts: BTreeMap<String, String>,
    dependencies: BTreeMap<String, String>,
    #[serde(rename = "optionalDependencies")]
    optional_dependencies: BTreeMap<String, String>,
    #[serde(rename = "peerDependencies")]
    peer_dependencies: BTreeMap<String, String>,
    #[serde(rename = "devDependencies")]
    dev_dependencies: BTreeMap<String, String>,
}

pub(crate) fn collect_npm_projects(
    project_root: &Path,
    pid_namespace: PidNamespaceScope,
    nodes: &mut Vec<RuntimeMapNode>,
    edges: &mut Vec<RuntimeMapEdge>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    let projects = discover_npm_projects(project_root, diagnostics);
    for (project_index, project) in projects.into_iter().enumerate() {
        let relative_path = project
            .directory
            .strip_prefix(project_root)
            .unwrap_or(project.directory.as_path())
            .display()
            .to_string();
        let node_id = format!(
            "npm_project_{}",
            safe_runtime_id_component(&relative_path, &format!("project_{project_index}"))
        );
        let mut metadata = BTreeMap::new();
        metadata.insert("path".into(), relative_path.clone());
        metadata.insert(
            "serviceEntityKind".into(),
            service_entity_kind_name(&project.service_entity_kind).into(),
        );
        metadata.insert("private".into(), project.private.to_string());
        if let Some(package_name) = &project.package_name {
            metadata.insert("packageName".into(), package_name.clone());
        }
        if let Some(package_manager) = &project.package_manager {
            metadata.insert("packageManager".into(), package_manager.clone());
        }
        if !project.lockfiles.is_empty() {
            metadata.insert("lockfiles".into(), project.lockfiles.join(","));
        }
        if !project.framework_hints.is_empty() {
            metadata.insert("frameworks".into(), project.framework_hints.join(","));
        }
        if !project.scripts.is_empty() {
            let scripts = project
                .scripts
                .iter()
                .map(|(name, script)| format!("{name}={script}"))
                .collect::<Vec<_>>()
                .join(" | ");
            metadata.insert("scripts".into(), truncate_chars(&scripts, 1_600));
        }
        nodes.push(RuntimeMapNode {
            id: node_id.clone(),
            provider: RuntimeProviderKind::Npm,
            kind: project.kind.clone(),
            label: project.display_name.clone(),
            status: Some("discovered".into()),
            layer: Some(RuntimeNodeLayer::Package),
            metadata,
            service: None,
            package: None,
        });
        if !pid_namespace.is_restricted() {
            edges.push(RuntimeMapEdge {
                source: node_id.clone(),
                target: "host_local".into(),
                relationship: RuntimeRelationshipKind::RunsOn,
                metadata: BTreeMap::new(),
            });
        }
        for (index, dependency) in project.dependencies.into_iter().enumerate() {
            let safe_package_name = redact_sensitive_text(&dependency.name);
            let safe_version = redact_sensitive_text(&dependency.version);
            let safe_scope = redact_sensitive_text(&dependency.scope);
            let package_id = format!(
                "npm_package_{}_{}",
                safe_runtime_id_component(&safe_package_name, "package"),
                if safe_version == REDACTED_VALUE {
                    format!("redacted_{index}")
                } else {
                    safe_runtime_id_component(&safe_version, "version")
                }
            );
            let mut package_metadata = BTreeMap::new();
            package_metadata.insert("package".into(), safe_package_name.clone());
            package_metadata.insert("version".into(), safe_version.clone());
            package_metadata.insert("scope".into(), safe_scope.clone());
            package_metadata.insert(
                "serviceEntityKind".into(),
                service_entity_kind_name(&ServiceEntityKind::PackageDependency).into(),
            );
            nodes.push(RuntimeMapNode {
                id: package_id.clone(),
                provider: RuntimeProviderKind::Npm,
                kind: RuntimeNodeKind::PackageDependency,
                label: safe_package_name.clone(),
                status: None,
                layer: Some(RuntimeNodeLayer::Package),
                metadata: package_metadata,
                service: None,
                package: Some(RuntimePackageEntity::minimal(
                    safe_package_name.clone(),
                    safe_version.clone(),
                )),
            });
            let mut dependency_metadata = BTreeMap::new();
            dependency_metadata.insert("version".into(), safe_version);
            dependency_metadata.insert("scope".into(), safe_scope);
            edges.push(RuntimeMapEdge {
                source: node_id.clone(),
                target: package_id,
                relationship: RuntimeRelationshipKind::DependsOn,
                metadata: dependency_metadata,
            });
        }
    }
}

fn discover_npm_projects(
    project_root: &Path,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) -> Vec<NpmProjectSummary> {
    let mut projects = Vec::new();
    let mut pending = vec![project_root.to_path_buf()];
    let mut visited_dirs = 0usize;
    while let Some(directory) = pending.pop() {
        visited_dirs += 1;
        if visited_dirs > MAX_DISCOVERY_DIRS {
            push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Npm,
                DiagnosticSeverity::Info,
                format!("npm discovery capped at {MAX_DISCOVERY_DIRS} directories"),
            );
            break;
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                push_provider_diagnostic(
                    diagnostics,
                    RuntimeProviderKind::Npm,
                    DiagnosticSeverity::Info,
                    format!("npm discovery skipped `{}`: {error}", directory.display()),
                );
                continue;
            }
        };
        let mut child_dirs = Vec::new();
        let mut has_package_json = false;
        let mut lockfiles = Vec::new();
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            if file_type.is_dir() {
                if !should_skip_discovery_dir(&name) {
                    child_dirs.push(path);
                }
            } else if file_type.is_file() {
                if name == "package.json" {
                    has_package_json = true;
                } else if is_node_lockfile(&name) {
                    lockfiles.push(name);
                }
            }
        }
        child_dirs.sort();
        pending.extend(child_dirs.into_iter().rev());
        if !has_package_json && lockfiles.is_empty() {
            continue;
        }
        if projects.len() >= MAX_NPM_PROJECTS {
            push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Npm,
                DiagnosticSeverity::Info,
                format!("npm discovery capped at {MAX_NPM_PROJECTS} projects"),
            );
            break;
        }
        match summarize_npm_project(project_root, &directory, &lockfiles) {
            Ok(Some(project)) => projects.push(project),
            Ok(None) => {}
            Err(error) => push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Npm,
                DiagnosticSeverity::Warning,
                format!("npm project `{}` skipped: {error}", directory.display()),
            ),
        }
    }
    projects.sort_by(|left, right| left.directory.cmp(&right.directory));
    projects
}

fn summarize_npm_project(
    project_root: &Path,
    directory: &Path,
    lockfiles: &[String],
) -> Result<Option<NpmProjectSummary>, String> {
    let manifest = read_package_manifest_beneath(project_root, directory)?;
    if manifest.is_none() && lockfiles.is_empty() {
        return Ok(None);
    }
    let relative_path = directory
        .strip_prefix(project_root)
        .unwrap_or(directory)
        .display()
        .to_string();
    let display_name = manifest
        .as_ref()
        .and_then(|value| value.name.clone())
        .or_else(|| {
            directory
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string)
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if relative_path.is_empty() {
                "project-root".into()
            } else {
                relative_path.clone()
            }
        });
    let dependencies = manifest
        .as_ref()
        .map(package_manifest_dependencies)
        .unwrap_or_default();
    let (kind, service_entity_kind) = manifest.as_ref().map(classify_package_manifest).unwrap_or((
        RuntimeNodeKind::NodeApplication,
        ServiceEntityKind::NodeApplication,
    ));
    let scripts = manifest
        .as_ref()
        .map(|value| bounded_package_scripts(&value.scripts))
        .unwrap_or_default();
    let framework_hints = manifest
        .as_ref()
        .map(classify_package_frameworks)
        .unwrap_or_default();
    Ok(Some(NpmProjectSummary {
        directory: directory.to_path_buf(),
        package_name: manifest
            .as_ref()
            .and_then(|value| value.name.clone())
            .map(|value| redact_sensitive_text(&value)),
        display_name: redact_sensitive_text(&display_name),
        kind,
        service_entity_kind,
        package_manager: manifest
            .as_ref()
            .and_then(|value| value.package_manager.clone())
            .map(|value| redact_sensitive_text(&value)),
        lockfiles: lockfiles.to_vec(),
        dependencies,
        scripts,
        framework_hints,
        private: manifest
            .as_ref()
            .map(|value| value.private)
            .unwrap_or(false),
    }))
}

fn bounded_package_scripts(scripts: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    scripts
        .iter()
        .take(MAX_NPM_SCRIPTS)
        .map(|(name, script)| {
            (
                redact_sensitive_text(name),
                truncate_chars(&redact_sensitive_text(script), MAX_SCRIPT_CHARS),
            )
        })
        .collect()
}

const FRAMEWORK_MARKERS: &[(&str, &str)] = &[
    ("@nestjs/core", "NestJS"),
    ("@remix-run/react", "Remix"),
    ("@sveltejs/kit", "SvelteKit"),
    ("@vitejs/plugin-react", "Vite"),
    ("angular/core", "Angular"),
    ("astro", "Astro"),
    ("docusaurus", "Docusaurus"),
    ("electron", "Electron"),
    ("expo", "Expo"),
    ("express", "Express"),
    ("fastify", "Fastify"),
    ("gatsby", "Gatsby"),
    ("hono", "Hono"),
    ("next", "Next.js"),
    ("nuxt", "Nuxt"),
    ("react", "React"),
    ("solid-js", "Solid"),
    ("svelte", "Svelte"),
    ("tauri", "Tauri"),
    ("vite", "Vite"),
    ("vue", "Vue"),
];
fn classify_package_frameworks(manifest: &PackageManifestDocument) -> Vec<String> {
    let mut haystacks = manifest.scripts.keys().cloned().collect::<Vec<_>>();
    for section in [
        &manifest.dependencies,
        &manifest.dev_dependencies,
        &manifest.optional_dependencies,
        &manifest.peer_dependencies,
    ] {
        haystacks.extend(section.keys().cloned());
    }
    let mut hints = Vec::new();
    for (marker, name) in FRAMEWORK_MARKERS {
        if hints.len() >= 4 {
            break;
        }
        if haystacks.iter().any(|value| value.contains(marker))
            && !hints.contains(&name.to_string())
        {
            hints.push(name.to_string());
        }
    }
    hints
}
/// Opens a package manifest descriptor-relatively from the configured project
/// root. Every directory component and the final file use O_NOFOLLOW, so a
/// symlink (including one swapped in after discovery) cannot redirect npm
/// collection outside that root.
fn read_package_manifest_beneath(
    project_root: &Path,
    directory: &Path,
) -> Result<Option<PackageManifestDocument>, String> {
    let relative_directory = directory.strip_prefix(project_root).map_err(|_| {
        format!(
            "npm project `{}` is outside configured project root",
            directory.display()
        )
    })?;
    let canonical_root = fs::canonicalize(project_root)
        .map_err(|error| format!("cannot resolve configured project root: {error}"))?;
    let mut parent = open_canonical_directory_no_follow(&canonical_root)?;

    for component in relative_directory.components() {
        let Component::Normal(component) = component else {
            return Err("npm project path is ambiguous".into());
        };
        parent = open_directory_at_no_follow(&parent, component)?;
    }

    let file = match open_file_at_no_follow(&parent, "package.json") {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("cannot open package manifest: {error}")),
    };
    let metadata = file
        .metadata()
        .map_err(|error| format!("cannot inspect package manifest: {error}"))?;
    if !metadata.is_file() {
        return Err("package manifest is not a regular file".into());
    }
    if metadata.len() > MAX_PACKAGE_JSON_BYTES {
        return Err(format!(
            "package manifest exceeds {MAX_PACKAGE_JSON_BYTES} bytes"
        ));
    }
    let mut content = String::new();
    let mut reader = file.take(MAX_PACKAGE_JSON_BYTES.saturating_add(1));
    reader
        .read_to_string(&mut content)
        .map_err(|error| format!("cannot read package manifest: {error}"))?;
    if content.len() > MAX_PACKAGE_JSON_BYTES as usize {
        return Err(format!(
            "package manifest exceeds {MAX_PACKAGE_JSON_BYTES} bytes"
        ));
    }
    serde_json::from_str(&content)
        .map(Some)
        .map_err(|error| format!("invalid package manifest JSON: {error}"))
}

fn open_canonical_directory_no_follow(path: &Path) -> Result<fs::File, String> {
    if !path.is_absolute() {
        return Err("configured project root is not absolute".into());
    }
    let mut current =
        fs::File::open("/").map_err(|error| format!("cannot open filesystem root: {error}"))?;
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(component) => {
                current = open_directory_at_no_follow(&current, component)?;
            }
            _ => return Err("configured project root is ambiguous".into()),
        }
    }
    Ok(current)
}

fn open_directory_at_no_follow(
    parent: &fs::File,
    name: &std::ffi::OsStr,
) -> Result<fs::File, String> {
    let name = CString::new(name.as_bytes()).map_err(|_| "npm project path contains NUL")?;
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        return Err(format!(
            "cannot open npm project directory: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: openat returned an owned non-negative descriptor.
    Ok(unsafe { fs::File::from_raw_fd(descriptor) })
}

fn open_file_at_no_follow(parent: &fs::File, name: &str) -> std::io::Result<fs::File> {
    let name = CString::new(name).expect("fixed package manifest filename has no NUL");
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
        )
    };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: openat returned an owned non-negative descriptor.
    Ok(unsafe { fs::File::from_raw_fd(descriptor) })
}
fn package_manifest_dependencies(
    manifest: &PackageManifestDocument,
) -> Vec<PackageDependencyRecord> {
    let mut dependencies = Vec::new();
    collect_dependency_scope("dependencies", &manifest.dependencies, &mut dependencies);
    collect_dependency_scope(
        "optional_dependencies",
        &manifest.optional_dependencies,
        &mut dependencies,
    );
    collect_dependency_scope(
        "peer_dependencies",
        &manifest.peer_dependencies,
        &mut dependencies,
    );
    collect_dependency_scope(
        "dev_dependencies",
        &manifest.dev_dependencies,
        &mut dependencies,
    );
    dependencies.truncate(MAX_NPM_DEPENDENCIES_PER_PROJECT);
    dependencies
}
fn collect_dependency_scope(
    scope: &str,
    entries: &BTreeMap<String, String>,
    output: &mut Vec<PackageDependencyRecord>,
) {
    for (name, version) in entries {
        output.push(PackageDependencyRecord {
            name: redact_sensitive_text(name),
            version: redact_sensitive_text(version),
            scope: scope.to_string(),
        });
    }
}
fn classify_package_manifest(
    manifest: &PackageManifestDocument,
) -> (RuntimeNodeKind, ServiceEntityKind) {
    let mut haystack = Vec::new();
    if let Some(name) = &manifest.name {
        haystack.push(name.to_ascii_lowercase());
    }
    haystack.extend(
        manifest
            .scripts
            .keys()
            .map(|value| value.to_ascii_lowercase()),
    );
    haystack.extend(
        manifest
            .scripts
            .values()
            .map(|value| value.to_ascii_lowercase()),
    );
    haystack.extend(
        manifest
            .dependencies
            .keys()
            .chain(manifest.optional_dependencies.keys())
            .chain(manifest.peer_dependencies.keys())
            .chain(manifest.dev_dependencies.keys())
            .map(|value| value.to_ascii_lowercase()),
    );
    if haystack.iter().any(|value| looks_like_ai_agent(value)) {
        (RuntimeNodeKind::AiAgent, ServiceEntityKind::AiAgent)
    } else {
        (
            RuntimeNodeKind::NodeApplication,
            ServiceEntityKind::NodeApplication,
        )
    }
}
fn should_skip_discovery_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".hg"
            | ".svn"
            | "node_modules"
            | "dist"
            | "build"
            | "target"
            | "coverage"
            | ".next"
            | ".turbo"
            | ".yarn"
            | ".pnpm-store"
            | ".venv"
            | "venv"
            | "__pycache__"
    )
}
fn is_node_lockfile(name: &str) -> bool {
    matches!(
        name,
        "package-lock.json" | "npm-shrinkwrap.json" | "pnpm-lock.yaml" | "yarn.lock"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect_fixture_projects(
        pid_namespace: PidNamespaceScope,
    ) -> (
        Vec<RuntimeMapNode>,
        Vec<RuntimeMapEdge>,
        Vec<RuntimeMapDiagnostic>,
    ) {
        let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/providers/redaction");
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut diagnostics = Vec::new();
        collect_npm_projects(
            &project_root,
            pid_namespace,
            &mut nodes,
            &mut edges,
            &mut diagnostics,
        );
        (nodes, edges, diagnostics)
    }

    #[test]
    fn redacts_npm_package_fixture_output() {
        let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/providers/redaction");
        let npmrc =
            fs::read_to_string(project_root.join("npm-app/.npmrc")).expect("fixture .npmrc");
        assert!(npmrc.contains("DOCKERMAP_TEST_FAKE_NPMRC_TOKEN"));

        let (mut nodes, mut edges, mut diagnostics) =
            collect_fixture_projects(PidNamespaceScope::Host { diagnostic: None });
        redact_runtime_nodes(&mut nodes);
        redact_runtime_edges(&mut edges);
        redact_runtime_diagnostics(&mut diagnostics);
        assert!(nodes.iter().any(|node| {
            node.metadata.get("version").map(String::as_str) == Some(REDACTED_VALUE)
        }));
        let serialized = serde_json::to_string(&(&nodes, &edges, &diagnostics))
            .expect("npm provider output serializes");
        for sentinel in [
            "DOCKERMAP_TEST_FAKE_NPM_SCRIPT_TOKEN",
            "DOCKERMAP_TEST_FAKE_NPM_URL_TOKEN",
            "DOCKERMAP_TEST_FAKE_NPM_QUERY_TOKEN",
            "DOCKERMAP_TEST_FAKE_NPMRC_TOKEN",
            "DOCKERMAP_TEST_FAKE_PATH_TOKEN",
        ] {
            assert!(
                !serialized.contains(sentinel),
                "npm provider output leaked {sentinel}"
            );
        }
    }

    #[test]
    fn npm_dependency_nodes_carry_package_entity_and_layer() {
        let (nodes, _, _) = collect_fixture_projects(PidNamespaceScope::Host { diagnostic: None });
        let dependency = nodes
            .iter()
            .find(|node| node.kind == RuntimeNodeKind::PackageDependency)
            .expect("npm fixture should yield dependency nodes");
        assert_eq!(dependency.layer, Some(RuntimeNodeLayer::Package));
        let package = dependency
            .package
            .as_ref()
            .expect("dependency nodes carry a package entity");
        assert_eq!(package.manager, dockermap_core::RuntimePackageManager::Npm);
        assert!(!package.name.is_empty());
        assert!(!package.version.is_empty());
        assert_eq!(
            dependency.metadata.get("version").map(String::as_str),
            Some(package.version.as_str()),
            "package entity version matches the node metadata"
        );
    }

    #[test]
    fn restricted_pid_namespace_omits_host_edges() {
        let (_, edges, _) = collect_fixture_projects(PidNamespaceScope::Restricted);
        assert!(edges.iter().all(|edge| {
            !(edge.relationship == RuntimeRelationshipKind::RunsOn && edge.target == "host_local")
        }));
    }

    #[test]
    fn npm_discovery_reads_regular_manifests_under_the_configured_root() {
        let project_root = tempfile::tempdir().expect("temporary npm project root");
        let application = project_root.path().join("application");
        fs::create_dir(&application).expect("application directory");
        fs::write(
            application.join("package.json"),
            r#"{"name":"ordinary-in-root-app","dependencies":{"hono":"^4"}}"#,
        )
        .expect("ordinary package manifest");
        let mut diagnostics = Vec::new();

        let projects = discover_npm_projects(project_root.path(), &mut diagnostics);

        assert_eq!(projects.len(), 1);
        assert_eq!(
            projects[0].package_name.as_deref(),
            Some("ordinary-in-root-app")
        );
        assert!(diagnostics.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn npm_discovery_rejects_manifests_symlinked_outside_the_configured_root() {
        let project_root = tempfile::tempdir().expect("temporary npm project root");
        let outside_root = tempfile::tempdir().expect("temporary outside root");
        let application = project_root.path().join("application");
        fs::create_dir(&application).expect("application directory");
        fs::write(application.join("package-lock.json"), "{}")
            .expect("lockfile keeps this directory eligible for discovery");
        let outside_manifest = outside_root.path().join("package.json");
        fs::write(&outside_manifest, r#"{"name":"must-not-be-read"}"#).expect("outside manifest");
        std::os::unix::fs::symlink(&outside_manifest, application.join("package.json"))
            .expect("manifest symlink");
        let mut diagnostics = Vec::new();

        let projects = discover_npm_projects(project_root.path(), &mut diagnostics);

        assert!(projects.is_empty(), "symlinked manifests fail closed");
        assert!(diagnostics.iter().any(|diagnostic| {
            diagnostic.provider == RuntimeProviderKind::Npm
                && diagnostic.severity == DiagnosticSeverity::Warning
                && diagnostic.message.contains("cannot open package manifest")
        }));
    }

    #[cfg(unix)]
    #[test]
    fn npm_manifest_open_rejects_parent_directory_symlink_escapes() {
        let project_root = tempfile::tempdir().expect("temporary npm project root");
        let outside_root = tempfile::tempdir().expect("temporary outside root");
        fs::write(
            outside_root.path().join("package.json"),
            r#"{"name":"must-not-be-read"}"#,
        )
        .expect("outside manifest");
        let linked_application = project_root.path().join("application");
        std::os::unix::fs::symlink(outside_root.path(), &linked_application)
            .expect("parent directory symlink");

        let error = read_package_manifest_beneath(project_root.path(), &linked_application)
            .expect_err("parent symlink must not be followed");

        assert!(error.contains("cannot open npm project directory"));
    }

    #[cfg(unix)]
    #[test]
    fn npm_manifest_open_rejects_fifos_without_reading_them() {
        let project_root = tempfile::tempdir().expect("temporary npm project root");
        let application = project_root.path().join("application");
        fs::create_dir(&application).expect("application directory");
        let fifo = application.join("package.json");
        let fifo_name =
            std::ffi::CString::new(fifo.as_os_str().as_bytes()).expect("temporary path has no NUL");
        assert_eq!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) }, 0);

        let error = read_package_manifest_beneath(project_root.path(), &application)
            .expect_err("FIFO must be rejected without blocking");

        assert_eq!(error, "package manifest is not a regular file");
    }

    #[test]
    fn classifies_ai_package_manifests() {
        let manifest = PackageManifestDocument {
            name: Some("agent-control".into()),
            private: true,
            package_manager: Some("npm@10".into()),
            scripts: BTreeMap::from([("start".into(), "node agent.js".into())]),
            dependencies: BTreeMap::from([
                ("openai".into(), "^4.0.0".into()),
                ("langchain".into(), "^0.3.0".into()),
            ]),
            optional_dependencies: BTreeMap::new(),
            peer_dependencies: BTreeMap::new(),
            dev_dependencies: BTreeMap::new(),
        };
        assert_eq!(
            classify_package_manifest(&manifest),
            (RuntimeNodeKind::AiAgent, ServiceEntityKind::AiAgent)
        );
        let dependencies = package_manifest_dependencies(&manifest);
        assert_eq!(dependencies.len(), 2);
        assert_eq!(dependencies[0].scope, "dependencies");
    }
    #[test]
    fn skips_conservative_discovery_directories() {
        assert!(should_skip_discovery_dir("node_modules"));
        assert!(should_skip_discovery_dir(".next"));
        assert!(!should_skip_discovery_dir("services"));
        assert!(is_node_lockfile("package-lock.json"));
        assert!(!is_node_lockfile("Cargo.lock"));
    }
    #[test]
    fn classifies_package_framework_hints_and_bounds_scripts() {
        let manifest = PackageManifestDocument {
            name: Some("web-dashboard".into()),
            private: true,
            package_manager: Some("pnpm@9".into()),
            scripts: (0..32)
                .map(|index| (format!("script-{index}"), format!("echo step {index}")))
                .collect(),
            dependencies: BTreeMap::from([
                ("next".into(), "^15.0.0".into()),
                ("react".into(), "^19.0.0".into()),
                ("express".into(), "^4.19.0".into()),
                ("fastify".into(), "^5.0.0".into()),
            ]),
            optional_dependencies: BTreeMap::new(),
            peer_dependencies: BTreeMap::new(),
            dev_dependencies: BTreeMap::from([("vite".into(), "^6.0.0".into())]),
        };
        let hints = classify_package_frameworks(&manifest);
        assert!(hints.contains(&"Next.js".to_string()));
        assert!(hints.contains(&"React".to_string()));
        assert!(
            hints.len() <= 4,
            "framework hints must stay bounded, got {hints:?}"
        );
        let bounded = bounded_package_scripts(&manifest.scripts);
        assert_eq!(bounded.len(), MAX_NPM_SCRIPTS);
        assert_eq!(bounded.get("script-0"), Some(&"echo step 0".to_string()));
    }
}
