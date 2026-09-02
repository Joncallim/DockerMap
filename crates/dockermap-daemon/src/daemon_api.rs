//! Read-only daemon HTTP cache and log request boundary.
//!
//! This module owns the routes that publish the daemon cache and the bounded
//! log-query parsing. Collection, cache refresh, and publication sanitizers
//! deliberately remain in their dedicated modules.

use crate::{
    auth::require_daemon_bearer_token,
    cache_refresh::docker_collector,
    compose_api::{get_compose_edit_plan, get_compose_graph, get_compose_scan},
    publication::{
        publish_docker_snapshot, redact_container_record, redact_health_response,
        redact_runtime_display_text,
    },
    AppState, DaemonAuthToken,
};
use axum::{
    extract::{Path, RawQuery, State},
    http::StatusCode,
    middleware,
    response::IntoResponse,
    routing::{any, get},
    Json, Router,
};
use dockermap_core::{
    derive_graph, mock_log_entries, ContainerDetailResponse, ContainersResponse, DockerSnapshot,
    FindingsResponse, GraphResponse, HealthResponse, ImagesResponse, LogCursor, LogsResponse,
    NetworksResponse, RuntimeMap, VolumesResponse, DEFAULT_LOG_PAGE_SIZE, MAX_LOG_PAGE_SIZE,
};

pub(crate) const MAX_LOG_QUERY_CHARS: usize = 256;
const MAX_LOG_SERVICE_CHARS: usize = 128;

#[derive(Debug)]
struct LogsQuery {
    service: Option<String>,
    q: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug)]
pub(crate) struct ApiError {
    pub(crate) status: StatusCode,
    pub(crate) message: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let body = serde_json::json!({
            "code": self.status.as_str(),
            "message": redact_runtime_display_text(&self.message),
        });
        (self.status, Json(body)).into_response()
    }
}

pub(crate) fn daemon_router(state: AppState, daemon_token: DaemonAuthToken) -> Router {
    Router::new()
        .route("/daemon/health", get(get_health))
        .route("/daemon/snapshot", get(get_snapshot))
        .route("/daemon/graph", get(get_graph))
        .route("/daemon/runtime/map", get(get_runtime_map))
        .route("/daemon/findings", get(get_findings))
        .route("/daemon/containers", get(get_containers))
        .route("/daemon/containers/{name}", get(get_container))
        .route("/daemon/images", get(get_images))
        .route("/daemon/networks", get(get_networks))
        .route("/daemon/volumes", get(get_volumes))
        .route("/daemon/logs", get(get_logs))
        .route("/daemon/compose/scan", get(get_compose_scan))
        .route("/daemon/compose/graph", get(get_compose_graph))
        .route("/daemon/compose/edit-plan", get(get_compose_edit_plan))
        .fallback(any(not_found))
        .layer(middleware::from_fn_with_state(
            daemon_token,
            require_daemon_bearer_token,
        ))
        .with_state(state)
}

async fn get_health(State(state): State<AppState>) -> Json<HealthResponse> {
    let cache = state.cache.read().await;
    let mut health = cache.health.clone();
    redact_health_response(&mut health);
    Json(health)
}

async fn get_snapshot(State(state): State<AppState>) -> Json<DockerSnapshot> {
    let cache = state.cache.read().await;
    let mut published = publish_docker_snapshot(&cache.snapshot);
    // Actual source stamp: these bytes came from live Docker collection or
    // the daemon's mock fallback — attested by the cache's runtime mode so
    // the browser can never mistake fabricated sample bytes for host data.
    published.source = Some(cache.health.mode.clone());
    Json(published)
}

async fn get_graph(State(state): State<AppState>) -> Json<GraphResponse> {
    let cache = state.cache.read().await;
    let snapshot = publish_docker_snapshot(&cache.snapshot);
    Json(derive_graph(&snapshot))
}

async fn get_runtime_map(State(state): State<AppState>) -> Json<RuntimeMap> {
    // Served from the refresh cache rather than collecting on the Tokio worker
    // per request.
    let cache = state.cache.read().await;
    let mut runtime_map = cache.runtime_map.clone();
    runtime_map.source = Some(cache.health.mode.clone());
    Json(runtime_map)
}

