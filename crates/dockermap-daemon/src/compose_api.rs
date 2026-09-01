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
    extract::{RawQuery, State},
    http::StatusCode,
    Json,
};
use dockermap_core::{
    correlate_compose_runtime, derive_compose_graph, discover_compose_files,
    plan_compose_mount_edit, scan_compose_files, ComposeDiagnostic, ComposeEditPlan, ComposeGraph,
    ComposeScan, DiagnosticSeverity,
};
use std::{
    fs,
    path::{Component, Path as StdPath, PathBuf},
};

pub(crate) const MAX_COMPOSE_FILES: usize = 8;
pub(crate) const MAX_COMPOSE_FILE_CHARS: usize = 512;
const MAX_COMPOSE_SERVICE_CHARS: usize = 128;

#[derive(Debug)]
pub(crate) struct ComposeScanQuery {
    file: Vec<String>,
}

#[derive(Debug)]
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
    RawQuery(raw): RawQuery,
) -> Result<Json<ComposeScan>, ApiError> {
    let query = parse_compose_scan_query(raw.as_deref())?;
    let mut scan = scan_compose_query(query).await?;
    let cache = state.cache.read().await;
    scan.correlations = correlate_compose_runtime(&scan, &cache.snapshot);
    redact_compose_scan(&mut scan);
    Ok(Json(scan))
}

pub(crate) async fn get_compose_graph(
    RawQuery(raw): RawQuery,
) -> Result<Json<ComposeGraph>, ApiError> {
    let query = parse_compose_scan_query(raw.as_deref())?;
    let mut scan = scan_compose_query(query).await?;
    // Bind sources are embedded in graph node ids and labels, so redact before
    // graph derivation rather than allowing mount-source text to escape.
    redact_compose_scan(&mut scan);
    Ok(Json(derive_compose_graph(&scan)))
}

