//! Safe comparison primitives for the daemon's bounded observed-history cache.

use crate::{
    collision_resistant_id_component, ContainerRecord, DockerSnapshot, ObservedContainerStatus,
};
use std::collections::{BTreeMap, BTreeSet};

/// The daemon retains at most this many observed deltas for its own lifetime.
pub const MAX_OBSERVED_CHANGE_EVENTS: usize = 64;

/// A comparison-only projection of an already publication-sanitized snapshot.
/// Ambiguous public identities are retained as a fail-closed set so a daemon
/// never converts a normalization collision into a false appearance/removal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedContainerInventory {
    pub containers: BTreeMap<String, ObservedContainerStatus>,
    pub ambiguous_ids: BTreeSet<String>,
}

pub fn observed_container_inventory(snapshot: &DockerSnapshot) -> ObservedContainerInventory {
    let mut candidates = BTreeMap::<String, Vec<&ContainerRecord>>::new();
    for container in &snapshot.containers {
        let id = format!(
            "docker_container_{}",
            collision_resistant_id_component(&container.id)
        );
        candidates.entry(id).or_default().push(container);
    }

    let mut containers = BTreeMap::new();
    let mut ambiguous_ids = BTreeSet::new();
    for (id, records) in candidates {
        if records.len() == 1 {
            containers.insert(id, observed_status_class(&records[0].status));
        } else {
            ambiguous_ids.insert(id);
        }
    }
    ObservedContainerInventory {
        containers,
        ambiguous_ids,
    }
}

fn observed_status_class(status: &str) -> ObservedContainerStatus {
    let normalized = status.trim().to_ascii_lowercase();
    if normalized == "running" || normalized.starts_with("up ") {
        ObservedContainerStatus::Running
    } else if normalized == "exited" || normalized == "dead" || normalized.starts_with("exited ") {
        ObservedContainerStatus::Stopped
    } else {
        ObservedContainerStatus::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{mock_snapshot, DockerSnapshot};

    #[test]
    fn inventory_uses_only_runtime_node_ids_and_closed_statuses() {
        let mut snapshot = mock_snapshot();
        snapshot.containers[0].id = "raw-id-token=DOCKERMAP_TEST_FAKE_HISTORY_SECRET".into();
        snapshot.containers[0].name = "/srv/private/name".into();
        snapshot.containers[0].status = "Up 12 seconds (healthy)".into();
        let inventory = observed_container_inventory(&snapshot);
        let id = inventory
            .containers
            .keys()
            .next()
            .expect("container identity");
        assert!(id.starts_with("docker_container_"));
        assert!(!id.contains("/srv/private/name"));
        assert!(!id.contains("Up 12 seconds"));
        assert!(inventory
            .containers
            .values()
            .any(|status| *status == ObservedContainerStatus::Running));
    }

    #[test]
    fn duplicate_public_identity_is_ambiguous_not_selected() {
        let mut snapshot: DockerSnapshot = mock_snapshot();
        snapshot.containers[1].id = snapshot.containers[0].id.clone();
        let inventory = observed_container_inventory(&snapshot);
        assert_eq!(inventory.containers.len(), snapshot.containers.len() - 2);
        assert_eq!(inventory.ambiguous_ids.len(), 1);
    }
}
