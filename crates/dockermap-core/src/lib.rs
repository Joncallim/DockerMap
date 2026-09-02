#[cfg(test)]
use std::collections::{BTreeMap, BTreeSet};
#[cfg(test)]
use std::path::{Path, PathBuf};

mod findings;
mod fixtures;
mod identity;
mod logs;
mod models;
pub mod schema_baseline;
mod snapshot_runtime;

pub use findings::derive_findings;
pub use fixtures::{mock_log_entries, mock_logs, mock_snapshot, unix_timestamp_millis};
pub use identity::collision_resistant_id_component;
pub use logs::{
    page_log_entries, parse_rfc3339_nano_millis, LogCursor, DEFAULT_LOG_PAGE_SIZE,
    MAX_LOG_PAGE_SIZE,
};
pub use models::*;
pub use snapshot_runtime::{derive_graph, derive_images, derive_runtime_map};

pub fn service_entity_kind_name(kind: &ServiceEntityKind) -> &'static str {
    match kind {
        ServiceEntityKind::Service => "service",
        ServiceEntityKind::NodeApplication => "node_application",
        ServiceEntityKind::PythonApplication => "python_application",
        ServiceEntityKind::AiAgent => "ai_agent",
        ServiceEntityKind::Session => "session",
        ServiceEntityKind::Host => "host",
        ServiceEntityKind::Storage => "storage",
        ServiceEntityKind::ExternalApi => "external_api",
        ServiceEntityKind::DnsProvider => "dns_provider",
        ServiceEntityKind::ReverseProxy => "reverse_proxy",
        ServiceEntityKind::PackageDependency => "package_dependency",
    }
}