pub(crate) async fn get_compose_edit_plan(
    RawQuery(raw): RawQuery,
) -> Result<Json<ComposeEditPlan>, ApiError> {
    let query = parse_compose_edit_plan_query(raw.as_deref())?;
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
        files if !files.is_empty() => files
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

fn validate_compose_files(files: Vec<String>) -> Result<Vec<String>, ApiError> {
    let files = files.into_iter().map(|value| {
        let value = value.trim();
        if value.is_empty() {
            return Err(ApiError { status: StatusCode::BAD_REQUEST, message: "compose file query values must be non-empty strings".into() });
        }
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

fn malformed_query() -> ApiError {
    ApiError {
        status: StatusCode::BAD_REQUEST,
        message: "invalid request query".into(),
    }
}

fn decode_query(raw: Option<&str>) -> Result<Vec<(String, String)>, ApiError> {
    let raw = raw.unwrap_or("");
    validate_strict_form_urlencoded(raw)?;
    Ok(url::form_urlencoded::parse(raw.as_bytes())
        .into_owned()
        .collect())
}

pub(crate) fn parse_compose_scan_query(raw: Option<&str>) -> Result<ComposeScanQuery, ApiError> {
    let mut files = Vec::new();
    for (name, value) in decode_query(raw)? {
        if name != "file" {
            return Err(malformed_query());
        }
        files.push(value);
    }
    Ok(ComposeScanQuery {
        file: validate_compose_files(files)?,
    })
}

pub(crate) fn parse_compose_edit_plan_query(
    raw: Option<&str>,
) -> Result<ComposeEditPlanQuery, ApiError> {
    let mut values = std::collections::BTreeMap::new();
    for (name, value) in decode_query(raw)? {
        if !matches!(
            name.as_str(),
            "file" | "service" | "mount" | "source" | "target"
        ) || values.insert(name, value).is_some()
        {
            return Err(malformed_query());
        }
    }
    let required = |name: &str, maximum: usize| {
        values
            .get(name)
            .map(String::as_str)
            .and_then(|value| validate_required_raw_query(value, maximum).ok())
            .map(str::to_string)
            .ok_or_else(malformed_query)
    };
    let file = required("file", MAX_COMPOSE_FILE_CHARS)?;
    let service = required("service", MAX_COMPOSE_SERVICE_CHARS)?;
    let mount_text = required("mount", 16)?;
    if !mount_text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(malformed_query());
    }
    let mount = mount_text.parse::<usize>().map_err(|_| malformed_query())?;
    let mut optional = |name: &str| -> Result<Option<String>, ApiError> {
        values
            .remove(name)
            .map(|value| {
                validate_optional_raw_query(&value, MAX_COMPOSE_FILE_CHARS).map(str::to_string)
            })
            .transpose()
    };
    Ok(ComposeEditPlanQuery {
        file,
        service,
        mount,
        source: optional("source")?,
        target: optional("target")?,
    })
}

/// Reject the lossy UTF-8 replacement performed by `form_urlencoded::parse`.
/// The HTTP query is a security boundary, so malformed percent encodings are
/// errors rather than alternate spellings of an allowed request.
fn validate_strict_form_urlencoded(raw: &str) -> Result<(), ApiError> {
    for component in raw.split(['&', '=']) {
        let bytes = component.as_bytes();
        let mut decoded = Vec::with_capacity(bytes.len());
        let mut index = 0;
        while index < bytes.len() {
            match bytes[index] {
                b'+' => {
                    decoded.push(b' ');
                    index += 1;
                }
                b'%' if index + 2 < bytes.len()
                    && bytes[index + 1].is_ascii_hexdigit()
                    && bytes[index + 2].is_ascii_hexdigit() =>
                {
                    let digit = |byte: u8| match byte {
                        b'0'..=b'9' => byte - b'0',
                        b'a'..=b'f' => byte - b'a' + 10,
                        b'A'..=b'F' => byte - b'A' + 10,
                        _ => unreachable!("checked hexadecimal byte"),
                    };
                    decoded.push(digit(bytes[index + 1]) * 16 + digit(bytes[index + 2]));
                    index += 3;
                }
                b'%' => return Err(malformed_query()),
                byte => {
                    decoded.push(byte);
                    index += 1;
                }
            }
        }
        std::str::from_utf8(&decoded).map_err(|_| malformed_query())?;
    }
    Ok(())
}

fn validate_required_raw_query(value: &str, maximum: usize) -> Result<&str, ApiError> {
    let value = validate_optional_raw_query(value, maximum)?;
    if value.is_empty() {
        return Err(malformed_query());
    }
    Ok(value)
}

fn validate_optional_raw_query(value: &str, maximum: usize) -> Result<&str, ApiError> {
    let value = value.trim();
    if value.len() > maximum || value.contains('\0') {
        return Err(malformed_query());
    }
    Ok(value)
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
        let values = (0..=MAX_COMPOSE_FILES)
            .map(|index| format!("compose-{index}.yaml"))
            .collect::<Vec<_>>();
        let error = validate_compose_files(values).expect_err("too many files should fail");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn daemon_compose_query_requires_exact_repeated_file_encoding() {
        let query = parse_compose_scan_query(Some("file=compose.yml&file=compose.override.yml"))
            .expect("repeated file form is allowed");
        assert_eq!(query.file, ["compose.yml", "compose.override.yml"]);
        for raw in [
            "file=compose.yml&unexpected=value",
            "file[]=compose.yml",
            "file=compose.yml%",
            "file=%FF",
            "file=compose.yml&file=",
        ] {
            assert!(
                parse_compose_scan_query(Some(raw)).is_err(),
                "{raw} must fail closed"
            );
        }
    }

    #[test]
    fn daemon_compose_edit_query_rejects_unknown_and_duplicate_scalars() {
        assert!(
            parse_compose_edit_plan_query(Some("file=compose.yml&service=api&mount=0")).is_ok()
        );
        for raw in [
            "file=compose.yml&service=api&mount=0&mount=1",
            "file=compose.yml&service=api&mount=0&unknown=1",
            "file=compose.yml&service=api&mount=0%",
            "file=compose.yml&service=%FF&mount=0",
        ] {
            assert!(
                parse_compose_edit_plan_query(Some(raw)).is_err(),
                "{raw} must fail closed"
            );
        }
    }

    #[test]
    fn daemon_compose_edit_query_uses_the_browser_service_bound_before_file_resolution() {
        let service = "a".repeat(MAX_COMPOSE_SERVICE_CHARS + 1);
        assert!(parse_compose_edit_plan_query(Some(&format!(
            "file=missing-compose.yml&service={service}&mount=0"
        )))
        .is_err());
    }

    #[test]
    fn strict_query_decoder_accepts_valid_unicode() {
        let query = parse_compose_scan_query(Some("file=%E2%9C%93-compose.yml"))
            .expect("valid UTF-8 percent encoding must remain accepted");
        assert_eq!(query.file, ["✓-compose.yml"]);
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
