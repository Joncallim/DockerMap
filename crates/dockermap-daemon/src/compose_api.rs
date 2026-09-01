//! Read-only Compose CLI and HTTP request boundary.
//!
//! This module owns only request selection, project-root confinement, and
//! Compose-specific response errors. Parsing and dry-run edit planning remain
//! in `dockermap-core`; publication redaction remains in `publication`.

use crate::{
    config::project_root,
    publication::{redact_compose_edit_plan, redact_compose_scan, redact_runtime_display_text},
    ApiError, AppState,
};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use dockermap_core::{
    correlate_compose_runtime, derive_compose_graph, discover_compose_files,
    plan_compose_mount_edit, scan_compose_files, ComposeDiagnostic, ComposeEditPlan, ComposeGraph,
    ComposeScan, DiagnosticSeverity,
};
use serde::Deserialize;
use std::{
    fs,
    path::{Component, Path as StdPath, PathBuf},
};

pub(crate) const MAX_COMPOSE_FILES: usize = 8;
pub(crate) const MAX_COMPOSE_FILE_CHARS: usize = 512;
const MAX_COMPOSE_SERVICE_CHARS: usize = 128;

#[derive(Debug, Deserialize)]
pub(crate) struct ComposeScanQuery {
    file: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ComposeEditPlanQuery {
    file: String,
    service: String,
    mount: usize,
    source: Option<String>,
    target: Option<String>,
}

fn compose_file_unavailable(diagnostic: String) -> ApiError {
    eprintln!(
        "Compose request unavailable: {}",
        redact_runtime_display_text(&diagnostic)
    );
    ApiError {
        status: StatusCode::BAD_REQUEST,
        message: "requested Compose file is unavailable".into(),
    }
}

fn compose_inspection_unavailable(diagnostic: String) -> ApiError {
    eprintln!(
        "Compose inspection unavailable: {}",
        redact_runtime_display_text(&diagnostic)
    );
    ApiError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        message: "Compose inspection is unavailable".into(),
    }
}

fn compose_scan_unavailable(diagnostic: String) -> ApiError {
    eprintln!(
        "Compose scan unavailable: {}",
        redact_runtime_display_text(&diagnostic)
    );
    ApiError {
        status: StatusCode::BAD_REQUEST,
        message: "Compose scan is unavailable".into(),
    }
}

pub(crate) async fn get_compose_scan(
    State(state): State<AppState>,
    Query(query): Query<ComposeScanQuery>,
) -> Result<Json<ComposeScan>, ApiError> {
    let mut scan = scan_compose_query(query).await?;
    let cache = state.cache.read().await;
    scan.correlations = correlate_compose_runtime(&scan, &cache.snapshot);
    redact_compose_scan(&mut scan);
    Ok(Json(scan))
}

pub(crate) async fn get_compose_graph(
    Query(query): Query<ComposeScanQuery>,
) -> Result<Json<ComposeGraph>, ApiError> {
    let mut scan = scan_compose_query(query).await?;
    // Bind sources are embedded in graph node ids and labels, so redact before
    // graph derivation rather than allowing mount-source text to escape.
    redact_compose_scan(&mut scan);
    Ok(Json(derive_compose_graph(&scan)))
}

pub(crate) async fn get_compose_edit_plan(
    Query(query): Query<ComposeEditPlanQuery>,
) -> Result<Json<ComposeEditPlan>, ApiError> {
    let project_root = project_root().map_err(compose_inspection_unavailable)?;
    let file =
        resolve_scannable_file(&project_root, &query.file).map_err(compose_file_unavailable)?;
    let service = validate_required_value(&query.service, "service", MAX_COMPOSE_SERVICE_CHARS)?;
    let source =
        validate_optional_query(query.source.as_deref(), "source", MAX_COMPOSE_FILE_CHARS)?;
    let target =
        validate_optional_query(query.target.as_deref(), "target", MAX_COMPOSE_FILE_CHARS)?;
    let scan = scan_compose_files(&project_root, std::slice::from_ref(&file))
        .map_err(compose_scan_unavailable)?;
    let mount = scan
        .mounts
        .iter()
        .find(|mount| {
            mount.service == service
                && mount
                    .origin
                    .field
                    .ends_with(&format!(".volumes[{}]", query.mount))
        })
        .ok_or(ApiError {
            status: StatusCode::NOT_FOUND,
            message: format!("mount {} for service `{service}` not found", query.mount),
        })?;
    let content = fs::read_to_string(&file).map_err(|error| {
        compose_file_unavailable(format!(
            "failed to read compose file `{}`: {error}",
            file.display()
        ))
    })?;

    let mut plan = plan_compose_mount_edit(&file, &content, mount, source, target);
    redact_compose_edit_plan(&mut plan);
    Ok(Json(plan))
}

