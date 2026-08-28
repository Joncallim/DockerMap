//! Daemon-route bearer authentication.
//!
//! This boundary is intentionally small: configuration creates the optional
//! token, while this module only authenticates an incoming Axum request.

use crate::config::DaemonAuthToken;
use axum::{
    extract::{Request, State},
    http::{header::AUTHORIZATION, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};

pub(crate) async fn require_daemon_bearer_token(
    State(daemon_token): State<DaemonAuthToken>,
    request: Request,
    next: Next,
) -> Response {
    let Some(expected) = daemon_token.0.as_deref() else {
        return next.run(request).await;
    };
    let received = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            let mut parts = value.split_whitespace();
            match (parts.next(), parts.next(), parts.next()) {
                (Some("Bearer"), Some(token), None) => Some(token),
                _ => None,
            }
        });

    if received.is_some_and(|token| daemon_token_matches(token, expected)) {
        next.run(request).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "code": "unauthorized",
                "message": "A valid Bearer token is required for this DockerMap daemon route"
            })),
        )
            .into_response()
    }
}

fn daemon_token_matches(received: &str, expected: &str) -> bool {
    if received.len() != expected.len() {
        return false;
    }

    received
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

#[cfg(test)]
mod tests {
    use super::daemon_token_matches;

    #[test]
    fn daemon_token_comparison_requires_an_exact_value() {
        assert!(daemon_token_matches(
            "same-length-token",
            "same-length-token"
        ));
        assert!(!daemon_token_matches(
            "same-length-tokex",
            "same-length-token"
        ));
        assert!(!daemon_token_matches("short", "same-length-token"));
    }
}
