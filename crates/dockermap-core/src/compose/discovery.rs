//! Discovers Docker Compose files in a directory tree.

use std::path::{Path, PathBuf};

use walkdir::WalkDir;

/// Filenames considered "base" compose files (in priority order for overrides).
const COMPOSE_FILENAMES: &[&str] = &[
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
];

/// Directories to skip during discovery.
const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target"];

/// Walk `root` and collect all Docker Compose base files.
///
/// Results are sorted by depth (files closer to `root` first), then
/// alphabetically within the same depth.
pub fn discover_compose_files(root: &Path) -> Vec<PathBuf> {
    let mut results: Vec<(usize, PathBuf)> = Vec::new();

    let walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            // Skip known heavy / irrelevant directories.
            if entry.file_type().is_dir() {
                let name = entry.file_name().to_string_lossy();
                return !SKIP_DIRS.contains(&name.as_ref());
            }
            true
        });

    for entry in walker.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if COMPOSE_FILENAMES.contains(&name.as_ref()) {
            let depth = entry.depth();
            let path = entry.into_path();
            let abs = if path.is_absolute() {
                path
            } else {
                std::env::current_dir()
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .join(path)
            };
            results.push((depth, abs));
        }
    }

    // Sort: shallower first, then alphabetically within the same depth.
    results.sort_by(|(da, pa), (db, pb)| da.cmp(db).then_with(|| pa.cmp(pb)));

    results.into_iter().map(|(_, p)| p).collect()
}

/// For each discovered base file, optionally pair it with its override file.
///
/// Override file name candidates:
///
/// For `docker-compose.yml` / `docker-compose.yaml`:
///   - `docker-compose.override.yml`
///   - `docker-compose.override.yaml`
///
/// For `compose.yml` / `compose.yaml`:
///   - `compose.override.yml`
///   - `compose.override.yaml`
pub fn discover_with_overrides(root: &Path) -> Vec<(PathBuf, Option<PathBuf>)> {
    discover_compose_files(root)
        .into_iter()
        .map(|base| {
            let override_file = find_override_for(&base);
            (base, override_file)
        })
        .collect()
}

fn find_override_for(base: &Path) -> Option<PathBuf> {
    let dir = base.parent()?;
    let base_name = base.file_name()?.to_string_lossy();

    let override_candidates: &[&str] = if base_name.starts_with("docker-compose") {
        &[
            "docker-compose.override.yml",
            "docker-compose.override.yaml",
        ]
    } else {
        &["compose.override.yml", "compose.override.yaml"]
    };

    for candidate in override_candidates {
        let path = dir.join(candidate);
        if path.exists() {
            return Some(path);
        }
    }

    None
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Returns the repo root (two levels above `crates/dockermap-core`).
    fn repo_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent() // crates/
            .unwrap()
            .parent() // repo root
            .unwrap()
            .to_path_buf()
    }

    #[test]
    fn test_discover_fixtures() {
        let root = repo_root();
        let files = discover_compose_files(&root);

        assert!(
            !files.is_empty(),
            "should discover at least one compose file"
        );

        // The legacy prototype ships a standard docker-compose.yaml that the
        // discovery walk should find.
        let has_legacy = files
            .iter()
            .any(|p| p.to_string_lossy().contains("docker-compose.yaml"));
        assert!(
            has_legacy,
            "should find at least one docker-compose.yaml; found: {files:?}"
        );

        // None of the results should be inside skipped directories.
        for path in &files {
            let s = path.to_string_lossy();
            assert!(
                !s.contains("/node_modules/"),
                "should not include node_modules path: {s}"
            );
            assert!(!s.contains("/.git/"), "should not include .git path: {s}");
            assert!(
                !s.contains("/target/"),
                "should not include target path: {s}"
            );
        }
    }

    #[test]
    fn test_discover_with_overrides() {
        let root = repo_root();
        let pairs = discover_with_overrides(&root);
        assert!(!pairs.is_empty(), "should discover at least one base file");
    }

    #[test]
    fn test_skips_node_modules_and_git() {
        use std::io::Write;
        use tempfile::TempDir;

        let dir = TempDir::new().unwrap();

        // Create a real compose file.
        let real = dir.path().join("docker-compose.yml");
        std::fs::write(&real, "services:\n  app:\n    image: alpine\n").unwrap();

        // Create a compose file inside node_modules (should be skipped).
        let nm = dir.path().join("node_modules");
        std::fs::create_dir_all(&nm).unwrap();
        let nm_compose = nm.join("docker-compose.yml");
        let mut f = std::fs::File::create(&nm_compose).unwrap();
        writeln!(f, "services:\n  app:\n    image: alpine\n").unwrap();

        let found = discover_compose_files(dir.path());
        assert!(
            found.contains(&real),
            "should find root compose file; found: {found:?}"
        );
        assert!(
            !found.contains(&nm_compose),
            "should not find compose file in node_modules; found: {found:?}"
        );
    }

    #[test]
    fn test_result_sorted_by_depth() {
        use tempfile::TempDir;

        let dir = TempDir::new().unwrap();
        let sub = dir.path().join("sub");
        std::fs::create_dir_all(&sub).unwrap();

        let deep = sub.join("docker-compose.yml");
        std::fs::write(&deep, "services:\n  a:\n    image: alpine\n").unwrap();

        let shallow = dir.path().join("compose.yml");
        std::fs::write(&shallow, "services:\n  b:\n    image: alpine\n").unwrap();

        let found = discover_compose_files(dir.path());
        assert_eq!(found.len(), 2);
        // Shallower file should come first.
        assert_eq!(found[0], shallow);
        assert_eq!(found[1], deep);
    }
}