async fn scan_compose_query(query: ComposeScanQuery) -> Result<ComposeScan, ApiError> {
    let project_root = project_root().map_err(compose_inspection_unavailable)?;
    let files = match query.file {
        Some(value) if !value.trim().is_empty() => parse_compose_file_query(&value)?
            .iter()
            .map(|value| resolve_scannable_file(&project_root, value))
            .collect::<Result<Vec<_>, _>>()
            .map_err(compose_file_unavailable)?,
        _ => discover_compose_files(&project_root)
            .iter()
            .map(|path| {
                let requested = path
                    .strip_prefix(&project_root)
                    .unwrap_or(path)
                    .to_string_lossy();
                resolve_scannable_file(&project_root, &requested)
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(compose_file_unavailable)?,
    };
    scan_compose_files(&project_root, &files).map_err(compose_scan_unavailable)
}

pub(crate) fn run_cli(command: &str, args: &[String]) -> Result<i32, String> {
    let project_root = project_root()?;
    let files = cli_compose_files(&project_root, args)?;
    let scan = scan_compose_files(&project_root, &files)?;
    match command {
        "scan" => {
            print_json(&scan)?;
            Ok(0)
        }
        "validate" => {
            print_json(&scan.diagnostics)?;
            Ok(if has_blocking_diagnostics(&scan.diagnostics) {
                1
            } else {
                0
            })
        }
        "export" => {
            let format = cli_option_value(args, "--format").unwrap_or("json");
            if format != "json" {
                return Err("only `--format json` is supported".into());
            }
            print_json(&scan)?;
            Ok(0)
        }
        _ => Err(format!("unknown command `{command}`")),
    }
}

fn cli_compose_files(project_root: &StdPath, args: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--file" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("`--file` requires a value".into());
                };
                files.push(resolve_scannable_file(project_root, value)?);
                index += 2;
            }
            "--format" => index += 2,
            value => return Err(format!("unknown argument `{value}`")),
        }
    }
    if files.is_empty() {
        discover_compose_files(project_root)
            .iter()
            .map(|path| {
                let requested = path
                    .strip_prefix(project_root)
                    .unwrap_or(path)
                    .to_string_lossy();
                resolve_scannable_file(project_root, &requested)
            })
            .collect()
    } else {
        Ok(files)
    }
}

fn cli_option_value<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|window| window[0] == name)
        .map(|window| window[1].as_str())
}

fn has_blocking_diagnostics(diagnostics: &[ComposeDiagnostic]) -> bool {
    diagnostics.iter().any(|diagnostic| {
        matches!(
            diagnostic.severity,
            DiagnosticSeverity::Error | DiagnosticSeverity::Blocked
        )
    })
}

fn print_json<T: serde::Serialize>(value: &T) -> Result<(), String> {
    let output = serde_json::to_string_pretty(value)
        .map_err(|error| format!("failed to serialize JSON: {error}"))?;
    println!("{output}");
    Ok(())
}

