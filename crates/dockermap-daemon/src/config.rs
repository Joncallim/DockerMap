//! Startup configuration with fail-closed validation.
//!
//! This module owns environment parsing only. It deliberately has no daemon
//! routing or collection dependencies so the loopback and token invariants can
//! be reviewed independently of provider code.

use std::{fs, net::IpAddr, path::PathBuf, sync::Arc};

#[derive(Clone)]
pub(crate) struct DaemonAuthToken(pub(crate) Option<Arc<str>>);

pub(crate) fn project_root() -> Result<PathBuf, String> {
    let root = std::env::var("DOCKERMAP_PROJECT_ROOT").unwrap_or_else(|_| ".".into());
    fs::canonicalize(&root).map_err(|error| format!("invalid project root `{root}`: {error}"))
}

pub(crate) fn read_port_env(name: &str, fallback: u16) -> u16 {
    match std::env::var(name) {
        Ok(value) => value.parse::<u16>().unwrap_or_else(|_| {
            eprintln!("{name} must be an integer from 1 to 65535, got `{value}`");
            std::process::exit(2);
        }),
        Err(_) => fallback,
    }
}

pub(crate) fn read_daemon_token_env() -> DaemonAuthToken {
    let token = read_optional_token_env("DOCKERMAP_DAEMON_TOKEN")
        .or_else(|| read_optional_token_env("DOCKERMAP_API_TOKEN"));
    DaemonAuthToken(token.map(Arc::<str>::from))
}

fn read_optional_token_env(name: &str) -> Option<String> {
    match std::env::var(name) {
        Ok(value) => {
            let token = value.trim();
            if token.is_empty() {
                eprintln!("{name} must not be empty when set");
                std::process::exit(2);
            }
            Some(token.into())
        }
        Err(_) => None,
    }
}

pub(crate) fn read_bind_host_env(name: &str, has_daemon_token: bool) -> IpAddr {
    let value = std::env::var(name).unwrap_or_else(|_| "127.0.0.1".into());
    let allow_remote = std::env::var("DOCKERMAP_ALLOW_REMOTE_DAEMON")
        .ok()
        .as_deref()
        == Some("true");
    validate_bind_host(&value, allow_remote, has_daemon_token).unwrap_or_else(|message| {
        eprintln!("{name} {message}");
        std::process::exit(2);
    })
}

pub(crate) fn validate_bind_host(
    value: &str,
    allow_remote: bool,
    has_daemon_token: bool,
) -> Result<IpAddr, String> {
    let value = if value.eq_ignore_ascii_case("localhost") {
        "127.0.0.1"
    } else {
        value
    };
    let host = value
        .parse::<IpAddr>()
        .map_err(|_| "must be an IP address or localhost".to_string())?;

    if !host.is_loopback() && !allow_remote {
        return Err("must be loopback unless DOCKERMAP_ALLOW_REMOTE_DAEMON=true".into());
    }
    if !host.is_loopback() && !has_daemon_token {
        return Err(
            "requires a non-empty DOCKERMAP_DAEMON_TOKEN or DOCKERMAP_API_TOKEN for non-loopback binding"
                .into(),
        );
    }

    Ok(host)
}

#[cfg(test)]
mod tests {
    use super::validate_bind_host;
    use std::net::IpAddr;

    #[test]
    fn non_loopback_daemon_bindings_require_remote_opt_in_and_a_token() {
        assert_eq!(
            validate_bind_host("localhost", false, false).expect("localhost is loopback"),
            "127.0.0.1".parse::<IpAddr>().expect("loopback address")
        );
        assert_eq!(
            validate_bind_host("::1", false, false).expect("IPv6 loopback is allowed"),
            "::1".parse::<IpAddr>().expect("IPv6 loopback address")
        );
        assert!(validate_bind_host("0.0.0.0", false, true).is_err());
        assert!(validate_bind_host("0.0.0.0", true, false).is_err());
        assert_eq!(
            validate_bind_host("0.0.0.0", true, true)
                .expect("token-protected remote binding is allowed"),
            "0.0.0.0".parse::<IpAddr>().expect("remote address")
        );
    }
}
