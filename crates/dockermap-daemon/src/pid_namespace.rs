use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PidNamespaceMode {
    Auto,
    Host,
    Restricted,
}

impl PidNamespaceMode {
    pub(crate) fn from_env_value(value: Option<&str>) -> Self {
        match value {
            Some("host") => Self::Host,
            Some("restricted") => Self::Restricted,
            Some("auto") | None => Self::Auto,
            // Configuration must fail closed: an unrecognised value cannot
            // accidentally enable host-provider collection in a container.
            Some(_) => Self::Restricted,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PidNamespaceScope {
    Host { diagnostic: Option<&'static str> },
    Restricted,
}

impl PidNamespaceScope {
    pub(crate) fn is_restricted(self) -> bool {
        matches!(self, Self::Restricted)
    }

    pub(crate) fn diagnostic(self) -> Option<&'static str> {
        match self {
            Self::Host { diagnostic } => diagnostic,
            Self::Restricted => None,
        }
    }
}

/// Container PID namespaces must be identified only by affirmative evidence.
/// A non-systemd pid 1 is common on real hosts (runit, OpenRC, s6, dinit), so
/// it is explicitly NOT evidence by itself.
#[cfg(test)]
pub(crate) fn restricted_pid_namespace_evidence(
    _init_comm: Option<&str>,
    cgroup: &str,
    has_dockerenv: bool,
    has_systemd_container_marker: bool,
) -> bool {
    restricted_pid_namespace_evidence_with_markers(
        cgroup,
        has_dockerenv,
        has_systemd_container_marker,
        false,
    )
}

fn restricted_pid_namespace_evidence_with_markers(
    cgroup: &str,
    has_dockerenv: bool,
    has_systemd_container_marker: bool,
    has_podman_container_marker: bool,
) -> bool {
    has_dockerenv
        || has_systemd_container_marker
        || has_podman_container_marker
        || cgroup.lines().any(cgroup_implies_container)
}

pub(crate) fn pid_namespace_scope_from_evidence(
    mode: PidNamespaceMode,
    _init_comm: Option<&str>,
    cgroup: &str,
    has_dockerenv: bool,
    has_systemd_container_marker: bool,
    has_podman_container_marker: bool,
) -> PidNamespaceScope {
    match mode {
        PidNamespaceMode::Host => PidNamespaceScope::Host { diagnostic: None },
        PidNamespaceMode::Restricted => PidNamespaceScope::Restricted,
        PidNamespaceMode::Auto => {
            if restricted_pid_namespace_evidence_with_markers(
                cgroup,
                has_dockerenv,
                has_systemd_container_marker,
                has_podman_container_marker,
            ) {
                PidNamespaceScope::Restricted
            } else {
                // Missing/ambiguous evidence is restricted: publishing a
                // container's partial /proc view as host topology is worse
                // than omitting optional host providers.
                PidNamespaceScope::Restricted
            }
        }
    }
}

pub(crate) fn daemon_pid_namespace_scope() -> PidNamespaceScope {
    let cgroup = std::fs::read_to_string("/proc/self/cgroup").unwrap_or_default();
    pid_namespace_scope_from_evidence(
        PidNamespaceMode::from_env_value(std::env::var("DOCKERMAP_PID_NAMESPACE").ok().as_deref()),
        None,
        &cgroup,
        Path::new("/.dockerenv").exists(),
        Path::new("/run/systemd/container").exists(),
        Path::new("/run/.containerenv").exists(),
    )
}

/// True when a cgroup path places the process inside a container: Docker
/// (cgroup v1 `/docker/<id>` and systemd scope
/// `/system.slice/docker-<id>.scope/...`), libpod (podman), or kubepods
/// (Kubernetes). The docker provider owns container internals, so such pids
/// must never surface as host native-process nodes.
pub(crate) fn cgroup_implies_container(cgroup: &str) -> bool {
    let path = cgroup.trim().splitn(3, ':').nth(2).unwrap_or(cgroup.trim());
    path.contains("/docker/")
        || path.split('/').any(|component| {
            (component.starts_with("docker-") && component.ends_with(".scope"))
                || (component.starts_with("libpod-") && component.ends_with(".scope"))
                || component.starts_with("kubepods")
        })
}

/// True when the pid's cgroup places it inside a container. An unreadable
/// `/proc/<pid>/cgroup` means unknown ownership; fail closed so an
/// inaccessible container process never appears as host inventory.
fn cgroup_result_is_container_owned(result: Result<String, std::io::Error>) -> bool {
    result
        .map(|cgroup| cgroup.lines().any(cgroup_implies_container))
        .unwrap_or(true)
}

#[cfg(not(test))]
pub(crate) fn is_container_owned(pid: u32) -> bool {
    // This follows the same ~79ms ps-to-/proc PID-reuse window documented in
    // real_comm. A reused pid can be filtered incorrectly, but only for this
    // 2-second snapshot; no argv is published and comm is process-controlled.
    cgroup_result_is_container_owned(std::fs::read_to_string(format!("/proc/{pid}/cgroup")))
}

// Fixture process IDs intentionally do not exist in this test process. The
// parser tests inject affirmative container cgroups separately; never make
// test-only fixture absence masquerade as production ownership evidence.
#[cfg(test)]
pub(crate) fn is_container_owned(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreadable_cgroup_fails_closed_for_production_ownership() {
        assert!(cgroup_result_is_container_owned(Err(
            std::io::Error::other("unreadable")
        )));
    }
}