fn resolve_scannable_file(project_root: &StdPath, requested: &str) -> Result<PathBuf, String> {
    if requested.trim().is_empty() || requested.contains('\0') {
        return Err("compose file path is empty or invalid".into());
    }
    let requested_path = StdPath::new(requested);
    if requested_path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(format!(
            "compose file `{requested}` must not contain parent traversal"
        ));
    }
    let candidate = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        project_root.join(requested_path)
    };
    reject_symlink_path(project_root, &candidate)?;
    let canonical = fs::canonicalize(&candidate).map_err(|error| {
        format!(
            "compose file `{}` is not readable: {error}",
            candidate.display()
        )
    })?;
    if !canonical.starts_with(project_root) {
        return Err(format!(
            "compose file `{}` is outside project root `{}`",
            canonical.display(),
            project_root.display()
        ));
    }
    if !canonical.is_file() {
        return Err(format!(
            "compose file `{}` is not a file",
            canonical.display()
        ));
    }
    Ok(canonical)
}

pub(crate) fn parse_compose_file_query(value: &str) -> Result<Vec<String>, ApiError> {
    let files = value.split(',').map(str::trim).filter(|value| !value.is_empty()).map(|value| {
        if value.len() > MAX_COMPOSE_FILE_CHARS || value.contains('\0') {
            return Err(ApiError { status: StatusCode::BAD_REQUEST, message: format!("compose file query values must be {MAX_COMPOSE_FILE_CHARS} characters or fewer") });
        }
        Ok(value.to_string())
    }).collect::<Result<Vec<_>, _>>()?;
    if files.len() > MAX_COMPOSE_FILES {
        return Err(ApiError {
            status: StatusCode::BAD_REQUEST,
            message: format!("compose scan accepts at most {MAX_COMPOSE_FILES} files"),
        });
    }
    Ok(files)
}

fn validate_optional_query<'a>(
    value: Option<&'a str>,
    name: &str,
    max_chars: usize,
) -> Result<Option<&'a str>, ApiError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > max_chars || value.contains('\0') {
        return Err(ApiError {
            status: StatusCode::BAD_REQUEST,
            message: format!("query parameter `{name}` must be {max_chars} characters or fewer"),
        });
    }
    Ok(Some(value))
}

fn validate_required_value<'a>(
    value: &'a str,
    name: &str,
    max_chars: usize,
) -> Result<&'a str, ApiError> {
    validate_optional_query(Some(value), name, max_chars)?.ok_or(ApiError {
        status: StatusCode::BAD_REQUEST,
        message: format!("query parameter `{name}` is required"),
    })
}

fn reject_symlink_path(project_root: &StdPath, canonical: &StdPath) -> Result<(), String> {
    let relative = canonical.strip_prefix(project_root).map_err(|_| {
        format!(
            "compose file `{}` is outside project root `{}`",
            canonical.display(),
            project_root.display()
        )
    })?;
    let mut current = project_root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| format!("cannot inspect `{}`: {error}", current.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "compose file path `{}` contains a symlink; refusing to follow it",
                current.display()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_too_many_compose_files() {
        let value = (0..=MAX_COMPOSE_FILES)
            .map(|index| format!("compose-{index}.yaml"))
            .collect::<Vec<_>>()
            .join(",");
        let error = parse_compose_file_query(&value).expect_err("too many files should fail");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn cli_rejects_unknown_format() {
        let args = vec!["--format".to_string(), "yaml".to_string()];
        let error = run_cli("export", &args).expect_err("yaml export should fail");
        assert!(error.contains("only `--format json`"));
    }

    #[test]
    fn compose_file_selection_rejects_parent_traversal_before_filesystem_access() {
        let root = tempfile::tempdir().expect("temporary project root");
        let error = resolve_scannable_file(root.path(), "../compose.yaml")
            .expect_err("parent traversal must be rejected");
        assert_eq!(
            error,
            "compose file `../compose.yaml` must not contain parent traversal"
        );
    }

    #[cfg(unix)]
    #[test]
    fn compose_file_selection_rejects_leaf_symlinks() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().expect("temporary project root");
        let outside = tempfile::NamedTempFile::new().expect("outside compose file");
        symlink(outside.path(), root.path().join("compose.yaml"))
            .expect("fixture symlink should be created");

        let error = resolve_scannable_file(root.path(), "compose.yaml")
            .expect_err("symlink must not be followed");
        assert!(error.contains("contains a symlink; refusing to follow it"));
    }
}