async fn get_findings(State(state): State<AppState>) -> Json<FindingsResponse> {
    // Findings are cached during refresh immediately after the runtime map is
    // assigned its publication revision; requests never invoke providers.
    let cache = state.cache.read().await;
    Json(cache.findings.clone())
}

async fn get_containers(State(state): State<AppState>) -> Json<ContainersResponse> {
    let cache = state.cache.read().await;
    let snapshot = publish_docker_snapshot(&cache.snapshot);
    Json(ContainersResponse {
        containers: snapshot.containers,
    })
}

async fn get_container(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<ContainerDetailResponse>, ApiError> {
    let cache = state.cache.read().await;
    let mut container = cache
        .snapshot
        .containers
        .iter()
        .find(|item| item.name == name)
        .cloned()
        .ok_or(ApiError {
            status: StatusCode::NOT_FOUND,
            message: format!("container `{name}` not found"),
        })?;
    redact_container_record(&mut container);
    Ok(Json(ContainerDetailResponse(container)))
}

async fn get_images(State(state): State<AppState>) -> Json<ImagesResponse> {
    let cache = state.cache.read().await;
    let snapshot = publish_docker_snapshot(&cache.snapshot);
    Json(ImagesResponse {
        images: snapshot.images,
    })
}

async fn get_networks(State(state): State<AppState>) -> Json<NetworksResponse> {
    let cache = state.cache.read().await;
    let snapshot = publish_docker_snapshot(&cache.snapshot);
    Json(NetworksResponse {
        networks: snapshot.networks,
    })
}

async fn get_volumes(State(state): State<AppState>) -> Json<VolumesResponse> {
    let cache = state.cache.read().await;
    let snapshot = publish_docker_snapshot(&cache.snapshot);
    Json(VolumesResponse {
        volumes: snapshot.volumes,
    })
}

pub(crate) fn docker_log_collection_failed(error: &str) -> ApiError {
    eprintln!(
        "Docker log collection failed: {}",
        redact_runtime_display_text(error)
    );
    ApiError {
        status: StatusCode::BAD_GATEWAY,
        message: "Docker log collection failed".into(),
    }
}

async fn get_logs(
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
) -> Result<Json<LogsResponse>, ApiError> {
    let query = parse_logs_query(raw.as_deref())?;
    let service =
        validate_optional_query(query.service.as_deref(), "service", MAX_LOG_SERVICE_CHARS)?;
    let q = validate_optional_query(query.q.as_deref(), "q", MAX_LOG_QUERY_CHARS)?;
    let cursor = parse_log_cursor(query.cursor.as_deref())?;
    let limit = parse_log_limit(query.limit)?;
    let cache = state.cache.read().await;
    let docker_reachable = cache.health.docker_reachable;
    // Capture the mode with the branch-selection data. A later refresh must
    // not relabel fabricated entries as Docker bytes, or vice versa.
    let mode = cache.health.mode.clone();
    let snapshot = cache.snapshot.clone();
    drop(cache);

    if let Some(service) = service {
        if !snapshot
            .containers
            .iter()
            .any(|container| container.name == service)
        {
            return Err(ApiError {
                status: StatusCode::NOT_FOUND,
                message: format!("container `{service}` not found in current snapshot"),
            });
        }
    }

    let response = if docker_reachable {
        let Some(service) = service else {
            // Live mode has no service-scoped view of all logs. Do not attach
            // fabricated entries to a real inventory.
            return Ok(Json(LogsResponse {
                service: None,
                entries: Vec::new(),
                next_cursor: None,
                source: Some(mode.clone()),
            }));
        };
        let collector = docker_collector(&state)
            .await
            .map_err(|error| docker_log_collection_failed(&error))?;
        collector
            .collect_logs(service, q, cursor, limit)
            .await
            .map_err(|error| docker_log_collection_failed(&error))?
    } else {
        crate::docker_collector::publish_log_response(
            service,
            mock_log_entries(&snapshot, service),
            q,
            cursor,
            limit,
        )
    };

    let mut stamped = response;
    stamped.source = Some(mode);
    Ok(Json(stamped))
}

fn invalid_logs_query() -> ApiError {
    ApiError {
        status: StatusCode::BAD_REQUEST,
        message: "invalid log query".into(),
    }
}

fn parse_logs_query(raw: Option<&str>) -> Result<LogsQuery, ApiError> {
    let raw = raw.unwrap_or("");
    if !strict_form_urlencoded_utf8(raw) {
        return Err(invalid_logs_query());
    }
    let mut values = std::collections::BTreeMap::new();
    for (name, value) in url::form_urlencoded::parse(raw.as_bytes()).into_owned() {
        if !matches!(name.as_str(), "service" | "q" | "cursor" | "limit")
            || values.insert(name, value).is_some()
        {
            return Err(invalid_logs_query());
        }
    }
    let limit = values
        .remove("limit")
        .map(|value| {
            if !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(invalid_logs_query());
            }
            value.parse::<usize>().map_err(|_| invalid_logs_query())
        })
        .transpose()?;
    let service = values.remove("service");
    if service
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some_and(|value| {
            !value
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
        })
    {
        return Err(invalid_logs_query());
    }
    Ok(LogsQuery {
        service,
        q: values.remove("q"),
        cursor: values.remove("cursor"),
        limit,
    })
}

