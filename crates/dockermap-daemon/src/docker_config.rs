//! Docker collector configuration.
//!
//! The collector is deliberately configured with the filtered Docker Read
//! Gateway socket. This module owns the parsing boundary so reconnect paths
//! cannot quietly rediscover Docker's raw default socket.

pub const MAX_DOCKER_LABEL_FILTER_CHARS: usize = 256;
pub const DEFAULT_DOCKER_GATEWAY_SOCKET: &str = "/run/dockermap/docker-read.sock";

/// Return the collector's one permitted Docker endpoint: the filtered gateway
/// socket. It never falls back to Docker's raw default socket.
pub fn docker_gateway_socket_from_env() -> Result<String, String> {
    let socket = std::env::var("DOCKERMAP_DOCKER_GATEWAY_SOCKET")
        .unwrap_or_else(|_| DEFAULT_DOCKER_GATEWAY_SOCKET.into());
    validate_docker_gateway_socket(socket)
}

pub fn validate_docker_gateway_socket(socket: String) -> Result<String, String> {
    if socket.is_empty() || socket.len() > 512 || socket.contains('\0') {
        return Err("invalid DOCKERMAP_DOCKER_GATEWAY_SOCKET".into());
    }
    if socket == "/var/run/docker.sock" || socket == "/run/docker.sock" {
        return Err("DOCKERMAP_DOCKER_GATEWAY_SOCKET must not name Docker's raw socket".into());
    }
    Ok(socket)
}

pub fn docker_label_filter_from_env() -> Result<Option<String>, String> {
    match std::env::var("DOCKERMAP_DOCKER_LABEL_FILTER") {
        Ok(value) => parse_docker_label_filter(&value)
            .map_err(|message| format!("invalid DOCKERMAP_DOCKER_LABEL_FILTER: {message}")),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => {
            Err("invalid DOCKERMAP_DOCKER_LABEL_FILTER: value must be valid UTF-8".into())
        }
    }
}

pub fn parse_docker_label_filter(value: &str) -> Result<Option<String>, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > MAX_DOCKER_LABEL_FILTER_CHARS {
        return Err(format!(
            "label filter must be {MAX_DOCKER_LABEL_FILTER_CHARS} characters or fewer"
        ));
    }
    if trimmed.contains('\0') {
        return Err("label filter must not contain NUL bytes".into());
    }
    if trimmed.starts_with('=') {
        return Err("label filter key must not be empty".into());
    }
    Ok(Some(trimmed.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_docker_label_filter_values() {
        assert_eq!(
            parse_docker_label_filter(" com.dockermap.fixture ").expect("key-only filter"),
            Some("com.dockermap.fixture".into())
        );
        assert_eq!(
            parse_docker_label_filter("com.dockermap.fixture=run-123").expect("key-value filter"),
            Some("com.dockermap.fixture=run-123".into())
        );
        assert_eq!(
            parse_docker_label_filter("   ").expect("empty filter"),
            None
        );
    }

    #[test]
    fn rejects_invalid_docker_label_filter_values() {
        let oversized = "a".repeat(MAX_DOCKER_LABEL_FILTER_CHARS + 1);
        assert!(parse_docker_label_filter(&oversized).is_err());
        assert!(parse_docker_label_filter("com.dockermap.fixture\0bad").is_err());
        assert!(parse_docker_label_filter("=missing-key").is_err());
    }

    #[test]
    fn collector_endpoint_never_accepts_the_raw_docker_socket() {
        assert_eq!(
            validate_docker_gateway_socket(DEFAULT_DOCKER_GATEWAY_SOCKET.into()).as_deref(),
            Ok(DEFAULT_DOCKER_GATEWAY_SOCKET)
        );
        for raw_socket in ["/var/run/docker.sock", "/run/docker.sock"] {
            assert!(validate_docker_gateway_socket(raw_socket.into()).is_err());
        }
    }
}
