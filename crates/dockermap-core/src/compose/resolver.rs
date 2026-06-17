//! Resolves relative paths and `${VAR}` references in bind mounts.

use std::path::{Component, Path, PathBuf};

use super::{
    BindMount, ComposeDiagnostic, ComposeFile, ComposeMountDeclaration, DiagnosticSeverity,
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Walk all [`BindMount`] entries in `file` and fill in `resolved_source`.
///
/// * Relative paths are resolved against `file.project_dir`.
/// * `${VAR}` and `${VAR:-default}` are expanded via [`std::env::var`].
/// * Unresolvable variables produce a `Warning/UNRESOLVED_ENV_VAR` diagnostic.
pub fn resolve_mounts(file: &mut ComposeFile) {
    let project_dir = file.project_dir.clone();
    let file_path = file.path.clone();
    let mut new_diagnostics: Vec<ComposeDiagnostic> = Vec::new();

    for service in &mut file.services {
        for mount in &mut service.mounts {
            if let ComposeMountDeclaration::Bind(bind) = mount {
                resolve_bind_mount(bind, &project_dir, &file_path, &mut new_diagnostics);
            }
        }
    }

    file.diagnostics.extend(new_diagnostics);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn resolve_bind_mount(
    bind: &mut BindMount,
    project_dir: &str,
    source_file: &str,
    diagnostics: &mut Vec<ComposeDiagnostic>,
) {
    // First expand any environment variables in the source string.
    let expanded = match expand_env_vars(&bind.source, source_file, bind.source_line, diagnostics) {
        Some(s) => s,
        None => {
            // Variable was unset with no default — leave resolved_source as None.
            return;
        }
    };

    // Resolve the path relative to project_dir.
    let resolved = resolve_path(&expanded, project_dir);
    bind.resolved_source = Some(resolved.to_string_lossy().to_string());
}

/// Expand `${VAR}` and `${VAR:-default}` patterns in `s`.
///
/// Returns `None` if an unresolvable variable (no default) is encountered.
pub fn expand_env_vars(
    s: &str,
    source_file: &str,
    source_line: Option<usize>,
    diagnostics: &mut Vec<ComposeDiagnostic>,
) -> Option<String> {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch != '$' {
            result.push(ch);
            continue;
        }

        // Expect `{`
        match chars.peek() {
            Some('{') => {
                chars.next(); // consume `{`
            }
            _ => {
                // Not a `${…}` pattern — pass through literally.
                result.push('$');
                continue;
            }
        }

        // Collect everything up to `}`
        let mut inner = String::new();
        let mut closed = false;
        for c in chars.by_ref() {
            if c == '}' {
                closed = true;
                break;
            }
            inner.push(c);
        }

        if !closed {
            // Malformed — push as-is and continue.
            result.push_str("${");
            result.push_str(&inner);
            continue;
        }

        // Parse `VAR` or `VAR:-default`
        let (var_name, default_value) = if let Some(idx) = inner.find(":-") {
            (&inner[..idx], Some(&inner[idx + 2..]))
        } else {
            (inner.as_str(), None)
        };

        match std::env::var(var_name) {
            Ok(val) => result.push_str(&val),
            Err(_) => {
                if let Some(default) = default_value {
                    result.push_str(default);
                } else {
                    diagnostics.push(ComposeDiagnostic {
                        severity: DiagnosticSeverity::Warning,
                        code: "UNRESOLVED_ENV_VAR".to_string(),
                        message: format!("${{{var_name}}} is not set"),
                        file: Some(source_file.to_string()),
                        line: source_line,
                    });
                    return None;
                }
            }
        }
    }

    Some(result)
}

/// Resolve `path_str` against `base_dir`.
///
/// If the path is already absolute it is returned as-is (after normalization).
/// Otherwise it is joined to `base_dir` and normalized.
///
/// Normalization: if the path exists on the filesystem, `canonicalize` is used;
/// otherwise `.` and `..` components are resolved manually.
pub fn resolve_path(path_str: &str, base_dir: &str) -> PathBuf {
    let path = Path::new(path_str);
    let full = if path.is_absolute() {
        path.to_path_buf()
    } else {
        Path::new(base_dir).join(path)
    };

    // Try the real filesystem first.
    if let Ok(canonical) = full.canonicalize() {
        return canonical;
    }

    // Manual normalization for paths that don't yet exist.
    normalize_path(&full)
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut components: Vec<Component> = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {} // skip `.`
            Component::ParentDir => {
                // Pop the last component if it's a normal segment.
                match components.last() {
                    Some(Component::Normal(_)) => {
                        components.pop();
                    }
                    _ => components.push(component),
                }
            }
            other => components.push(other),
        }
    }
    components.iter().collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compose::{BindMount, ComposeFile, ComposeMountDeclaration, ComposeService};
    use std::collections::BTreeMap;

    fn make_file_with_bind(source: &str, project_dir: &str) -> ComposeFile {
        ComposeFile {
            path: format!("{project_dir}/docker-compose.yml"),
            project_dir: project_dir.to_string(),
            services: vec![ComposeService {
                name: "app".to_string(),
                image: None,
                build: None,
                mounts: vec![ComposeMountDeclaration::Bind(BindMount {
                    source: source.to_string(),
                    resolved_source: None,
                    target: "/app".to_string(),
                    read_only: false,
                    source_file: format!("{project_dir}/docker-compose.yml"),
                    source_line: None,
                })],
                depends_on: vec![],
                labels: BTreeMap::new(),
            }],
            named_volumes: vec![],
            diagnostics: vec![],
        }
    }

    fn get_bind(file: &ComposeFile) -> &BindMount {
        match &file.services[0].mounts[0] {
            ComposeMountDeclaration::Bind(b) => b,
            other => panic!("expected Bind, got {other:?}"),
        }
    }

    #[test]
    fn test_resolve_relative_path() {
        let mut file = make_file_with_bind("./src", "/project");
        resolve_mounts(&mut file);
        let bind = get_bind(&file);
        let resolved = bind.resolved_source.as_deref().unwrap();
        assert!(
            resolved.ends_with("/project/src"),
            "expected path ending in /project/src, got {resolved}"
        );
    }

    #[test]
    fn test_resolve_already_absolute() {
        let mut file = make_file_with_bind("/absolute/path", "/project");
        resolve_mounts(&mut file);
        let bind = get_bind(&file);
        let resolved = bind.resolved_source.as_deref().unwrap();
        assert!(
            resolved.starts_with("/absolute/path"),
            "expected absolute path, got {resolved}"
        );
    }

    #[test]
    fn test_resolve_env_var_set() {
        std::env::set_var("DOCKERMAP_TEST_MY_VAR", "foo");
        let mut file = make_file_with_bind("${DOCKERMAP_TEST_MY_VAR}", "/project");
        resolve_mounts(&mut file);
        let bind = get_bind(&file);
        let resolved = bind.resolved_source.as_deref().unwrap();
        assert!(
            resolved.ends_with("foo"),
            "expected path ending in foo, got {resolved}"
        );
        std::env::remove_var("DOCKERMAP_TEST_MY_VAR");
    }

    #[test]
    fn test_resolve_env_var_with_default() {
        // Ensure the variable is NOT set.
        std::env::remove_var("DOCKERMAP_TEST_MISSING_VAR");
        let mut file = make_file_with_bind("${DOCKERMAP_TEST_MISSING_VAR:-./default}", "/project");
        resolve_mounts(&mut file);
        let bind = get_bind(&file);
        let resolved = bind.resolved_source.as_deref().unwrap();
        assert!(
            resolved.ends_with("/project/default"),
            "expected path ending in /project/default, got {resolved}"
        );
    }

    #[test]
    fn test_resolve_env_var_missing() {
        std::env::remove_var("DOCKERMAP_TEST_TRULY_MISSING");
        let mut file = make_file_with_bind("${DOCKERMAP_TEST_TRULY_MISSING}", "/project");
        resolve_mounts(&mut file);
        let bind = get_bind(&file);
        // resolved_source should be None
        assert!(
            bind.resolved_source.is_none(),
            "expected None for unresolvable var"
        );
        // A diagnostic should have been emitted
        let has_diag = file
            .diagnostics
            .iter()
            .any(|d| d.code == "UNRESOLVED_ENV_VAR");
        assert!(has_diag, "expected UNRESOLVED_ENV_VAR diagnostic");
    }

    #[test]
    fn test_normalize_parent_dir() {
        let result = normalize_path(Path::new("/a/b/../c"));
        assert_eq!(result, PathBuf::from("/a/c"));
    }

    #[test]
    fn test_normalize_current_dir() {
        let result = normalize_path(Path::new("/a/./b/./c"));
        assert_eq!(result, PathBuf::from("/a/b/c"));
    }
}