fn strict_form_urlencoded_utf8(raw: &str) -> bool {
    raw.split(['&', '=']).all(|component| {
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
                    let nibble = |byte: u8| match byte {
                        b'0'..=b'9' => byte - b'0',
                        b'a'..=b'f' => byte - b'a' + 10,
                        b'A'..=b'F' => byte - b'A' + 10,
                        _ => unreachable!("checked hexadecimal byte"),
                    };
                    decoded.push(nibble(bytes[index + 1]) * 16 + nibble(bytes[index + 2]));
                    index += 3;
                }
                b'%' => return false,
                byte => {
                    decoded.push(byte);
                    index += 1;
                }
            }
        }
        std::str::from_utf8(&decoded).is_ok()
    })
}

async fn not_found() -> ApiError {
    ApiError {
        status: StatusCode::NOT_FOUND,
        message: "Route not found".into(),
    }
}

pub(crate) fn validate_optional_query<'a>(
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

pub(crate) fn parse_log_cursor(value: Option<&str>) -> Result<Option<LogCursor>, ApiError> {
    validate_optional_query(value, "cursor", 32)?
        .map(|value| {
            LogCursor::parse(value).ok_or_else(|| ApiError {
                status: StatusCode::BAD_REQUEST,
                message: "query parameter `cursor` must be `millis` or `millis:offset`".into(),
            })
        })
        .transpose()
}

pub(crate) fn parse_log_limit(value: Option<usize>) -> Result<usize, ApiError> {
    match value {
        Some(value) if (1..=MAX_LOG_PAGE_SIZE).contains(&value) => Ok(value),
        Some(_) => Err(ApiError {
            status: StatusCode::BAD_REQUEST,
            message: format!("query parameter `limit` must be between 1 and {MAX_LOG_PAGE_SIZE}"),
        }),
        None => Ok(DEFAULT_LOG_PAGE_SIZE),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daemon_log_query_rejects_unknown_duplicate_and_malformed_input() {
        let valid = parse_logs_query(Some("service=api&q=timeout&cursor=123%3A4&limit=5"))
            .expect("bounded documented log query is accepted");
        assert_eq!(valid.service.as_deref(), Some("api"));
        assert_eq!(valid.limit, Some(5));
        for raw in [
            "service=api&service=worker",
            "service=api/../../etc",
            "limit=5&unknown=1",
            "limit=+5",
            "cursor=123%",
            "q=%FF",
            "limit=not-a-number",
        ] {
            assert!(
                parse_logs_query(Some(raw)).is_err(),
                "{raw} must fail closed"
            );
        }
    }

    #[test]
    fn daemon_log_query_keeps_valid_unicode() {
        let valid = parse_logs_query(Some("q=%E2%9C%93"))
            .expect("valid UTF-8 percent encoding must remain accepted");
        assert_eq!(valid.q.as_deref(), Some("✓"));
    }
}