mod compose;
pub use compose::{
    correlate_compose_runtime, derive_compose_graph, discover_compose_files,
    plan_compose_mount_edit, scan_compose_files,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compose::{
        coalesce_compose_services, display_path, parse_compose_file, resolve_source,
        split_short_volume, unsafe_bind_source_diagnostic, validate_compose_scan,
        MAX_COMPOSE_FILE_BYTES,
    };

    fn repo_fixture_path(parts: &[&str]) -> PathBuf {
        let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        for part in parts {
            path.push(part);
        }
        path
    }

    fn scan_content(file: &Path, project_root: &Path, content: &str) -> ComposeScan {
        let mut scan = ComposeScan {
            files: vec![display_path(file)],
            project_root: display_path(project_root),
            services: Vec::new(),
            mounts: Vec::new(),
            correlations: Vec::new(),
            diagnostics: Vec::new(),
        };
        parse_compose_file(file, content, &mut scan);
        coalesce_compose_services(&mut scan);
        validate_compose_scan(&mut scan);
        scan
    }

    fn scan_invalid_fixture(name: &str) -> ComposeScan {
        let root = repo_fixture_path(&["tests", "fixtures", "compose", "invalid"]);
        let file = root.join(name);
        scan_compose_files(&root, &[file]).expect("invalid fixture should scan with diagnostics")
    }

    #[test]
    fn mock_snapshot_has_expected_shape() {
        let snapshot = mock_snapshot();
        assert_eq!(snapshot.containers.len(), 6);
        assert_eq!(snapshot.networks.len(), 3);
        assert_eq!(snapshot.volumes.len(), 2);
        assert!(snapshot.last_updated > 0);
    }

    #[test]
    fn derives_images_from_containers() {
        let snapshot = mock_snapshot();
        let images = derive_images(&snapshot);
        let python = images
            .iter()
            .find(|image| image.image == "python:3.11-slim")
            .expect("python image should exist");
        assert_eq!(
            python.containers,
            vec!["api".to_string(), "worker".to_string()]
        );
    }

    #[test]
    fn derives_graph_with_nodes_and_edges() {
        let snapshot = mock_snapshot();
        let graph = derive_graph(&snapshot);
        // 6 containers + 3 networks + 2 volumes.
        assert_eq!(graph.nodes.len(), 11);
        assert!(graph.edges.iter().any(|edge| edge.target == "network_data"));
        assert!(graph
            .edges
            .iter()
            .any(|edge| edge.target == "volume_postgres_data"));
    }

    #[test]
    fn resolves_depends_on_by_role_when_names_differ() {
        // Real-world shape: compose depends_on refs name the compose SERVICE
        // (the daemon's `container_<service>` refs), while live container
        // names are project-prefixed and the service name is recorded as the
        // container's role (com.docker.compose.service label).
        let snapshot = DockerSnapshot {
            containers: vec![
                ContainerRecord {
                    id: "deadbeef_api".into(),
                    name: "immich_api".into(),
                    image: "immich-server:latest".into(),
                    status: "running".into(),
                    role: "api".into(),
                    networks: vec![],
                    ports: vec![],
                    mounts: vec![],
                    depends_on: vec!["container_redis".into(), "container_database".into()],
                },
                ContainerRecord {
                    id: "deadbeef_redis".into(),
                    name: "immich_redis".into(),
                    image: "redis:7-alpine".into(),
                    status: "running".into(),
                    role: "redis".into(),
                    networks: vec![],
                    ports: vec![],
                    mounts: vec![],
                    depends_on: vec![],
                },
                ContainerRecord {
                    id: "deadbeef_db".into(),
                    name: "immich_database".into(),
                    image: "postgres:16-alpine".into(),
                    status: "running".into(),
                    role: "database".into(),
                    networks: vec![],
                    ports: vec![],
                    mounts: vec![],
                    depends_on: vec![],
                },
            ],
            images: vec![],
            networks: vec![],
            volumes: vec![],
            last_updated: unix_timestamp_millis(),
            ..Default::default()
        };

        let graph = derive_graph(&snapshot);
        let api_dependencies = graph
            .edges
            .iter()
            .filter(|edge| edge.source == "deadbeef_api")
            .map(|edge| edge.target.as_str())
            .collect::<Vec<_>>();
        assert_eq!(api_dependencies.len(), 2);
        assert!(api_dependencies.contains(&"deadbeef_redis"));
        assert!(api_dependencies.contains(&"deadbeef_db"));
        assert!(
            !graph
                .edges
                .iter()
                .any(|edge| edge.target.starts_with("container_")),
            "unresolved depends_on refs must not leak into the graph"
        );
    }

    #[test]
    fn omits_dependency_edges_for_ambiguous_or_cross_alias_container_references() {
        let container = |id: &str, name: &str, role: &str, depends_on: Vec<&str>| ContainerRecord {
            id: id.into(),
            name: name.into(),
            image: "test:latest".into(),
            status: "running".into(),
            role: role.into(),
            networks: vec![],
            ports: vec![],
            mounts: vec![],
            depends_on: depends_on.into_iter().map(str::to_string).collect(),
        };
        let snapshot = DockerSnapshot {
            containers: vec![
                container(
                    "consumer",
                    "consumer",
                    "consumer",
                    vec!["container_foo", "duplicate-name", "shared-id", ""],
                ),
                // `container_foo` is a normal compose role ref for this
                // record, but it is also the raw ID of the next record. The
                // graph must not choose either one based on lookup order.
                container("role-target", "role-target", "foo", vec![]),
                container("container_foo", "raw-id-target", "other", vec![]),
                container("name-one", "duplicate-name", "one", vec![]),
                container("name-two", "duplicate-name", "two", vec![]),
                container("shared-id", "id-one", "three", vec![]),
                container("shared-id", "id-two", "four", vec![]),
                // Empty aliases are never resolution candidates.
                container("", "", "", vec![]),
            ],
            ..Default::default()
        };

        let graph = derive_graph(&snapshot);
        assert_eq!(graph.nodes.len(), snapshot.containers.len());
        assert!(graph.edges.is_empty());

        let runtime_map = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new(), "test");
        assert!(runtime_map.edges.iter().all(|edge| {
            edge.evidence_refs
                .iter()
                .all(|evidence| evidence.kind != RuntimeEvidenceKind::DockerComposeDependsOn)
        }));
    }

    #[test]
    fn graph_omits_self_dependency_edges() {
        let snapshot = DockerSnapshot {
            containers: vec![ContainerRecord {
                id: "self".into(),
                name: "self".into(),
                image: "test:latest".into(),
                status: "running".into(),
                role: "self".into(),
                networks: vec![],
                ports: vec![],
                mounts: vec![],
                depends_on: vec!["container_self".into()],
            }],
            ..Default::default()
        };

        assert!(derive_graph(&snapshot).edges.is_empty());
        let runtime_map = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new(), "test");
        assert!(runtime_map.edges.iter().all(|edge| {
            edge.evidence_refs
                .iter()
                .all(|evidence| evidence.kind != RuntimeEvidenceKind::DockerComposeDependsOn)
        }));
    }

    #[test]
    fn graph_omits_ambiguous_membership_edges_and_is_stable_when_reordered() {
        let container = |id: &str, name: &str, networks: Vec<&str>| ContainerRecord {
            id: id.into(),
            name: name.into(),
            image: "test:latest".into(),
            status: "running".into(),
            role: name.into(),
            networks: networks.into_iter().map(str::to_string).collect(),
            ports: vec![],
            mounts: vec![],
            depends_on: vec![],
        };
        let mut snapshot = DockerSnapshot {
            containers: vec![
                container(
                    "container-unique",
                    "unique-name",
                    vec!["network-unique", "network-ambiguous", "missing-network"],
                ),
                // The duplicate container ID leaves both visible but makes
                // their outgoing graph relations non-routable.
                container(
                    "container-collision",
                    "collision-one",
                    vec!["network-unique"],
                ),
                container(
                    "container-collision",
                    "collision-two",
                    vec!["network-unique"],
                ),
                // Mount correlation by this name is ambiguous.
                container("container-name-one", "duplicate-name", vec![]),
                container("container-name-two", "duplicate-name", vec![]),
            ],
            networks: vec![
                NetworkRecord {
                    id: "network-unique".into(),
                    name: "network-unique".into(),
                    driver: "bridge".into(),
                    internal: false,
                    members: vec![],
                },
                NetworkRecord {
                    id: "network-ambiguous".into(),
                    name: "network-ambiguous-one".into(),
                    driver: "bridge".into(),
                    internal: false,
                    members: vec![],
                },
                NetworkRecord {
                    id: "network-ambiguous".into(),
                    name: "network-ambiguous-two".into(),
                    driver: "bridge".into(),
                    internal: false,
                    members: vec![],
                },
            ],
            volumes: vec![
                VolumeRecord {
                    id: "volume-unique".into(),
                    name: "volume-unique".into(),
                    attached_to: vec!["unique-name".into(), "unique-name".into()],
                },
                VolumeRecord {
                    id: "volume-ambiguous-mount".into(),
                    name: "volume-ambiguous-mount".into(),
                    attached_to: vec!["duplicate-name".into()],
                },
            ],
            ..Default::default()
        };

        let graph = derive_graph(&snapshot);
        assert_eq!(
            graph
                .edges
                .iter()
                .filter(|edge| edge.source == "container-unique")
                .cloned()
                .collect::<Vec<_>>(),
            vec![
                GraphEdge {
                    source: "container-unique".into(),
                    target: "network-unique".into(),
                    relationship: RelationshipKind::ConnectedTo,
                },
                GraphEdge {
                    source: "container-unique".into(),
                    target: "volume-unique".into(),
                    relationship: RelationshipKind::Mounts,
                },
            ]
        );
        assert!(graph
            .edges
            .iter()
            .all(|edge| edge.source != "container-collision"));
        assert!(graph
            .edges
            .iter()
            .all(|edge| edge.target != "network-ambiguous"
                && edge.target != "volume-ambiguous-mount"));

        snapshot.containers.reverse();
        snapshot.networks.reverse();
        snapshot.volumes.reverse();
        assert_eq!(
            serde_json::to_vec(&graph).expect("graph serializes"),
            serde_json::to_vec(&derive_graph(&snapshot)).expect("reordered graph serializes"),
            "equivalent snapshots must publish stable graph bytes"
        );
    }

    #[test]
    fn graph_omits_edges_when_node_ids_collide_across_kinds() {
        let snapshot = DockerSnapshot {
            containers: vec![ContainerRecord {
                id: "container".into(),
                name: "container".into(),
                image: "test:latest".into(),
                status: "running".into(),
                role: "container".into(),
                networks: vec!["shared-id".into()],
                ports: vec![],
                mounts: vec![],
                depends_on: vec![],
            }],
            networks: vec![NetworkRecord {
                id: "shared-id".into(),
                name: "network".into(),
                driver: "bridge".into(),
                internal: false,
                members: vec![],
            }],
            volumes: vec![VolumeRecord {
                id: "shared-id".into(),
                name: "volume".into(),
                attached_to: vec![],
            }],
            ..Default::default()
        };

        let graph = derive_graph(&snapshot);
        assert_eq!(graph.nodes.len(), 3, "colliding nodes remain visible");
        assert!(graph.edges.is_empty());
    }

    #[test]
    fn filters_mock_logs_by_service_and_query() {
        let snapshot = mock_snapshot();
        let logs = mock_logs(
            &snapshot,
            Some("api"),
            Some("python"),
            None,
            DEFAULT_LOG_PAGE_SIZE,
        );
        assert!(logs.entries.iter().all(|entry| entry.container == "api"));
        assert!(!logs.entries.is_empty());
    }

    #[test]
    fn paginates_mock_logs_with_cursor_and_limit() {
        let snapshot = mock_snapshot();
        let first = mock_logs(&snapshot, None, None, None, 2);
        assert_eq!(first.entries.len(), 2);
        let cursor = first.next_cursor.expect("a full first page has a cursor");

        let second = mock_logs(
            &snapshot,
            None,
            None,
            Some(LogCursor::parse(&cursor).expect("compound cursor")),
            2,
        );
        assert!(!second.entries.is_empty());
        assert!(
            second
                .entries
                .iter()
                .all(|entry| entry.timestamp < first.entries[0].timestamp),
            "second page must be strictly older than the first page"
        );
        assert!(
            second.entries.iter().all(|entry| first
                .entries
                .iter()
                .all(|first_entry| first_entry.id != entry.id)),
            "pages must not overlap"
        );
    }

    #[test]
    fn mock_logs_honors_cursor_without_service_filter() {
        // Regression: live-Docker mode with no service query used to hard-code
        // the cursor to None, so "Load older" re-returned page 1 forever. The
        // mock path must page older entries when given a cursor.
        let snapshot = mock_snapshot();
        let first = mock_logs(&snapshot, None, None, None, 3);
        assert_eq!(first.entries.len(), 3);
        let cursor = first.next_cursor.expect("a full first page has a cursor");

        let older = mock_logs(
            &snapshot,
            None,
            None,
            Some(LogCursor::parse(&cursor).expect("compound cursor")),
            3,
        );
        assert!(!older.entries.is_empty(), "older page must not be empty");
        assert!(
            older
                .entries
                .iter()
                .all(|entry| entry.timestamp < first.entries[0].timestamp),
            "older page must be strictly older than the first page"
        );
    }

    #[test]
    fn mock_log_timestamps_are_stable_across_requests() {
        // Regression (round 8, F3): mock entry timestamps used to derive
        // from a FRESH `now` per request, so a compound cursor from page N
        // never matched an entry on page N+1 — the boundary entry was
        // misclassified as already-emitted and skipped, and the same-ms
        // offset logic never engaged in mock mode. The base must be captured
        // once per process.
        let snapshot = mock_snapshot();
        let first = mock_logs(&snapshot, None, None, None, 2);
        let cursor = first
            .next_cursor
            .clone()
            .expect("a full first page has a cursor");

        // The same cursor must select the identical entries on every
        // subsequent request (the timeline must not drift between requests).
        let again = mock_logs(&snapshot, None, None, LogCursor::parse(&cursor), 2);
        let again_2 = mock_logs(&snapshot, None, None, LogCursor::parse(&cursor), 2);
        assert_eq!(
            again.entries, again_2.entries,
            "the same cursor must yield identical entries across requests"
        );

        // Paginating through the compound cursor must return strictly older
        // pages and cover every mock entry exactly once (no loss, no
        // overlap).
        let mut seen = first
            .entries
            .iter()
            .map(|entry| entry.id.clone())
            .collect::<std::collections::HashSet<_>>();
        let mut next = Some(cursor);
        let mut pages = 1usize;
        while let Some(current) = next {
            let page = mock_logs(&snapshot, None, None, LogCursor::parse(&current), 2);
            assert!(!page.entries.is_empty(), "cursor pagination must not stall");
            assert!(
                page.entries
                    .iter()
                    .all(|entry| entry.timestamp < first.entries[0].timestamp),
                "every cursor page must be strictly older than the first page"
            );
            for entry in &page.entries {
                assert!(seen.insert(entry.id.clone()), "pages must not overlap");
            }
            next = page.next_cursor;
            pages += 1;
            assert!(pages < 100, "cursor pagination must terminate");
        }

        let all = mock_logs(&snapshot, None, None, None, MAX_LOG_PAGE_SIZE);
        assert_eq!(
            seen.len(),
            all.entries.len(),
            "no mock entry may be lost across pages"
        );
    }

    #[test]
    fn paginates_same_timestamp_entries_with_compound_cursor() {
        // Regression (round 7, F3): entries sharing one millisecond used to
        // be silently dropped at page boundaries — a plain `ts` cursor could
        // never resume mid-run, so 5 entries at ts=1000 with limit=2 lost
        // three entries. The compound "ts:offset" cursor must page them all.
        let entries = (0..5)
            .map(|index| LogEntry {
                id: format!("svc-{index}"),
                timestamp: 1_000,
                container: "svc".into(),
                level: LogLevel::Info,
                message: format!("line {index}"),
            })
            .collect::<Vec<_>>();

        let (page1, cursor1) = page_log_entries(entries.clone(), None, None, 2);
        assert_eq!(page1.len(), 2);
        assert_eq!(
            cursor1.as_deref(),
            Some("1000:2"),
            "cursor encodes the boundary ms and the 2 entries already emitted at it"
        );

        let (page2, cursor2) = page_log_entries(
            entries.clone(),
            None,
            LogCursor::parse("1000:2").as_ref().copied(),
            2,
        );
        assert_eq!(page2.len(), 2);
        assert_eq!(
            cursor2.as_deref(),
            Some("1000:4"),
            "the second page resumes past the first 2 same-ms entries"
        );
        assert!(
            page2
                .iter()
                .all(|entry| page1.iter().all(|first| first.id != entry.id)),
            "pages must not overlap"
        );

        let (page3, cursor3) = page_log_entries(
            entries.clone(),
            None,
            LogCursor::parse("1000:4").as_ref().copied(),
            2,
        );
        assert_eq!(page3.len(), 1, "the last same-ms entry is still delivered");
        assert_eq!(page3[0].id, "svc-4");
        assert_eq!(cursor3, None, "the last page has no cursor");

        // A plain "ts" cursor (backward compatible) still pages older entries.
        let (page_plain, _) = page_log_entries(
            entries.clone(),
            None,
            LogCursor::parse("999").as_ref().copied(),
            2,
        );
        assert!(page_plain.is_empty(), "nothing is older than 999 here");
        assert_eq!(
            LogCursor::parse("1000"),
            Some(LogCursor {
                millis: 1_000,
                offset: 0
            })
        );
        assert_eq!(
            LogCursor::parse("1000:7"),
            Some(LogCursor {
                millis: 1_000,
                offset: 7
            })
        );
        assert_eq!(LogCursor::parse("not-a-cursor"), None);
    }

    #[test]
    fn parses_rfc3339_nano_timestamps() {
        assert_eq!(parse_rfc3339_nano_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_rfc3339_nano_millis("2026-08-20T04:05:06Z"),
            Some(1_787_198_706_000)
        );
        assert_eq!(
            parse_rfc3339_nano_millis("2026-08-20T04:05:06.123456789Z"),
            Some(1_787_198_706_123)
        );
        assert_eq!(
            parse_rfc3339_nano_millis("2026-08-20T04:05:06.5Z"),
            Some(1_787_198_706_500)
        );
        assert_eq!(parse_rfc3339_nano_millis("not-a-timestamp"), None);
        assert_eq!(parse_rfc3339_nano_millis("2026-08-20T04:05:06+02:00"), None);
        assert_eq!(parse_rfc3339_nano_millis("2026-13-20T04:05:06Z"), None);
        assert_eq!(parse_rfc3339_nano_millis("2026-08-20T24:05:06Z"), None);
        assert_eq!(parse_rfc3339_nano_millis("2026-08-20T04:05:06.Z"), None);
    }

    #[test]
    fn derives_runtime_map_from_docker_snapshot() {
        let snapshot = mock_snapshot();
        let runtime_map = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new(), "test");

        assert!(runtime_map
            .nodes
            .iter()
            .any(|node| node.provider == RuntimeProviderKind::Docker
                && node.kind == RuntimeNodeKind::Container
                && node.label == "api"));
        assert!(runtime_map
            .nodes
            .iter()
            .any(|node| node.kind == RuntimeNodeKind::DockerNetwork));
        assert!(runtime_map
            .edges
            .iter()
            .any(|edge| edge.relationship == RuntimeRelationshipKind::ConnectedTo));
    }

    #[test]
    fn daemon_state_bind_mount_evidence_is_path_free_and_unique_per_container() {
        let mut snapshot = mock_snapshot();
        snapshot.containers[0].mounts = vec![
            ContainerMount {
                id: "private-one".into(),
                kind: ComposeMountKind::Bind,
                source: Some("/private/DOCKERMAP_TEST_DAEMON_STATE/docker.sock".into()),
                target: "/inside/socket".into(),
                read_only: true,
            },
            ContainerMount {
                id: "private-two".into(),
                kind: ComposeMountKind::Bind,
                source: Some("/var/lib/docker/DOCKERMAP_TEST_DAEMON_STATE".into()),
                target: "/inside/data".into(),
                read_only: false,
            },
        ];
        let runtime_map = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new(), "test");
        let risk = runtime_map
            .nodes
            .iter()
            .find(|node| node.id == "host_risk_docker_daemon_state")
            .expect("matching bind mount derives the synthetic risk target");
        assert_eq!(risk.kind, RuntimeNodeKind::HostRisk);
        assert!(risk.metadata.is_empty());
        let edges = runtime_map
            .edges
            .iter()
            .filter(|edge| edge.target == "host_risk_docker_daemon_state")
            .collect::<Vec<_>>();
        assert_eq!(edges.len(), 1, "two qualifying mounts retain one safe edge");
        assert_eq!(
            edges[0].relationship,
            RuntimeRelationshipKind::ExposesDaemonState
        );
        assert_eq!(edges[0].evidence_refs.len(), 1);
        assert_eq!(
            edges[0].evidence_refs[0].kind,
            RuntimeEvidenceKind::DockerDaemonStateBindMount
        );
        let serialized = serde_json::to_string(&runtime_map).unwrap();
        for forbidden in [
            "DOCKERMAP_TEST_DAEMON_STATE",
            "/inside/socket",
            "/inside/data",
            "readOnly",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "runtime evidence leaked {forbidden}"
            );
        }
    }

    #[test]
    fn irrelevant_or_collided_daemon_state_mounts_fail_closed() {
        let mut irrelevant = mock_snapshot();
        irrelevant.containers[0].mounts = vec![ContainerMount {
            id: "not-bind".into(),
            kind: ComposeMountKind::NamedVolume,
            source: Some("/var/lib/docker".into()),
            target: "/inside".into(),
            read_only: false,
        }];
        assert!(
            derive_runtime_map(&irrelevant, Vec::new(), Vec::new(), Vec::new(), "test")
                .edges
                .iter()
                .all(|edge| edge.target != "host_risk_docker_daemon_state")
        );

        let mut collided = mock_snapshot();
        collided.containers[0].mounts = vec![ContainerMount {
            id: "daemon-bind".into(),
            kind: ComposeMountKind::Bind,
            source: Some("/var/run/docker.sock".into()),
            target: "/inside".into(),
            read_only: false,
        }];
        collided.containers.push(collided.containers[0].clone());
        assert!(
            derive_runtime_map(&collided, Vec::new(), Vec::new(), Vec::new(), "test")
                .edges
                .iter()
                .all(|edge| edge.target != "host_risk_docker_daemon_state")
        );
    }

    #[test]
    fn docker_runtime_edges_carry_bounded_observed_evidence_without_confidence() {
        let snapshot = mock_snapshot();
        let runtime_map = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new(), "test");
        let network = runtime_map
            .edges
            .iter()
            .find(|edge| {
                edge.relationship == RuntimeRelationshipKind::ConnectedTo
                    && edge.evidence_refs.iter().any(|evidence| {
                        evidence.kind == RuntimeEvidenceKind::DockerNetworkMembership
                    })
            })
            .expect("mock snapshot has Docker network membership");
        let port = runtime_map
            .edges
            .iter()
            .find(|edge| {
                edge.relationship == RuntimeRelationshipKind::Exposes
                    && edge
                        .evidence_refs
                        .iter()
                        .any(|evidence| evidence.kind == RuntimeEvidenceKind::DockerPortPublication)
            })
            .expect("mock snapshot has Docker port publication");
        let mount = runtime_map
            .edges
            .iter()
            .find(|edge| {
                edge.relationship == RuntimeRelationshipKind::Mounts
                    && edge
                        .evidence_refs
                        .iter()
                        .any(|evidence| evidence.kind == RuntimeEvidenceKind::DockerVolumeMount)
            })
            .expect("mock snapshot has Docker volume attachment");

        for edge in [network, port, mount] {
            assert_eq!(edge.evidence_refs.len(), 1);
            let evidence = &edge.evidence_refs[0];
            assert_eq!(evidence.version, 1);
            assert_eq!(evidence.provider, RuntimeEvidenceProvider::Docker);
            assert_eq!(
                evidence.assertion_kind,
                RuntimeEvidenceAssertionKind::Observed
            );
            assert_eq!(evidence.freshness, RuntimeEvidenceFreshness::Fresh);
            assert_eq!(evidence.subject_ref, edge.source);
            assert_eq!(evidence.collected_at, snapshot.last_updated);
            assert_eq!(evidence.provider_revision, "test");
            assert!(!evidence.summary.contains(&snapshot.containers[0].name));
        }

        let serialized = serde_json::to_string(&runtime_map).expect("runtime map serializes");
        assert!(serialized.contains("evidenceRefs"));
        assert!(serialized.contains("assertionKind"));
        assert!(
            !serialized.contains("confidence"),
            "observed Docker facts must not imply numerical confidence"
        );
    }

    #[test]
    fn docker_runtime_compose_dependencies_are_bounded_observed_declarations() {
        let snapshot = mock_snapshot();
        let runtime_map = derive_runtime_map(
            &snapshot,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            "opaque-docker-observation",
        );
        let dependencies = runtime_map
            .edges
            .iter()
            .filter(|edge| {
                edge.evidence_refs
                    .iter()
                    .any(|evidence| evidence.kind == RuntimeEvidenceKind::DockerComposeDependsOn)
            })
            .collect::<Vec<_>>();

        assert_eq!(dependencies.len(), 5);
        for edge in dependencies {
            assert_eq!(edge.relationship, RuntimeRelationshipKind::DependsOn);
            assert!(edge.source.starts_with("docker_container_"));
            assert!(edge.target.starts_with("docker_container_"));
            assert_ne!(edge.source, edge.target);
            assert_eq!(edge.evidence_refs.len(), 1);
            let evidence = &edge.evidence_refs[0];
            assert_eq!(evidence.version, 1);
            assert_eq!(evidence.provider, RuntimeEvidenceProvider::Docker);
            assert_eq!(
                evidence.assertion_kind,
                RuntimeEvidenceAssertionKind::Observed
            );
            assert_eq!(evidence.freshness, RuntimeEvidenceFreshness::Fresh);
            assert_eq!(evidence.subject_ref, edge.source);
            assert_eq!(evidence.collected_at, snapshot.last_updated);
            assert_eq!(evidence.provider_revision, "opaque-docker-observation");
            assert_eq!(
                evidence.summary,
                "Docker recorded Compose dependency declaration"
            );
        }
    }

    #[test]
    fn docker_evidence_provider_revision_attests_observation_not_cache_publication() {
        let mut snapshot = mock_snapshot();
        snapshot.last_updated = 42;
        // The daemon assigns this after runtime derivation. Supplying a
        // plausible publication value here proves it cannot leak backward
        // into provider evidence.
        snapshot.model_revision = "daemon-publication-999".into();

        let runtime_map = derive_runtime_map(
            &snapshot,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            "opaque-docker-observation-17",
        );
        let evidence = runtime_map
            .edges
            .iter()
            .flat_map(|edge| &edge.evidence_refs)
            .next()
            .expect("representative Docker snapshot emits Docker evidence");

        assert_eq!(evidence.collected_at, 42);
        assert_eq!(evidence.provider_revision, "opaque-docker-observation-17");
        assert_ne!(evidence.provider_revision, snapshot.model_revision);
    }

    #[test]
    fn runtime_evidence_derivation_rejects_an_empty_observation_token() {
        let snapshot = mock_snapshot();
        let result = std::panic::catch_unwind(|| {
            derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new(), "")
        });
        assert!(
            result.is_err(),
            "an empty providerRevision must never produce a runtime map"
        );
    }

    #[test]
    fn version_one_evidence_rejects_non_docker_or_non_observed_claims() {
        let snapshot = mock_snapshot();
        let evidence = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new(), "test")
            .edges
            .into_iter()
            .flat_map(|edge| edge.evidence_refs)
            .next()
            .expect("representative Docker snapshot emits version-one evidence");
        let valid = serde_json::to_value(evidence).expect("evidence serializes");

        for (field, invalid) in [
            ("provider", serde_json::json!("systemd")),
            ("assertionKind", serde_json::json!("inferred")),
            ("freshness", serde_json::json!("stale")),
            ("kind", serde_json::json!("systemd_requires")),
        ] {
            let mut malformed = valid.clone();
            malformed[field] = invalid;
            assert!(
                serde_json::from_value::<RuntimeEvidenceRef>(malformed).is_err(),
                "v1 must reject fabricated {field} evidence"
            );
        }
    }

    #[test]
    fn version_two_systemd_evidence_requires_its_closed_slot_binding() {
        let valid = serde_json::json!({
            "version": 2,
            "id": "systemd_evidence_requires_opaque",
            "provider": "systemd",
            "kind": "systemd_requires",
            "assertionKind": "declared",
            "summary": "systemd declared a Requires dependency",
            "subjectRef": "systemd_service_app",
            "collectedAt": 42,
            "providerRevision": "opaque-systemd-revision",
            "providerSlot": "systemd",
            "freshness": "stale"
        });
        assert!(serde_json::from_value::<RuntimeEvidenceRef>(valid.clone()).is_ok());
        for (field, invalid) in [
            ("providerSlot", serde_json::json!("host_scoped")),
            ("assertionKind", serde_json::json!("observed")),
            ("freshness", serde_json::json!("unavailable")),
            ("kind", serde_json::json!("docker_network_membership")),
        ] {
            let mut malformed = valid.clone();
            malformed[field] = invalid;
            assert!(serde_json::from_value::<RuntimeEvidenceRef>(malformed).is_err());
        }
        let edge = serde_json::json!({
            "source": "systemd_service_app",
            "target": "systemd_service_database",
            "relationship": "requires",
            "metadata": {},
            "evidenceRefs": [valid.clone()]
        });
        assert!(serde_json::from_value::<RuntimeMapEdge>(edge.clone()).is_ok());
        let mut wrong_relationship = edge;
        wrong_relationship["relationship"] = serde_json::json!("wants");
        assert!(serde_json::from_value::<RuntimeMapEdge>(wrong_relationship).is_err());
        let mut missing_binding = valid;
        missing_binding
            .as_object_mut()
            .unwrap()
            .remove("providerSlot");
        assert!(serde_json::from_value::<RuntimeEvidenceRef>(missing_binding).is_err());
    }

    #[test]
    fn version_three_npm_manifest_evidence_requires_its_closed_slot_binding() {
        let valid = serde_json::json!({
            "version": 3,
            "id": "npm_evidence_manifest_dependency_opaque",
            "provider": "npm",
            "kind": "npm_package_manifest_dependency",
            "assertionKind": "declared",
            "summary": "package manifest declared a dependency",
            "subjectRef": "npm_project_app",
            "collectedAt": 42,
            "providerRevision": "opaque-npm-revision",
            "providerSlot": "project_npm",
            "freshness": "timed_out"
        });
        assert!(serde_json::from_value::<RuntimeEvidenceRef>(valid.clone()).is_ok());
        for (field, invalid) in [
            ("providerSlot", serde_json::json!("systemd")),
            ("provider", serde_json::json!("systemd")),
            ("assertionKind", serde_json::json!("observed")),
            ("kind", serde_json::json!("systemd_requires")),
        ] {
            let mut malformed = valid.clone();
            malformed[field] = invalid;
            assert!(serde_json::from_value::<RuntimeEvidenceRef>(malformed).is_err());
        }
        let edge = serde_json::json!({
            "source": "npm_project_app",
            "target": "npm_package_dependency",
            "relationship": "depends_on",
            "metadata": {},
            "evidenceRefs": [valid]
        });
        assert!(serde_json::from_value::<RuntimeMapEdge>(edge.clone()).is_ok());
        let mut wrong_target = edge;
        wrong_target["target"] = serde_json::json!("systemd_service_database");
        assert!(serde_json::from_value::<RuntimeMapEdge>(wrong_target).is_err());
    }

    #[test]
    fn version_four_cron_evidence_requires_its_closed_slot_and_canonical_edge() {
        let valid = serde_json::json!({
            "version": 4,
            "id": "cron_evidence_schedule_opaque",
            "provider": "cron",
            "kind": "cron_schedule_declaration",
            "assertionKind": "declared",
            "summary": "cron declared a scheduled job",
            "subjectRef": "scheduled_job_opaque",
            "collectedAt": 42,
            "providerRevision": "opaque-cron-revision",
            "providerSlot": "cron",
            "freshness": "stale"
        });
        assert!(serde_json::from_value::<RuntimeEvidenceRef>(valid.clone()).is_ok());
        for (field, invalid) in [
            ("providerSlot", serde_json::json!("host_scoped")),
            ("provider", serde_json::json!("systemd")),
            ("assertionKind", serde_json::json!("observed")),
            ("kind", serde_json::json!("systemd_requires")),
        ] {
            let mut malformed = valid.clone();
            malformed[field] = invalid;
            assert!(serde_json::from_value::<RuntimeEvidenceRef>(malformed).is_err());
        }
        let edge = serde_json::json!({
            "source": "scheduled_job_opaque", "target": "host_local", "relationship": "runs_on",
            "metadata": {}, "evidenceRefs": [valid]
        });
        assert!(serde_json::from_value::<RuntimeMapEdge>(edge.clone()).is_ok());
        let mut wrong_target = edge;
        wrong_target["target"] = serde_json::json!("host_other");
        assert!(serde_json::from_value::<RuntimeMapEdge>(wrong_target).is_err());
    }

    #[test]
    fn version_five_tmux_evidence_requires_its_closed_slot_and_canonical_edge() {
        let valid = serde_json::json!({
            "version": 5,
            "id": "tmux_evidence_session_listing_opaque",
            "provider": "tmux",
            "kind": "tmux_session_listing",
            "assertionKind": "observed",
            "summary": "tmux listed a local session",
            "subjectRef": "tmux_session_opaque",
            "collectedAt": 42,
            "providerRevision": "opaque-tmux-revision",
            "providerSlot": "tmux",
            "freshness": "stale"
        });
        assert!(serde_json::from_value::<RuntimeEvidenceRef>(valid.clone()).is_ok());
        for (field, invalid) in [
            ("providerSlot", serde_json::json!("host_scoped")),
            ("provider", serde_json::json!("cron")),
            ("assertionKind", serde_json::json!("declared")),
            ("kind", serde_json::json!("cron_schedule_declaration")),
        ] {
            let mut malformed = valid.clone();
            malformed[field] = invalid;
            assert!(serde_json::from_value::<RuntimeEvidenceRef>(malformed).is_err());
        }
        let edge = serde_json::json!({
            "source": "tmux_session_opaque", "target": "host_local", "relationship": "runs_on",
            "metadata": {}, "evidenceRefs": [valid]
        });
        assert!(serde_json::from_value::<RuntimeMapEdge>(edge.clone()).is_ok());
        let mut wrong_target = edge;
        wrong_target["target"] = serde_json::json!("host_other");
        assert!(serde_json::from_value::<RuntimeMapEdge>(wrong_target).is_err());
    }

    #[test]
    fn version_one_evidence_cannot_attest_a_different_runtime_edge() {
        let snapshot = mock_snapshot();
        let edge = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new(), "test")
            .edges
            .into_iter()
            .find(|edge| {
                edge.relationship == RuntimeRelationshipKind::ConnectedTo
                    && !edge.evidence_refs.is_empty()
            })
            .expect("mock snapshot emits a Docker network edge");
        let mut malformed = serde_json::to_value(edge).expect("edge serializes");
        malformed["relationship"] = serde_json::json!("exposes");

        assert!(
            serde_json::from_value::<RuntimeMapEdge>(malformed).is_err(),
            "network membership evidence must not attest a port-publication edge"
        );
    }

    #[test]
    fn collision_resistant_topology_ids_preserve_distinct_raw_identities() {
        // Every raw identity below used to collide after lowercasing and
        // punctuation/control replacement. Docker inventory, Compose services,
        // bind paths, and package-shaped identifiers must remain distinct.
        let identities = [
            "sol-r4-a-b",
            "sol-r4-a_b",
            "SOL-R4-A",
            "sol-r4-a",
            "bidi\u{202e}value",
            "bidi\u{202d}value",
            "/srv/sol-r4-a-b",
            "/srv/sol-r4-a_b",
            "@scope/sol-r4-a-b",
            "@scope_sol-r4-a-b",
        ];

        let mut snapshot = mock_snapshot();
        snapshot.volumes = identities
            .iter()
            .map(|identity| VolumeRecord {
                id: (*identity).into(),
                name: (*identity).into(),
                attached_to: Vec::new(),
            })
            .collect();
        let runtime_map = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new(), "test");
        let volume_ids = runtime_map
            .nodes
            .iter()
            .filter(|node| node.kind == RuntimeNodeKind::DockerVolume)
            .map(|node| node.id.as_str())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            volume_ids.len(),
            identities.len(),
            "distinct Docker volume identities must not merge"
        );

        let scan = ComposeScan {
            files: Vec::new(),
            project_root: "/project".into(),
            services: identities
                .iter()
                .map(|identity| ComposeService {
                    name: (*identity).into(),
                    image: None,
                    environment: BTreeMap::new(),
                    depends_on: Vec::new(),
                })
                .collect(),
            mounts: identities
                .iter()
                .enumerate()
                .map(|(index, identity)| ComposeMount {
                    id: format!("mount-{index}"),
                    service: (*identity).into(),
                    kind: ComposeMountKind::Bind,
                    source: Some((*identity).into()),
                    resolved_source: Some((*identity).into()),
                    target: format!("/target/{index}"),
                    read_only: false,
                    origin: ComposeFileOrigin {
                        file: "/project/compose.yaml".into(),
                        service: Some((*identity).into()),
                        field: format!("services.{index}.volumes"),
                    },
                })
                .collect(),
            correlations: Vec::new(),
            diagnostics: Vec::new(),
        };
        let graph = derive_compose_graph(&scan);
        let service_nodes = graph
            .nodes
            .iter()
            .filter(|node| node.kind == ComposeNodeKind::Service)
            .collect::<Vec<_>>();
        let host_path_nodes = graph
            .nodes
            .iter()
            .filter(|node| node.kind == ComposeNodeKind::HostPath)
            .collect::<Vec<_>>();
        assert_eq!(service_nodes.len(), identities.len());
        assert_eq!(host_path_nodes.len(), identities.len());
        assert_eq!(
            service_nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<BTreeSet<_>>()
                .len(),
            identities.len()
        );
        assert_eq!(
            host_path_nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<BTreeSet<_>>()
                .len(),
            identities.len()
        );
    }

    #[test]
    fn container_listener_ids_include_the_container_identity() {
        let mut snapshot = mock_snapshot();
        snapshot.containers = snapshot.containers[..2].to_vec();
        for (container, (id, name)) in snapshot
            .containers
            .iter_mut()
            .zip([("container_one", "one"), ("container_two", "two")])
        {
            container.id = id.into();
            container.name = name.into();
            container.ports = vec!["8080/tcp".into()];
        }
        snapshot.networks.clear();
        snapshot.volumes.clear();

        let runtime_map = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new(), "test");
        let listeners = runtime_map
            .nodes
            .iter()
            .filter(|node| node.kind == RuntimeNodeKind::NetworkListener)
            .collect::<Vec<_>>();

        assert_eq!(
            listeners.len(),
            2,
            "each container port is a distinct runtime entity"
        );
        assert_eq!(
            listeners
                .iter()
                .map(|node| node.id.as_str())
                .collect::<BTreeSet<_>>()
                .len(),
            2,
            "equivalent port text must not collapse listeners belonging to distinct containers"
        );
        assert!(runtime_map.diagnostics.iter().all(|diagnostic| {
            !diagnostic
                .message
                .contains("Duplicate generated runtime topology ID")
        }));
    }

    #[test]
    fn private_container_ports_remain_listeners_without_host_publication_evidence() {
        let mut snapshot = mock_snapshot();
        snapshot.containers = vec![ContainerRecord {
            id: "private-port-container".into(),
            name: "private-port".into(),
            image: "example:latest".into(),
            status: "running".into(),
            role: "service".into(),
            networks: Vec::new(),
            ports: vec!["80/tcp".into()],
            mounts: Vec::new(),
            depends_on: Vec::new(),
        }];
        snapshot.networks.clear();
        snapshot.volumes.clear();

        let runtime_map = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new(), "test");
        let listener = runtime_map
            .nodes
            .iter()
            .find(|node| node.kind == RuntimeNodeKind::NetworkListener)
            .expect("private container port remains visible as a listener");
        assert_eq!(
            listener.metadata.get("port").map(String::as_str),
            Some("80/tcp")
        );
        let edge = runtime_map
            .edges
            .iter()
            .find(|edge| edge.target == listener.id)
            .expect("private listener remains connected to its container");
        assert!(
            edge.evidence_refs.is_empty(),
            "private-only listener has no host-publication attestation"
        );

        let serialized = serde_json::to_string(&runtime_map).expect("runtime map serializes");
        assert!(!serialized.contains("Docker reported container port publication"));
        assert!(!serialized.contains("docker_port_publication"));
    }

    #[test]
    fn nonzero_host_bindings_receive_bounded_publication_evidence() {
        let mut snapshot = mock_snapshot();
        snapshot.containers = vec![ContainerRecord {
            id: "published-port-container".into(),
            name: "published-port".into(),
            image: "example:latest".into(),
            status: "running".into(),
            role: "service".into(),
            networks: Vec::new(),
            ports: vec!["8443:443/tcp".into(), "0:53/udp".into(), "53/udp".into()],
            mounts: Vec::new(),
            depends_on: Vec::new(),
        }];
        snapshot.networks.clear();
        snapshot.volumes.clear();

        let runtime_map = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new(), "test");
        let publication_edges = runtime_map
            .edges
            .iter()
            .filter(|edge| {
                edge.evidence_refs
                    .iter()
                    .any(|evidence| evidence.kind == RuntimeEvidenceKind::DockerPortPublication)
            })
            .collect::<Vec<_>>();
        assert_eq!(publication_edges.len(), 1);
        assert_eq!(
            publication_edges[0].evidence_refs[0].summary,
            "Docker reported container port publication"
        );
        assert!(publication_edges[0].has_valid_evidence_refs());
        let serialized =
            serde_json::to_string(publication_edges[0]).expect("publication edge serializes");
        assert!(
            !serialized.contains("8443:443/tcp"),
            "evidence itself never copies port data"
        );
    }

    #[test]
    fn equivalent_reordered_snapshots_produce_the_same_runtime_topology() {
        let first = mock_snapshot();
        let mut reordered = first.clone();
        reordered.containers.reverse();
        reordered.networks.reverse();
        reordered.volumes.reverse();

        let first_map = derive_runtime_map(&first, Vec::new(), Vec::new(), Vec::new(), "test");
        let reordered_map =
            derive_runtime_map(&reordered, Vec::new(), Vec::new(), Vec::new(), "test");

        assert_eq!(reordered_map.nodes, first_map.nodes);
        assert_eq!(reordered_map.edges, first_map.edges);
        assert_eq!(reordered_map.diagnostics, first_map.diagnostics);
    }

    #[test]
    fn malformed_duplicate_runtime_ids_remain_visible_and_diagnostic() {
        let mut snapshot = mock_snapshot();
        snapshot.volumes = vec![
            VolumeRecord {
                id: "duplicate-volume".into(),
                name: "first".into(),
                attached_to: Vec::new(),
            },
            VolumeRecord {
                id: "duplicate-volume".into(),
                name: "second".into(),
                attached_to: Vec::new(),
            },
        ];

        let runtime_map = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new(), "test");
        let duplicated = runtime_map
            .nodes
            .iter()
            .filter(|node| node.kind == RuntimeNodeKind::DockerVolume)
            .collect::<Vec<_>>();

        assert_eq!(
            duplicated.len(),
            2,
            "malformed records must remain visible instead of being discarded"
        );
        assert!(runtime_map.diagnostics.iter().any(|diagnostic| {
            diagnostic
                .message
                .contains("remain visible and non-routable")
        }));
    }

    #[test]
    fn daemon_emitted_runtime_map_round_trips_through_json() {
        // Round-trip the REAL daemon derivation path (mock snapshot → map →
        // JSON → Rust) instead of a hand-written fixture, so the contract test
        // validates output collectors actually produce.
        let snapshot = mock_snapshot();
        let runtime_map = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new(), "test");

        let serialized = serde_json::to_string(&runtime_map).expect("map should serialize");
        let deserialized: RuntimeMap =
            serde_json::from_str(&serialized).expect("map JSON should deserialize");
        assert_eq!(
            deserialized, runtime_map,
            "JSON round-trip must be lossless"
        );

        assert!(
            !serialized.contains("\"status\":\"unknown\""),
            "mock containers serialize their real status"
        );

        let container = deserialized
            .nodes
            .iter()
            .find(|node| node.kind == RuntimeNodeKind::Container)
            .expect("mock snapshot yields container nodes");
        assert_eq!(container.layer, Some(RuntimeNodeLayer::Container));
        let service = container
            .service
            .as_ref()
            .expect("container nodes carry a service entity");
        assert_eq!(service.status, RuntimeServiceStatus::Running);
        assert_eq!(service.name, container.label);
    }

    #[test]
    fn contract_fixtures_deserialize_into_rust_types() {
        let snapshot: DockerSnapshot = read_contract_fixture("mock-snapshot.json");
        let compose_scan: ComposeScan = read_contract_fixture("compose-scan.json");
        let compose_graph: ComposeGraph = read_contract_fixture("compose-graph.json");
        let runtime_map: RuntimeMap = read_contract_fixture("runtime-map.json");
        let expanded_runtime_map: RuntimeMap = read_contract_fixture("runtime-map-expanded.json");

        assert_eq!(
            snapshot.containers[0].mounts[0].kind,
            ComposeMountKind::Bind
        );
        assert_eq!(
            compose_scan.correlations[0].status,
            MountCorrelationStatus::Matched
        );
        assert_eq!(
            compose_graph.edges[0].relationship,
            ComposeRelationshipKind::DeclaresMount
        );
        assert_eq!(runtime_map.nodes[0].provider, RuntimeProviderKind::Docker);
        assert!(expanded_runtime_map
            .nodes
            .iter()
            .any(|node| node.provider == RuntimeProviderKind::Cloudflare));
        assert!(expanded_runtime_map
            .edges
            .iter()
            .any(|edge| edge.relationship == RuntimeRelationshipKind::Wants));
    }

    #[test]
    fn scans_compose_fixture_mounts_and_diagnostics() {
        let root = repo_fixture_path(&["tests", "fixtures", "compose"]);
        let file = root.join("path-mapping.compose.yaml");
        let scan = scan_compose_files(&root, &[file]).expect("fixture should scan");

        assert_eq!(scan.services.len(), 2);
        assert_eq!(scan.mounts.len(), 7);
        assert!(scan.mounts.iter().any(|mount| {
            mount.service == "api"
                && mount.kind == ComposeMountKind::Bind
                && mount.target == "/workspace/src"
        }));
        assert!(scan.mounts.iter().any(|mount| {
            mount.service == "api"
                && mount.kind == ComposeMountKind::NamedVolume
                && mount.source.as_deref() == Some("api-cache")
        }));
        assert!(scan
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "compose_missing_bind_source"));
    }

    #[test]
    fn handles_windows_drive_short_volume_syntax() {
        let parts = split_short_volume(r"C:\Users\me\project:/workspace:ro");
        assert_eq!(parts, vec![r"C:\Users\me\project", "/workspace", "ro"]);
    }

    #[test]
    fn reports_duplicate_container_targets() {
        let root = PathBuf::from("/tmp/dockermap-test");
        let file = root.join("compose.yaml");
        let yaml = r#"
services:
  api:
    volumes:
      - ./a:/workspace
      - ./b:/workspace
"#;
        let scan = scan_content(&file, &root, yaml);

        assert_eq!(
            scan.diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.id == "compose_duplicate_target")
                .count(),
            2
        );
    }

    #[test]
    fn flags_unsafe_bind_sources() {
        let root = PathBuf::from("/tmp/dockermap-unsafe");
        let file = root.join("compose.yaml");
        let yaml = r#"
services:
  docker-cli:
    image: docker:cli
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /var/lib/docker:/var/lib/docker:ro
      - /etc:/host/etc:ro
      - /root/.ssh:/root/.ssh:ro
      - ./data:/workspace
      - /home/jon/project/data:/workspace2
"#;
        let scan = scan_content(&file, &root, yaml);

        let unsafe_diagnostics = scan
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.id == "compose_unsafe_bind_source")
            .collect::<Vec<_>>();

        assert_eq!(
            unsafe_diagnostics.len(),
            4,
            "docker.sock, docker data, /etc, and .ssh should be flagged: {unsafe_diagnostics:?}"
        );
        assert_eq!(
            unsafe_diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.severity == DiagnosticSeverity::Blocked)
                .count(),
            3
        );
        assert_eq!(
            unsafe_diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.severity == DiagnosticSeverity::Warning)
                .count(),
            1
        );
        let safe_paths_flagged = unsafe_diagnostics.iter().any(|diagnostic| {
            diagnostic.message.contains("./data")
                || diagnostic.message.contains("/home/jon/project/data")
        });
        assert!(
            !safe_paths_flagged,
            "project-local and user-project bind sources must not be flagged"
        );
    }

    #[test]
    fn tilde_bind_sources_resolve_under_home_and_flag_credentials() {
        let base_dir = Path::new("/project");
        let home = std::env::var("HOME").expect("HOME must be set for this test");

        let data = resolve_source(base_dir, &ComposeMountKind::Bind, Some("~/data"))
            .expect("~/data should resolve");
        assert_eq!(data, format!("{home}/data"));
        assert!(
            !data.contains("/project/"),
            "~/data must resolve under $HOME, not the project dir: {data}"
        );

        let ssh = resolve_source(base_dir, &ComposeMountKind::Bind, Some("~/.ssh"))
            .expect("~/.ssh should resolve");
        assert_eq!(ssh, format!("{home}/.ssh"));

        // The unsafe-bind check operates on the EXPANDED path, so `~/.ssh` is
        // flagged as credential material instead of being reported "missing".
        let (severity, message) = unsafe_bind_source_diagnostic(&ssh)
            .expect("~/.ssh must be flagged as credential material");
        assert_eq!(severity, DiagnosticSeverity::Blocked);
        assert!(message.contains("credential material"), "{message}");
    }

    #[test]
    fn malformed_compose_fixtures_emit_expected_diagnostics() {
        let cases = [
            (
                "duplicate-target.compose.yaml",
                "compose_duplicate_target",
                DiagnosticSeverity::Error,
            ),
            (
                "invalid-target.compose.yaml",
                "compose_invalid_container_target",
                DiagnosticSeverity::Error,
            ),
            (
                "invalid-volumes.compose.yaml",
                "compose_invalid_volumes",
                DiagnosticSeverity::Error,
            ),
            (
                "missing-services.compose.yaml",
                "compose_missing_services",
                DiagnosticSeverity::Error,
            ),
            (
                "missing-target.compose.yaml",
                "compose_mount_missing_target",
                DiagnosticSeverity::Error,
            ),
            (
                "unresolved-variable.compose.yaml",
                "compose_unresolved_variable",
                DiagnosticSeverity::Warning,
            ),
            (
                "unsupported-mount.compose.yaml",
                "compose_unsupported_mount_type",
                DiagnosticSeverity::Warning,
            ),
            (
                "unsafe-bind-source.compose.yaml",
                "compose_unsafe_bind_source",
                DiagnosticSeverity::Blocked,
            ),
            (
                "yaml-parse-error.compose.yaml",
                "compose_yaml_parse_error",
                DiagnosticSeverity::Blocked,
            ),
        ];

        for (fixture, expected_id, expected_severity) in cases {
            let scan = scan_invalid_fixture(fixture);
            assert!(
                scan.diagnostics.iter().any(|diagnostic| {
                    diagnostic.id == expected_id && diagnostic.severity == expected_severity
                }),
                "expected {expected_id}/{expected_severity:?} for {fixture}, got {:?}",
                scan.diagnostics
            );
        }

        let duplicate_scan = scan_invalid_fixture("duplicate-target.compose.yaml");
        assert_eq!(
            duplicate_scan
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.id == "compose_duplicate_target")
                .count(),
            2
        );
    }

    #[test]
    fn empty_compose_file_list_returns_warning_scan() {
        let root = PathBuf::from("/tmp/dockermap-empty-compose");
        let scan =
            scan_compose_files(&root, &[]).expect("empty file list should be diagnostic only");

        assert!(scan.services.is_empty());
        assert!(scan.mounts.is_empty());
        assert!(scan
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "compose_no_files"
                && diagnostic.severity == DiagnosticSeverity::Warning));
    }

    #[cfg(unix)]
    #[test]
    fn reports_symlink_bind_sources_without_following() {
        let root = tempfile::TempDir::new().expect("temp dir should be created");
        let real_dir = root.path().join("real-data");
        let linked_dir = root.path().join("linked-data");
        std::fs::create_dir_all(&real_dir).expect("real source should be created");
        std::os::unix::fs::symlink(&real_dir, &linked_dir)
            .expect("symlink source should be created");
        let file = root.path().join("compose.yaml");
        std::fs::write(
            &file,
            r#"
services:
  api:
    image: alpine
    volumes:
      - ./linked-data:/workspace/data
"#,
        )
        .expect("compose fixture should be written");

        let scan =
            scan_compose_files(root.path(), std::slice::from_ref(&file)).expect("scan should pass");

        assert!(scan
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "compose_bind_source_symlink"
                && diagnostic.severity == DiagnosticSeverity::Warning));
    }

    #[test]
    fn rejects_oversized_compose_file_before_parsing() {
        let root = std::env::temp_dir().join(format!(
            "dockermap-oversized-compose-{}",
            unix_timestamp_millis()
        ));
        std::fs::create_dir_all(&root).expect("temp dir should be created");
        let file = root.join("compose.yaml");
        std::fs::write(&file, vec![b'a'; (MAX_COMPOSE_FILE_BYTES + 1) as usize])
            .expect("oversized fixture should be written");

        let error = scan_compose_files(&root, std::slice::from_ref(&file))
            .expect_err("oversized file should be rejected");
        assert!(error.contains("too large"));

        let _ = std::fs::remove_file(file);
        let _ = std::fs::remove_dir(root);
    }

    #[test]
    fn derives_compose_graph_from_scan() {
        let root = repo_fixture_path(&["tests", "fixtures", "compose"]);
        let file = root.join("path-mapping.compose.yaml");
        let scan = scan_compose_files(&root, &[file]).expect("fixture should scan");
        let graph = derive_compose_graph(&scan);

        assert!(graph
            .nodes
            .iter()
            .any(|node| node.kind == ComposeNodeKind::Service && node.label == "api"));
        assert!(graph
            .nodes
            .iter()
            .any(|node| node.kind == ComposeNodeKind::HostPath));
        assert!(graph
            .nodes
            .iter()
            .any(|node| node.kind == ComposeNodeKind::NamedVolume));
        assert!(graph
            .edges
            .iter()
            .any(|edge| edge.relationship == ComposeRelationshipKind::MountedAt));
    }

    #[test]
    fn coalesces_compose_override_services() {
        let root = repo_fixture_path(&["tests", "fixtures", "compose"]);
        let base = root.join("path-mapping.compose.yaml");
        let override_file = root.join("override.compose.yaml");
        let scan = scan_compose_files(&root, &[base, override_file]).expect("fixtures should scan");

        assert_eq!(scan.services.len(), 2);
        let api = scan
            .services
            .iter()
            .find(|service| service.name == "api")
            .expect("api service should exist once");
        assert_eq!(api.image.as_deref(), Some("python:3.12-slim"));
        assert!(scan.mounts.iter().any(|mount| {
            mount.service == "api"
                && mount.target == "/workspace/config"
                && mount.read_only
                && mount.origin.file.ends_with("override.compose.yaml")
        }));
        let worker = scan
            .services
            .iter()
            .find(|service| service.name == "worker")
            .expect("worker service should exist once");
        assert_eq!(
            worker.environment.get("WORKER_MODE").map(String::as_str),
            Some("fixture")
        );
    }

    #[test]
    fn correlates_compose_mounts_with_runtime_mounts() {
        let root = tempfile::TempDir::new().expect("temp dir should be created");
        let source_dir = root.path().join("src");
        std::fs::create_dir_all(&source_dir).expect("source dir should be created");
        let file = root.path().join("compose.yaml");
        std::fs::write(
            &file,
            r#"
services:
  api:
    image: alpine
    volumes:
      - ./src:/app/src
"#,
        )
        .expect("compose fixture should be written");

        let scan =
            scan_compose_files(root.path(), std::slice::from_ref(&file)).expect("scan should pass");
        let snapshot = DockerSnapshot {
            containers: vec![ContainerRecord {
                id: "runtime-api".into(),
                name: "api".into(),
                image: "alpine".into(),
                status: "running".into(),
                role: "api".into(),
                networks: Vec::new(),
                ports: Vec::new(),
                mounts: vec![
                    ContainerMount {
                        id: "runtime-api:/app/src".into(),
                        kind: ComposeMountKind::Bind,
                        source: Some(display_path(&source_dir)),
                        target: "/app/src".into(),
                        read_only: false,
                    },
                    ContainerMount {
                        id: "runtime-api:/tmp/cache".into(),
                        kind: ComposeMountKind::AnonymousVolume,
                        source: None,
                        target: "/tmp/cache".into(),
                        read_only: false,
                    },
                ],
                depends_on: Vec::new(),
            }],
            images: Vec::new(),
            networks: Vec::new(),
            volumes: Vec::new(),
            last_updated: 1,
            ..Default::default()
        };

        let correlations = correlate_compose_runtime(&scan, &snapshot);
        assert!(correlations.iter().any(
            |item| item.status == MountCorrelationStatus::Matched && item.target == "/app/src"
        ));
        assert!(correlations.iter().any(
            |item| item.status == MountCorrelationStatus::Extra && item.target == "/tmp/cache"
        ));
    }

    #[test]
    fn plans_bind_mount_edit_without_writing() {
        let file = PathBuf::from("/tmp/compose.yaml");
        let content = r#"
services:
  api:
    volumes:
      - ./src:/workspace/src:ro
"#;
        let scan = scan_content(&file, Path::new("/tmp"), content);

        let plan = plan_compose_mount_edit(
            &file,
            content,
            &scan.mounts[0],
            Some("./app"),
            Some("/workspace/app"),
        );

        assert!(!plan.will_write);
        assert!(plan
            .unified_diff
            .contains("-      - ./src:/workspace/src:ro"));
        assert!(plan
            .unified_diff
            .contains("+      - ./app:/workspace/app:ro"));
    }

    #[test]
    fn blocks_parent_traversal_in_planned_source() {
        let file = PathBuf::from("/tmp/compose.yaml");
        let content = r#"
services:
  api:
    volumes:
      - ./src:/workspace/src:ro
"#;
        let scan = scan_content(&file, Path::new("/tmp"), content);

        let plan =
            plan_compose_mount_edit(&file, content, &scan.mounts[0], Some("../secrets"), None);

        assert!(plan.unified_diff.is_empty());
        assert!(plan
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "edit_source_parent_traversal"));
    }

    #[test]
    fn blocks_ambiguous_mount_line_replacements() {
        let file = PathBuf::from("/tmp/compose.yaml");
        let content = r#"
services:
  api:
    environment:
      NOTE: "./src:/workspace/src appears in documentation"
    volumes:
      - ./src:/workspace/src:ro
"#;
        let scan = scan_content(&file, Path::new("/tmp"), content);

        let plan = plan_compose_mount_edit(&file, content, &scan.mounts[0], Some("./app"), None);

        assert!(plan.unified_diff.is_empty());
        assert!(plan
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "edit_original_source_not_found"));
    }

    #[test]
    fn edit_plan_reports_noop_without_writing() {
        let file = PathBuf::from("/tmp/compose.yaml");
        let content = r#"
services:
  api:
    volumes:
      - ./src:/workspace/src
"#;
        let scan = scan_content(&file, Path::new("/tmp"), content);

        let plan = plan_compose_mount_edit(&file, content, &scan.mounts[0], None, None);

        assert!(!plan.will_write);
        assert!(plan.unified_diff.is_empty());
        assert!(plan
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "edit_noop"
                && diagnostic.severity == DiagnosticSeverity::Error));
    }

    #[test]
    fn edit_plan_blocks_invalid_target_without_diff() {
        let file = PathBuf::from("/tmp/compose.yaml");
        let content = r#"
services:
  api:
    volumes:
      - ./src:/workspace/src
"#;
        let scan = scan_content(&file, Path::new("/tmp"), content);

        let plan =
            plan_compose_mount_edit(&file, content, &scan.mounts[0], None, Some("relative/path"));

        assert!(plan.unified_diff.is_empty());
        assert!(plan
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "edit_invalid_target"
                && diagnostic.severity == DiagnosticSeverity::Blocked));
    }

    #[test]
    fn edit_plan_blocks_named_volume_source_changes() {
        let file = PathBuf::from("/tmp/compose.yaml");
        let content = r#"
services:
  api:
    volumes:
      - cache:/workspace/cache
"#;
        let scan = scan_content(&file, Path::new("/tmp"), content);

        let plan = plan_compose_mount_edit(&file, content, &scan.mounts[0], Some("./cache"), None);

        assert!(plan.unified_diff.is_empty());
        assert!(plan
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "edit_source_requires_bind"
                && diagnostic.severity == DiagnosticSeverity::Blocked));
    }

    fn read_contract_fixture<T: serde::de::DeserializeOwned>(name: &str) -> T {
        let path = repo_fixture_path(&["tests", "fixtures", "contracts", name]);
        let content = std::fs::read_to_string(&path).expect("contract fixture should be readable");
        serde_json::from_str(&content).expect("contract fixture should deserialize")
    }
}
