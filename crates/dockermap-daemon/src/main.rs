mod auth;
mod cache_refresh;
mod compose_api;
mod config;
mod daemon_api;
mod docker_collector;
mod docker_config;
mod docker_events;
mod pid_namespace;
mod process_runner;
mod provider_contract;
mod providers;
mod publication;
mod runtime_collection;
#[cfg(test)]
use axum::{http::StatusCode, response::IntoResponse};
#[cfg(test)]
use bollard::Docker;
pub(crate) use cache_refresh::AppState;
#[cfg(test)]
use cache_refresh::DaemonCache;
use cache_refresh::{refresh_cache, refresh_loop};
use compose_api::run_cli;
use config::{read_bind_host_env, read_daemon_token_env, read_port_env, DaemonAuthToken};
use daemon_api::daemon_router;
pub(crate) use daemon_api::ApiError;
#[cfg(test)]
use daemon_api::{
    docker_log_collection_failed, parse_log_cursor, parse_log_limit, validate_optional_query,
    MAX_LOG_QUERY_CHARS,
};
#[cfg(test)]
use docker_collector::publish_log_response;
#[cfg(test)]
use docker_collector::DockerCollector;
#[cfg(test)]
use docker_collector::{
    log_entry_id, log_tail_count, log_until_seconds, parse_depends_on_label,
    parse_timestamped_log_line, MAX_LOG_CURSOR_TAIL,
};
use docker_events::docker_event_loop;
#[cfg(test)]
use dockermap_core::mock_log_entries;
#[cfg(test)]
use dockermap_core::{
    derive_runtime_map, page_log_entries, ComposeFileOrigin, ComposeMountKind, ContainerMount,
    DiagnosticSeverity, LogCursor, LogEntry, NetworkRecord, RuntimeEvidenceAssertionKind,
    RuntimeEvidenceFreshness, RuntimeEvidenceKind, RuntimeEvidenceProvider, RuntimeEvidenceRef,
    RuntimeMapDiagnostic, RuntimeMapEdge, RuntimeMapNode, RuntimeNodeKind, RuntimeNodeLayer,
    RuntimeOwnership, RuntimePackageEntity, RuntimeProviderKind, RuntimeRelationshipKind,
    RuntimeServiceEntity, RuntimeServiceStatus, VolumeRecord, DEFAULT_LOG_PAGE_SIZE,
    MAX_LOG_PAGE_SIZE,
};
#[cfg(test)]
use dockermap_core::{mock_snapshot, HealthResponse, HealthState, RuntimeMap, RuntimeMode};
#[cfg(test)]
use pid_namespace::{
    cgroup_implies_container, pid_namespace_scope_from_evidence, restricted_pid_namespace_evidence,
    PidNamespaceMode, PidNamespaceScope,
};
#[cfg(test)]
use process_runner::read_bounded;
#[cfg(test)]
use providers::processes::{
    collect_native_processes_from_output, collect_native_processes_with_command,
    collect_python_processes_from_output, collect_python_processes_with_command,
    collect_python_processes_with_command_in_scope, complete_provider_lines, is_native_process,
    is_python_process, native_process_nodes_from_ps_output, parse_ps_table, process_comm,
    python_entry, python_nodes_from_ps_output, python_nodes_from_ps_output_with_container_filter,
    real_comm, MAX_NATIVE_PROCESSES, MAX_PYTHON_PROCESSES,
};
use publication::*;
use std::net::SocketAddr;
#[cfg(test)]
use std::path::PathBuf;
#[cfg(test)]
use std::time::Duration;
#[cfg(test)]
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    sync::Arc,
};
use tokio::net::TcpListener;
#[cfg(test)]
use tokio::sync::RwLock;

const CLI_USAGE: &str = "\
DockerMap daemon — read-only Docker/host inspector

USAGE:
    dockermap-daemon [COMMAND] [OPTIONS]

COMMANDS:
    scan       Print a Compose project scan as JSON
    validate   Print Compose diagnostics (exits 1 when blocking findings exist)
    export     Export a Compose project scan (--format json)

OPTIONS:
    -h, --help       Print help
    --version        Print version

With no COMMAND, the daemon starts its loopback HTTP server (default port 4100).
";

#[tokio::main]
async fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();

    if let Some(command) = args.first() {
        match command.as_str() {
            "--help" | "-h" => {
                print!("{CLI_USAGE}");
                std::process::exit(0);
            }
            "--version" => {
                println!("dockermap-daemon {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            "scan" | "validate" | "export" => match run_cli(command, &args[1..]) {
                Ok(code) => std::process::exit(code),
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(2);
                }
            },
            unknown => {
                eprintln!("unknown command `{unknown}`\n\n{CLI_USAGE}");
                std::process::exit(2);
            }
        }
    }

    let daemon_token = read_daemon_token_env();
    let port = read_port_env("DOCKERMAP_DAEMON_PORT", 4100);
    let host = read_bind_host_env("DOCKERMAP_DAEMON_HOST", daemon_token.0.is_some());
    let address = SocketAddr::from((host, port));
    let state = AppState::new();

    refresh_cache(&state).await;
    tokio::spawn(refresh_loop(state.clone()));
    tokio::spawn(docker_event_loop(state.clone()));

    let app = daemon_router(state, daemon_token);
    let listener = TcpListener::bind(address)
        .await
        .expect("daemon listener should bind");

    println!("dockermap-daemon listening on http://{address}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("daemon server should run");
}

async fn shutdown_signal() {
    // systemd sends SIGTERM (KillSignal) and Docker's stop signal defaults to
    // SIGTERM; ctrl_c alone left `systemctl stop` hanging until SIGKILL.
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("SIGTERM handler should install");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::process_runner::{run_command_with_timeout, MAX_PROVIDER_OUTPUT_BYTES};
    use axum::extract::Request;
    use dockermap_core::{
        derive_compose_graph, scan_compose_files, ComposeDiagnostic, ComposeEditPlan, ComposeMount,
        ComposeScan, RuntimeAdvisorySeverity, RuntimeEventRef, RuntimeLogLevel, RuntimeLogRef,
        RuntimeOwnershipKind, RuntimePackageAdvisory, RuntimePackageUpdate,
    };
    use std::{collections::HashSet, process::Command};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::UnixListener,
    };
    use tower::util::ServiceExt;

    fn test_daemon_state() -> AppState {
        AppState {
            cache: Arc::new(RwLock::new(DaemonCache::mock())),
            docker: Arc::new(RwLock::new(None)),
            provider_slot_in_flight: Arc::new(crate::cache_refresh::ProviderSlotFlights::default()),
        }
    }

    #[tokio::test]
    async fn daemon_bearer_boundary_allows_only_the_exact_configured_token() {
        let allowed = daemon_router(test_daemon_state(), DaemonAuthToken(None))
            .oneshot(
                Request::builder()
                    .uri("/daemon/health")
                    .body(axum::body::Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("daemon router should respond");
        assert_eq!(allowed.status(), StatusCode::OK);

        for header in [
            None,
            Some("Bearer wrong-token"),
            Some("bearer expected-token"),
            Some("Bearer expected-token extra"),
            Some("Basic expected-token"),
        ] {
            let mut request = Request::builder().uri("/daemon/health");
            if let Some(header) = header {
                request = request.header("Authorization", header);
            }
            let response = daemon_router(
                test_daemon_state(),
                DaemonAuthToken(Some(Arc::<str>::from("expected-token"))),
            )
            .oneshot(
                request
                    .body(axum::body::Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("daemon router should respond");
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "header={header:?}"
            );
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("unauthorized body should be readable");
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&body)
                    .expect("unauthorized body should be JSON"),
                serde_json::json!({
                    "code": "unauthorized",
                    "message": "A valid Bearer token is required for this DockerMap daemon route"
                })
            );
        }

        let accepted = daemon_router(
            test_daemon_state(),
            DaemonAuthToken(Some(Arc::<str>::from("expected-token"))),
        )
        .oneshot(
            Request::builder()
                .uri("/daemon/health")
                .header("Authorization", "Bearer expected-token")
                .body(axum::body::Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("daemon router should respond");
        assert_eq!(accepted.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn observed_docker_events_route_publishes_only_the_unavailable_mock_shape() {
        let response = daemon_router(test_daemon_state(), DaemonAuthToken(None))
            .oneshot(
                Request::builder()
                    .uri("/daemon/observed-events")
                    .body(axum::body::Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("daemon router should respond");
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body should be readable");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body)
                .expect("observed event response should be JSON"),
            serde_json::json!({
                "source": "mock",
                "collectionState": "unavailable",
                "currentModelRevision": null,
                "currentObservationRevision": null,
                "events": []
            })
        );
    }

    #[test]
    fn docker_stub_log_errors_have_a_fixed_location_neutral_client_message() {
        // Mirrors the body returned by a Unix-socket Docker stub during logs
        // collection: provider text is diagnostic-only and never a response.
        let provider_error = "Docker stub 500: /srv/private/docker.log via 10.1.2.3:2375 token=DOCKERMAP_TEST_FAKE_SOL6_DOCKER_ERROR_SECRET";
        let error = docker_log_collection_failed(provider_error);
        assert_eq!(error.status, StatusCode::BAD_GATEWAY);
        assert_eq!(error.message, "Docker log collection failed");
        for forbidden in [
            "/srv/private/docker.log",
            "10.1.2.3:2375",
            "DOCKERMAP_TEST_FAKE_SOL6_DOCKER_ERROR_SECRET",
        ] {
            assert!(
                !error.message.contains(forbidden),
                "Docker-provider detail leaked into client error: {}",
                error.message
            );
        }
    }

    #[tokio::test]
    async fn daemon_logs_route_redacts_hostile_bollard_error_from_into_response() {
        let tempdir = tempfile::tempdir().expect("temporary Docker socket directory");
        let socket_path = tempdir.path().join("docker.sock");
        let listener = UnixListener::bind(&socket_path).expect("Docker stub should bind");
        let hostile = "Docker stub 500: /srv/private/docker.log via 10.1.2.3:2375 token=DOCKERMAP_TEST_FAKE_SOL6_DOCKER_ERROR_SECRET\u{202e}\u{001b}\u{200b}";
        let response_body = serde_json::json!({ "message": hostile }).to_string();

        let stub = tokio::spawn(async move {
            let (mut stream, _) = listener
                .accept()
                .await
                .expect("Docker request should arrive");
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = stream
                    .read(&mut chunk)
                    .await
                    .expect("Docker request should be readable");
                assert!(read > 0, "Docker client should send request headers");
                request.extend_from_slice(&chunk[..read]);
            }
            let response = format!(
                "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            stream
                .write_all(response.as_bytes())
                .await
                .expect("Docker stub response should be written");
        });

        let mut cache = DaemonCache::mock();
        cache.health.docker_reachable = true;
        let state = AppState {
            cache: Arc::new(RwLock::new(cache)),
            docker: Arc::new(RwLock::new(Some(DockerCollector::with_client(
                Docker::connect_with_unix(
                    socket_path.to_str().expect("socket path should be UTF-8"),
                    2,
                    bollard::API_DEFAULT_VERSION,
                )
                .expect("Bollard should connect to the Unix stub"),
                None,
            )))),
            provider_slot_in_flight: Arc::new(crate::cache_refresh::ProviderSlotFlights::default()),
        };

        let response = daemon_router(state, DaemonAuthToken(None))
            .oneshot(
                Request::builder()
                    .uri("/daemon/logs?service=api")
                    .body(axum::body::Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("daemon router should respond");
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("ApiError response body should be readable");
        let published = String::from_utf8(body.to_vec()).expect("response should be UTF-8 JSON");
        assert!(published.contains("Docker log collection failed"));
        assert!(!published.contains("/srv/private/docker.log"));
        assert!(!published.contains("10.1.2.3:2375"));
        assert!(!published.contains("DOCKERMAP_TEST_FAKE_SOL6_DOCKER_ERROR_SECRET"));
        assert!(!published.chars().any(|character| {
            let code = character as u32;
            code <= 0x1f || (0x7f..=0x9f).contains(&code) || (0x200b..=0x202e).contains(&code)
        }));

        stub.await.expect("Docker stub should finish");
    }

    /// This is the measured Bollard wire contract for the Docker Read Gateway
    /// planned in #62. It intentionally records the real requests emitted by
    /// the collector rather than deriving an allowlist from Bollard method
    /// names. Any client/library upgrade that changes a target, query, method,
    /// or adds negotiation traffic must make this test fail for review.
    #[tokio::test]
    async fn bollard_wire_contract_for_current_docker_reads() {
        let tempdir = tempfile::tempdir().expect("temporary Docker socket directory");
        let socket_path = tempdir.path().join("docker.sock");
        let listener = UnixListener::bind(&socket_path).expect("Docker stub should bind");

        let trace = tokio::spawn(async move {
            let mut requests = Vec::new();
            for _ in 0..5 {
                let (mut stream, _) = listener
                    .accept()
                    .await
                    .expect("Bollard request should arrive");
                let mut request = Vec::new();
                let mut chunk = [0_u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let read = stream
                        .read(&mut chunk)
                        .await
                        .expect("Bollard request should be readable");
                    assert!(read > 0, "Bollard request must include HTTP headers");
                    request.extend_from_slice(&chunk[..read]);
                }
                let request =
                    String::from_utf8(request).expect("Bollard request must be UTF-8 HTTP");
                let target = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .expect("Bollard request line must include a target")
                    .to_string();
                let body = if target.contains("/containers/json") || target.contains("/networks") {
                    "[]"
                } else if target.contains("/volumes") {
                    r#"{"Volumes":[],"Warnings":null}"#
                } else if target.contains("/containers/api/logs") {
                    ""
                } else {
                    panic!("unexpected Bollard target: {target}");
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                stream
                    .write_all(response.as_bytes())
                    .await
                    .expect("Docker stub response should be written");
                requests.push(
                    request
                        .lines()
                        .next()
                        .expect("request line recorded")
                        .to_string(),
                );
            }
            requests
        });

        let collector = DockerCollector::with_client(
            Docker::connect_with_unix(
                socket_path.to_str().expect("socket path should be UTF-8"),
                2,
                bollard::API_DEFAULT_VERSION,
            )
            .expect("Bollard should connect to the Unix stub"),
            None,
        );
        collector
            .collect_snapshot()
            .await
            .expect("list reads should succeed");
        collector
            .collect_logs("api", None, None, 100)
            .await
            .expect("bounded log read should succeed");
        collector
            .collect_logs(
                "api",
                None,
                Some(LogCursor {
                    millis: 1_706_000_123_456,
                    offset: 7,
                }),
                100,
            )
            .await
            .expect("bounded historical log read should succeed");

        let requests = trace.await.expect("wire trace should finish");
        assert_eq!(requests, vec![
            "GET /containers/json?all=true&size=false HTTP/1.1",
            "GET /networks? HTTP/1.1",
            "GET /volumes? HTTP/1.1",
            "GET /containers/api/logs?follow=false&stdout=true&stderr=true&since=0&until=0&timestamps=true&tail=4096 HTTP/1.1",
            "GET /containers/api/logs?follow=false&stdout=true&stderr=true&since=0&until=1706000124&timestamps=true&tail=4096 HTTP/1.1",
        ], "Bollard wire contract changed; update the gateway ADR and policy review before permitting a new request shape");
    }

    /// Docker label filtering is part of the gateway contract, not a collector
    /// convenience: the proxy must fail closed if the engine-side scope changes.
    #[tokio::test]
    async fn bollard_wire_contract_for_label_filtered_inventory() {
        let tempdir = tempfile::tempdir().expect("temporary Docker socket directory");
        let socket_path = tempdir.path().join("docker.sock");
        let listener = UnixListener::bind(&socket_path).expect("Docker stub should bind");
        let trace = tokio::spawn(async move {
            let mut requests = Vec::new();
            for _ in 0..3 {
                let (mut stream, _) = listener
                    .accept()
                    .await
                    .expect("Bollard request should arrive");
                let mut request = Vec::new();
                let mut chunk = [0_u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let read = stream
                        .read(&mut chunk)
                        .await
                        .expect("Bollard request should be readable");
                    assert!(read > 0, "Bollard request must include HTTP headers");
                    request.extend_from_slice(&chunk[..read]);
                }
                let request =
                    String::from_utf8(request).expect("Bollard request must be UTF-8 HTTP");
                let target = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .expect("Bollard request line must include a target")
                    .to_string();
                let body = if target.contains("/containers/json") || target.contains("/networks") {
                    "[]"
                } else if target.contains("/volumes") {
                    r#"{"Volumes":[],"Warnings":null}"#
                } else {
                    panic!("unexpected Bollard target: {target}");
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                stream
                    .write_all(response.as_bytes())
                    .await
                    .expect("Docker stub response should be written");
                requests.push(
                    request
                        .lines()
                        .next()
                        .expect("request line recorded")
                        .to_string(),
                );
            }
            requests
        });
        let collector = DockerCollector::with_client(
            Docker::connect_with_unix(
                socket_path.to_str().expect("socket path should be UTF-8"),
                2,
                bollard::API_DEFAULT_VERSION,
            )
            .expect("Bollard should connect to the Unix stub"),
            Some("com.dockermap.fixture=trace-123".into()),
        );
        collector
            .collect_snapshot()
            .await
            .expect("filtered list reads should succeed");
        let requests = trace.await.expect("wire trace should finish");
        assert_eq!(requests, vec![
            "GET /containers/json?all=true&size=false&filters=%7B%22label%22%3A%5B%22com.dockermap.fixture%3Dtrace-123%22%5D%7D HTTP/1.1",
            "GET /networks?filters=%7B%22label%22%3A%5B%22com.dockermap.fixture%3Dtrace-123%22%5D%7D HTTP/1.1",
            "GET /volumes?filters=%7B%22label%22%3A%5B%22com.dockermap.fixture%3Dtrace-123%22%5D%7D HTTP/1.1",
        ], "Bollard filtered wire contract changed; update the gateway ADR and policy review before permitting a new request shape");
    }

    #[tokio::test]
    async fn api_error_response_sanitizes_every_message_before_serialization() {
        let hostile = "failure at /srv/private/docker.log from 10.1.2.3:2375 token=DOCKERMAP_TEST_FAKE_SOL6_DOCKER_ERROR_SECRET";
        let response = ApiError {
            status: StatusCode::BAD_GATEWAY,
            message: hostile.into(),
        }
        .into_response();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("ApiError response body should be readable");
        let published = String::from_utf8(bytes.to_vec()).expect("ApiError response is UTF-8 JSON");
        for forbidden in [
            "/srv/private/docker.log",
            "10.1.2.3:2375",
            "DOCKERMAP_TEST_FAKE_SOL6_DOCKER_ERROR_SECRET",
        ] {
            assert!(
                !published.contains(forbidden),
                "ApiError publication leaked {forbidden}"
            );
        }
    }

    #[test]
    fn rejects_oversized_query_values() {
        let oversized = "a".repeat(MAX_LOG_QUERY_CHARS + 1);
        let error = validate_optional_query(Some(&oversized), "q", MAX_LOG_QUERY_CHARS)
            .expect_err("oversized query should fail");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn parses_log_cursor_values() {
        assert_eq!(parse_log_cursor(None).expect("absent cursor is fine"), None);
        assert_eq!(
            parse_log_cursor(Some("1785175506123")).expect("plain numeric cursor should parse"),
            Some(LogCursor {
                millis: 1_785_175_506_123,
                offset: 0
            })
        );
        assert_eq!(
            parse_log_cursor(Some("1785175506123:2")).expect("compound cursor should parse"),
            Some(LogCursor {
                millis: 1_785_175_506_123,
                offset: 2
            })
        );

        let non_numeric =
            parse_log_cursor(Some("abc")).expect_err("non-numeric cursor should fail");
        assert_eq!(non_numeric.status, StatusCode::BAD_REQUEST);

        let negative = parse_log_cursor(Some("-1")).expect_err("negative cursor should fail");
        assert_eq!(negative.status, StatusCode::BAD_REQUEST);

        let bad_offset =
            parse_log_cursor(Some("123:x")).expect_err("non-numeric offset should fail");
        assert_eq!(bad_offset.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn parses_log_limit_values() {
        assert_eq!(
            parse_log_limit(None).expect("absent limit uses default"),
            DEFAULT_LOG_PAGE_SIZE
        );
        assert_eq!(
            parse_log_limit(Some(25)).expect("in-range limit should parse"),
            25
        );

        let zero = parse_log_limit(Some(0)).expect_err("zero limit should fail");
        assert_eq!(zero.status, StatusCode::BAD_REQUEST);

        let oversized =
            parse_log_limit(Some(MAX_LOG_PAGE_SIZE + 1)).expect_err("oversized limit should fail");
        assert_eq!(oversized.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn parses_depends_on_label_with_condition_suffixes() {
        assert_eq!(
            parse_depends_on_label("redis:service_started:false,database:service_started:false"),
            vec![
                "container_redis".to_string(),
                "container_database".to_string()
            ]
        );
        assert_eq!(
            parse_depends_on_label(" api ,  db:condition_started:true "),
            vec!["container_api".to_string(), "container_db".to_string()]
        );
        assert_eq!(
            parse_depends_on_label(""),
            Vec::<String>::new(),
            "empty labels produce no refs"
        );
        assert_eq!(
            parse_depends_on_label(",,"),
            Vec::<String>::new(),
            "bare separators produce no refs"
        );
    }

    #[test]
    fn parses_python_process_table_from_fixture() {
        let records = parse_ps_table(include_str!(
            "../../../tests/fixtures/providers/parser/python-ps-table.txt"
        ));

        assert_eq!(records.len(), 7);
        assert_eq!(records[0].pid, 1234);
        assert_eq!(records[0].user, "root");
        assert_eq!(records[0].comm, "python3");
        assert_eq!(
            records[0].args,
            "/usr/bin/python3 /srv/app/worker.py --queue default"
        );
        assert_eq!(records[5].args, "/usr/sbin/cron -f");
        assert_eq!(records[6].pid, 7890);
    }

    #[test]
    fn filters_and_classifies_python_processes_from_fixture() {
        let records = parse_ps_table(include_str!(
            "../../../tests/fixtures/providers/parser/python-ps-table.txt"
        ));

        let python = records
            .iter()
            .filter(|record| is_python_process(&record.args))
            .collect::<Vec<_>>();
        // cron and containerd-shim are not python processes.
        assert_eq!(python.len(), 5);
        assert_eq!(
            python.iter().map(|record| record.pid).collect::<Vec<_>>(),
            vec![1234, 2345, 3456, 4567, 5678]
        );

        assert_eq!(
            python_entry(&python[0].args).as_deref(),
            Some("/srv/app/worker.py")
        );
        assert_eq!(python_entry(&python[1].args).as_deref(), Some("uvicorn"));
        assert_eq!(
            python_entry(&python[2].args).as_deref(),
            Some("/srv/web/manage.py")
        );
        assert_eq!(
            python_entry(&python[3].args).as_deref(),
            Some("module:celery")
        );
        assert_eq!(
            python_entry(&python[4].args).as_deref(),
            Some("/srv/agent/agent.py")
        );
    }

    #[test]
    fn python_detection_ignores_substring_false_positives() {
        for args in [
            "grep python",
            "vim python_notes",
            "/opt/flowerpot --serve",
            "bash -c 'python'",
            "gunicornate --help",
        ] {
            assert!(
                !is_python_process(args),
                "{args} must not classify as a python process"
            );
        }
        assert!(is_python_process("/usr/bin/python3 /srv/app/worker.py"));
        assert!(is_python_process("/srv/app/.venv/bin/uvicorn app.main:app"));
        assert!(is_python_process("python3.12 -m celery -A tasks worker"));
    }

    #[test]
    fn python_detection_resolves_wrappers_and_tightens_py_match() {
        // Wrapper-walked interpreters belong to the python provider: the
        // resolved executable is the interpreter, never the wrapper or an
        // option argument (`sudo -u www-data ...` must not resolve to
        // "www-data").
        assert!(is_python_process(
            "dumb-init -- /usr/local/bin/python -u /app/flaresolverr.py"
        ));
        assert!(is_python_process("env python3 -m uvicorn app.main:app"));
        assert!(is_python_process(
            "sudo -u www-data /usr/bin/python3 /srv/x.py"
        ));
        assert!(is_python_process(
            "env -u SECRET /usr/bin/python3 /srv/x.py"
        ));
        // The .py match is no longer any-field: a wrapper's own script
        // argument must not mis-attribute a non-python process.
        assert!(!is_python_process(
            "dumb-init -- /usr/bin/node /app/tool.py"
        ));
        assert!(!is_python_process("tini -- /usr/sbin/nginx -g daemon off;"));
    }

    #[test]
    fn pypy_interpreters_are_python_owned_and_excluded_from_native() {
        // pypy-style interpreters belong to the python provider — including
        // `-m module` invocations and versioned binaries — and the native
        // provider must exclude them: a `pypy3 /srv/x.py` process used to be
        // emitted by BOTH providers as a duplicate node for the same pid
        // because the native filter only excluded `python*` names. Both
        // sides now share `is_python_owned`, so they cannot diverge.
        for args in [
            "pypy3 /srv/x.py",
            "pypy3 -m celery -A tasks worker",
            "/usr/bin/pypy3.10 /srv/x.py",
            "pypy /srv/x.py",
            "pypy2 /srv/x.py",
        ] {
            assert!(is_python_process(args), "{args} must be python-owned");
            assert!(
                !is_native_process(args),
                "{args} must be excluded from the native provider"
            );
        }
        // A pypy-prefixed TOOL is not an interpreter: the interpreter match
        // is exactly `pypy` / `pypy2` / `pypy3` / a `pypy3.`-versioned
        // binary — never a loose `starts_with("pypy")` prefix.
        assert!(!is_python_process("/opt/pypy3-tool --serve"));
        assert!(is_native_process("/opt/pypy3-tool --serve"));
    }

    #[test]
    fn gunicorn_proctitle_rewrites_are_python_owned() {
        // gunicorn rewrites its process title to `gunicorn: master [app]` /
        // `gunicorn: worker [app]`, so the resolved executable is `gunicorn:`
        // (trailing colon). `is_python_owned` trims the colon before the
        // framework match — without it these processes matched no framework,
        // fell to the native provider, and got zero coverage (live: the
        // authentik gunicorn master/worker were absent from
        // /daemon/runtime/map).
        for args in [
            "gunicorn: master [authentik.root.asgi:application]",
            "gunicorn: worker [authentik.root.asgi:application]",
        ] {
            assert!(is_python_process(args), "{args} must be python-owned");
            assert!(
                !is_native_process(args),
                "{args} must be excluded from the native provider"
            );
        }
        // The normalization is generic, so any trailing-colon proctitle
        // still matches its framework basename.
        assert!(is_python_process("uvicorn: app.main:app"));
        assert!(!is_native_process("uvicorn: app.main:app"));

        // The entry point (and thus the label) is clean too — no trailing
        // colon, mirroring the native provider's process_comm.
        assert_eq!(
            python_entry("gunicorn: master [authentik.root.asgi:application]").as_deref(),
            Some("gunicorn")
        );
        assert_eq!(
            python_entry("uvicorn: app.main:app").as_deref(),
            Some("uvicorn")
        );
    }

    #[test]
    fn python_entry_rejects_unicode_control_characters_before_label_publication() {
        for control in ['\u{1b}', '\u{7f}', '\u{80}'] {
            for args in [
                format!("/usr/bin/python3 /tmp/unsafe{control}.py"),
                format!("/usr/bin/python3 -m unsafe{control}module"),
                format!("/usr/bin/python3 unsafe{control}:app"),
            ] {
                assert_eq!(python_entry(&args), None, "{args:?} must be rejected");
            }
        }

        let table = "  9000200  root  python3  /usr/bin/python3 /tmp/unsafe\u{7f}.py\n";
        let (nodes, capped) = python_nodes_from_ps_output(table);
        assert!(!capped);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].label, "python");
        assert!(nodes[0]
            .metadata
            .values()
            .all(|value| !value.chars().any(char::is_control)));
    }

    #[test]
    fn builds_python_nodes_from_fixture() {
        let (nodes, capped) = python_nodes_from_ps_output(include_str!(
            "../../../tests/fixtures/providers/parser/python-ps-table.txt"
        ));

        assert!(!capped);
        assert_eq!(nodes.len(), 5);

        let worker = &nodes[0];
        assert_eq!(worker.id, "python_process_1234");
        assert_eq!(worker.provider, RuntimeProviderKind::Python);
        assert_eq!(worker.kind, RuntimeNodeKind::PythonApplication);
        assert_eq!(worker.label, "/srv/app/worker.py");
        assert_eq!(worker.status.as_deref(), Some("running"));
        assert_eq!(worker.layer, Some(RuntimeNodeLayer::Process));
        assert_eq!(
            worker.metadata.get("entry").map(String::as_str),
            Some("/srv/app/worker.py")
        );
        assert_eq!(
            worker.metadata.get("user").map(String::as_str),
            Some("root")
        );
        assert_eq!(
            worker.metadata.get("serviceEntityKind").map(String::as_str),
            Some("python_application")
        );

        assert_eq!(nodes[1].label, "uvicorn");
        assert_eq!(nodes[3].id, "python_process_4567");
        assert_eq!(
            nodes[3].metadata.get("entry").map(String::as_str),
            Some("module:celery")
        );
    }

    #[test]
    fn redacts_python_process_args_with_tokens() {
        let (mut nodes, capped) = python_nodes_from_ps_output(include_str!(
            "../../../tests/fixtures/providers/parser/python-ps-table.txt"
        ));
        assert!(!capped);
        redact_runtime_nodes(&mut nodes);

        // The agent process carries --token=... in its args; raw argv is never
        // published at all (no `args` metadata key), so the sentinel cannot
        // surface in labels, metadata, or ids.
        assert!(!nodes[4].metadata.contains_key("args"));
        assert_eq!(
            nodes[4].metadata.get("entry").map(String::as_str),
            Some("/srv/agent/agent.py")
        );
        assert_no_raw_secrets(&nodes, &["DOCKERMAP_TEST_FAKE_PYTHON_TOKEN"]);
    }

    #[test]
    fn redacts_nginx_server_blocks_fixture() {
        let fixture =
            include_str!("../../../tests/fixtures/providers/parser/nginx-server-blocks.conf");
        assert!(fixture.contains("DOCKERMAP_TEST_FAKE_NGINX_TOKEN"));

        // Whole-value redaction: a config carrying a token-like value is
        // collapsed entirely rather than partially exposed.
        assert_eq!(redact_sensitive_text(fixture), REDACTED_VALUE);

        // A clean config without secret markers passes through unchanged.
        let clean = fixture.replace(
            "proxy_set_header Authorization \"Bearer DOCKERMAP_TEST_FAKE_NGINX_TOKEN\";",
            "proxy_set_header X-Forwarded-Proto $scheme;",
        );
        assert!(!clean.contains("DOCKERMAP_TEST_FAKE"));
        assert_eq!(redact_sensitive_text(&clean), clean);
    }

    #[test]
    fn parses_native_process_table_from_fixture() {
        let records = parse_ps_table(include_str!(
            "../../../tests/fixtures/providers/parser/native-ps-table.txt"
        ));

        assert_eq!(records.len(), 15);
        assert_eq!(records[0].pid, 9_000_001);
        assert_eq!(records[0].user, "root");
        assert_eq!(records[0].comm, "nginx");
        assert_eq!(records[0].args, "/usr/sbin/nginx -g daemon off;");
        assert_eq!(
            process_comm(&records[6].args).as_deref(),
            Some("[kworker/0:1-events]")
        );
        // A rewritten argv[0] ("hunter2") never leaks into the comm column.
        assert_eq!(records[14].comm, "sleep");
        assert_eq!(records[14].args, "hunter2 --sleep-forever");
    }

    #[test]
    fn filters_native_processes_and_excludes_noise() {
        let fixture = include_str!("../../../tests/fixtures/providers/parser/native-ps-table.txt");
        let natives = parse_ps_table(fixture)
            .into_iter()
            .filter(|record| is_native_process(&record.args))
            .map(|record| record.pid)
            .collect::<Vec<_>>();

        // nginx, postgres, redis, sshd, dockerd, node, cron, and the
        // argv-rewritten `sleep` are native; containerd-shim, kernel threads,
        // python, the daemon itself, and the transient ps process are
        // excluded. Pids are beyond pid_max so the fixture never collides
        // with a live host process.
        assert_eq!(
            natives,
            vec![
                9_000_001, 9_000_002, 9_000_003, 9_000_004, 9_000_005, 9_000_013, 9_000_014,
                9_000_015
            ]
        );
    }

    #[test]
    fn builds_native_process_nodes_from_fixture() {
        let (mut nodes, capped) = native_process_nodes_from_ps_output(
            include_str!("../../../tests/fixtures/providers/parser/native-ps-table.txt"),
            9_000_011, // the daemon's own pid (dockermap-daemon in the fixture)
        );
        assert!(!capped);
        redact_runtime_nodes(&mut nodes);

        assert_eq!(nodes.len(), 8);

        let nginx = &nodes[0];
        assert_eq!(nginx.id, "native_process_9000001");
        assert_eq!(nginx.provider, RuntimeProviderKind::Process);
        assert_eq!(nginx.kind, RuntimeNodeKind::Process);
        assert_eq!(nginx.label, "nginx");
        assert_eq!(nginx.status.as_deref(), Some("running"));
        assert_eq!(nginx.layer, Some(RuntimeNodeLayer::Process));
        assert_eq!(
            nginx.metadata.get("pid").map(String::as_str),
            Some("9000001")
        );
        assert_eq!(nginx.metadata.get("user").map(String::as_str), Some("root"));
        assert_eq!(
            nginx.metadata.get("comm").map(String::as_str),
            Some("nginx")
        );

        let node = &nodes[5];
        assert_eq!(node.id, "native_process_9000013");
        assert_eq!(node.label, "node");

        // The argv-rewritten row (argv[0] "hunter2", kernel comm "sleep")
        // publishes the kernel comm — never the fake argv name.
        let hunter2 = &nodes[7];
        assert_eq!(hunter2.id, "native_process_9000015");
        assert_eq!(hunter2.label, "sleep");
        assert_eq!(
            hunter2.metadata.get("comm").map(String::as_str),
            Some("sleep")
        );
        assert!(hunter2.label != "hunter2");

        // No daemon self-node, and raw argv is never published.
        assert!(nodes.iter().all(|node| node.id != "native_process_9000011"));
        assert!(nodes.iter().all(|node| !node.metadata.contains_key("args")));
        assert_no_raw_secrets(&nodes, &["dockermap-daemon"]);
    }

    #[test]
    fn parses_long_usernames_from_ps_user_column() {
        // `ps -eo user=,` truncates usernames at 8 chars and appends '+'; the
        // providers use `user:32=` so full usernames must survive the parser.
        let records = parse_ps_table(
            "  4242  systemd-resolve  systemd-resolve  /usr/lib/systemd/systemd-resolved",
        );
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].pid, 4242);
        assert_eq!(records[0].user, "systemd-resolve");
        assert_eq!(records[0].comm, "systemd-resolve");
        assert_eq!(records[0].args, "/usr/lib/systemd/systemd-resolved");

        // A padded 32-char column (as `ps` actually emits) parses identically.
        let padded = format!(
            "  4242  {:<32}  systemd-resolve  /usr/lib/systemd/systemd-resolved",
            "systemd-resolve"
        );
        let records = parse_ps_table(&padded);
        assert_eq!(records[0].user, "systemd-resolve");
        assert_eq!(records[0].comm, "systemd-resolve");
        assert_eq!(records[0].args, "/usr/lib/systemd/systemd-resolved");
    }

    #[test]
    fn process_comm_strips_argv_zero_rewrites_and_resolves_wrappers() {
        // Daemons that rewrite argv[0] (`avahi-daemon: running [host]`, nginx
        // master) must not leak a trailing colon into the comm.
        assert_eq!(
            process_comm("/usr/sbin/avahi-daemon: running [HEARTH.local]").as_deref(),
            Some("avahi-daemon")
        );
        assert_eq!(
            process_comm("/usr/sbin/nginx: master process").as_deref(),
            Some("nginx")
        );
        // Wrapper executables resolve to the wrapped command.
        assert_eq!(
            process_comm("/usr/bin/nice -n 5 /usr/sbin/nginx -g daemon off;").as_deref(),
            Some("nginx")
        );
        assert_eq!(
            process_comm("timeout 300 node /srv/server.js").as_deref(),
            Some("node")
        );
        assert_eq!(
            process_comm("env FOO=bar /usr/bin/python3 /srv/x.py").as_deref(),
            Some("python3")
        );
        // Wrapper options that consume the next token must not surface their
        // argument as the executable (`sudo -u www-data ...` → "www-data").
        assert_eq!(
            process_comm("sudo -u www-data /usr/bin/python3 /srv/x.py").as_deref(),
            Some("python3")
        );
        assert_eq!(
            process_comm("env -u SECRET /usr/bin/python3 /srv/x.py").as_deref(),
            Some("python3")
        );
        assert_eq!(
            process_comm("timeout -s TERM 300 /usr/sbin/nginx").as_deref(),
            Some("nginx")
        );
        // Container init wrappers resolve to the wrapped command too.
        assert_eq!(
            process_comm("dumb-init -- /usr/local/bin/python -u /app/flaresolverr.py").as_deref(),
            Some("python")
        );
        assert_eq!(
            process_comm("tini -- /usr/sbin/nginx -g daemon off;").as_deref(),
            Some("nginx")
        );
    }

    #[test]
    fn wrapper_executables_classify_as_the_wrapped_command() {
        // env-wrapped interpreters and frameworks belong to the python
        // provider, never to the native provider.
        assert!(!is_native_process("env python3 /srv/x.py"));
        assert!(!is_native_process(
            "env /srv/app/.venv/bin/uvicorn app.main:app"
        ));
        assert!(!is_native_process("env uvicorn app.main:app --port 8000"));
        // nice/timeout-wrapped daemons are native.
        assert!(is_native_process(
            "/usr/bin/nice -n 5 /usr/sbin/nginx -g daemon off;"
        ));
        assert!(is_native_process("timeout 300 node /srv/server.js"));
        // Wrapper options that consume the next token never surface their
        // argument as the executable, so python stays python-owned.
        assert!(!is_native_process(
            "sudo -u www-data /usr/bin/python3 /srv/x.py"
        ));
        assert!(!is_native_process(
            "env -u SECRET /usr/bin/python3 /srv/x.py"
        ));
        assert!(is_native_process("timeout -s TERM 300 /usr/sbin/nginx"));
        // Container init wrappers resolve like any other wrapper: python is
        // python-owned, nginx is native.
        assert!(!is_native_process(
            "dumb-init -- /usr/local/bin/python -u /app/flaresolverr.py"
        ));
        assert!(is_native_process("tini -- /usr/sbin/nginx -g daemon off;"));
        assert!(!is_python_process("tini -- /usr/sbin/nginx -g daemon off;"));
    }

    #[test]
    fn wrapper_option_arguments_are_wrapper_aware() {
        // `sudo -s` (run shell) and `sudo -k` (invalidate timestamp) consume
        // NO argument, so the next token is the wrapped command — previously
        // the wrapper-blind -s/-k skip list consumed it, the process
        // resolved to None, and it was silently dropped from BOTH providers.
        assert_eq!(process_comm("sudo -s nginx").as_deref(), Some("nginx"));
        assert_eq!(process_comm("sudo -k nginx").as_deref(), Some("nginx"));
        assert!(is_native_process("sudo -s nginx"));
        assert!(is_native_process("sudo -k nginx"));
        // `sudo -s` wrapping an interpreter still resolves to the
        // interpreter: python-owned, never native.
        assert!(is_python_process("sudo -s /usr/bin/python3 /srv/x.py"));
        assert!(!is_native_process("sudo -s /usr/bin/python3 /srv/x.py"));
        // `env -C`/`--chdir` consume their argument — without that the
        // directory was resolved as the executable and the wrapped python
        // process was misclassified native.
        assert_eq!(
            process_comm("env -C /srv python3 /srv/x.py").as_deref(),
            Some("python3")
        );
        assert_eq!(
            process_comm("env --chdir /srv python3 /srv/x.py").as_deref(),
            Some("python3")
        );
        // `env -S`/`--split-string` are NOT option-argument tokens: the
        // split-string is the REMAINDER of the command line, not a single
        // next token, so a one-token skip would swallow the wrapped command
        // (`env -S python3 ...` resolved to None and vanished from BOTH
        // providers; `env -S python3 -m http.server` resolved to
        // `http.server` and was misclassified native). The wrapped command
        // is reached directly — the common `-S FOO=bar` form still resolves
        // via the NAME=VALUE skip.
        assert_eq!(
            process_comm("env -S python3 /srv/x.py").as_deref(),
            Some("python3")
        );
        assert!(is_python_process("env -S python3"));
        assert!(!is_native_process("env -S python3"));
        assert!(is_python_process("env --split-string python3 -O /srv/x.py"));
        assert!(!is_native_process(
            "env --split-string python3 -O /srv/x.py"
        ));
        assert_eq!(
            process_comm("env -S FOO=bar python3 /srv/x.py").as_deref(),
            Some("python3")
        );
        assert!(is_python_process("env -C /srv python3 /srv/x.py"));
        assert!(!is_native_process("env -C /srv python3 /srv/x.py"));
        // timeout -s/-k still consume their argument (unchanged behavior).
        assert_eq!(
            process_comm("timeout -k 5s -s TERM 300 /usr/sbin/nginx").as_deref(),
            Some("nginx")
        );
        assert!(is_native_process("timeout -s TERM 300 /usr/sbin/nginx"));
    }

    #[test]
    fn real_comm_falls_back_for_unreadable_proc_entry() {
        // 9_000_000-style pids are beyond pid_max (4_194_304) on any Linux
        // host, so /proc/<pid>/comm cannot exist — the ps comm fallback must
        // win, and an empty fallback resolves to "unknown" (never argv).
        assert_eq!(real_comm(9_000_000, "nginx"), "nginx");
        assert_eq!(real_comm(9_000_000, "sleep"), "sleep");
        assert_eq!(real_comm(9_000_000, ""), "unknown");
    }

    #[test]
    fn native_comm_control_characters_never_reach_the_label() {
        // Kernel comm strings are process-controlled. C0, DEL, and C1 controls
        // must never become label or comm metadata. The fake pid forces the
        // ps-comm fallback path used by native node construction.
        for comm in ["x\n1  root  evil", "evil\u{7f}del", "evil\u{80}ctrl"] {
            let label = real_comm(9_000_000, comm);
            assert_eq!(label, "unknown");
            assert!(!label.chars().any(char::is_control));
            assert!(!label.contains("evil"));
        }
    }

    #[test]
    fn real_comm_prefers_proc_comm_over_rewritten_argv() {
        // The child rewrites argv[0] via `exec -a`, so the argv-derived
        // fallback ("fake-name") differs from the kernel comm ("sleep"); the
        // /proc/<pid>/comm entry must win.
        let Ok(mut child) = Command::new("bash")
            .arg("-c")
            .arg("exec -a /tmp/fake-name sleep 30")
            .spawn()
        else {
            return; // no bash/sleep in this environment — nothing to assert
        };
        // The child forks from this test thread, inheriting its comm
        // ("tests::real_com" — 15 chars) until bash execs; poll until the
        // exec'd comm is visible.
        let mut comm = String::new();
        for _ in 0..100 {
            comm = real_comm(child.id(), "fake-name");
            if comm == "sleep" {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(comm, "sleep");
    }

    #[test]
    fn native_label_uses_ps_comm_never_argv_zero() {
        // `exec -a hunter2 /usr/bin/sleep` rewrites argv[0] but not the
        // kernel comm: the label must come from the ps comm column ("sleep"),
        // never from the args column — a credential hidden in argv[0] would
        // otherwise be published as label + comm metadata.
        let table = "  9000100  root       sleep      hunter2 --sleep-forever\n";
        let (nodes, capped) = native_process_nodes_from_ps_output(table, 9_000_000);
        assert!(!capped);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].id, "native_process_9000100");
        assert_eq!(nodes[0].label, "sleep");
        assert_eq!(
            nodes[0].metadata.get("comm").map(String::as_str),
            Some("sleep")
        );
        assert!(!nodes[0].label.contains("hunter2"));
        assert!(nodes[0]
            .metadata
            .values()
            .all(|value| !value.contains("hunter2")));
    }

    #[test]
    fn restricted_pid_namespace_requires_explicit_container_evidence() {
        // Ordinary systemd services and user managers have non-root cgroups,
        // but they are host processes and must not trigger a container warning.
        assert!(!restricted_pid_namespace_evidence(
            Some("systemd"),
            "0::/system.slice/hermes.service\n",
            false,
            false,
        ));
        assert!(!restricted_pid_namespace_evidence(
            Some("init"),
            "0::/user.slice/user-1000.slice/user@1000.service\n",
            false,
            false,
        ));

        assert!(restricted_pid_namespace_evidence(
            Some("systemd"),
            "0::/\n",
            true,
            false,
        ));
        assert!(restricted_pid_namespace_evidence(
            Some("systemd"),
            "0::/\n",
            false,
            true,
        ));
        assert!(restricted_pid_namespace_evidence(
            Some("systemd"),
            "0::/system.slice/docker-abc123def456.scope\n",
            false,
            false,
        ));
        assert!(!restricted_pid_namespace_evidence(
            Some("entrypoint.sh"),
            "0::/\n",
            false,
            false,
        ));
    }

    #[test]
    fn cgroup_implies_container_classifies_known_paths() {
        // Docker: systemd-scope path (cgroup v2) and /docker/<id> (v1).
        assert!(cgroup_implies_container(
            "0::/system.slice/docker-abc123.scope/init.scope"
        ));
        assert!(cgroup_implies_container("11:devices:/docker/abc123def456"));
        // libpod (podman) and kubepods (Kubernetes) use recognizable scopes.
        assert!(cgroup_implies_container(
            "0::/machine.slice/libpod-abc123.scope/container"
        ));
        assert!(cgroup_implies_container(
            "0::/kubepods.slice/kubepods-besteffort.slice/..."
        ));
        // Host cgroups and host container runtimes are not container-owned.
        assert!(!cgroup_implies_container("0::/system.slice/docker.service"));
        assert!(!cgroup_implies_container(
            "0::/system.slice/containerd.service"
        ));
        assert!(!cgroup_implies_container("0::/system.slice/"));
        assert!(!cgroup_implies_container("0::/init.scope"));
        assert!(!cgroup_implies_container(""));
        assert!(!cgroup_implies_container(
            "0::/user.slice/user-1000.slice/..."
        ));
    }

    #[test]
    fn restricted_namespace_omits_native_nodes_but_host_collection_remains_available() {
        let mut omitted_nodes = Vec::new();
        let mut omitted_diagnostics = Vec::new();
        let mut ps_shim = Command::new("sh");
        ps_shim.args([
            "-c",
            "printf ' 9300000  root  worker  /usr/bin/worker --once'",
        ]);

        collect_native_processes_with_command(
            ps_shim,
            true,
            &mut omitted_nodes,
            &mut omitted_diagnostics,
        );

        assert!(omitted_nodes.is_empty());
        assert!(omitted_diagnostics.iter().any(|diagnostic| {
            diagnostic.provider == RuntimeProviderKind::Process
                && diagnostic.severity == DiagnosticSeverity::Info
                && diagnostic.message
                    == "Native process discovery omitted because the daemon runs in a restricted PID namespace; only the container's own processes would be visible"
        }));

        let mut host_nodes = Vec::new();
        let mut host_diagnostics = Vec::new();
        let mut ps_shim = Command::new("sh");
        ps_shim.args([
            "-c",
            "printf ' 9300000  root  worker  /usr/bin/worker --once'",
        ]);
        collect_native_processes_with_command(
            ps_shim,
            false,
            &mut host_nodes,
            &mut host_diagnostics,
        );

        assert_eq!(host_nodes.len(), 1);
        assert_eq!(host_nodes[0].id, "native_process_9300000");
        assert!(host_diagnostics.is_empty());
    }

    #[test]
    fn nonzero_ps_shim_exit_reports_safe_warning_for_both_process_providers() {
        let failing_ps_shim = || {
            let mut command = Command::new("sh");
            command.args([
                "-c",
                "printf 'ps-provider-output-must-not-leak' >&2; exit 7",
            ]);
            command
        };
        let mut python_nodes = Vec::new();
        let mut python_diagnostics = Vec::new();
        collect_python_processes_with_command(
            failing_ps_shim(),
            &mut python_nodes,
            &mut python_diagnostics,
        );
        let mut native_nodes = Vec::new();
        let mut native_diagnostics = Vec::new();
        collect_native_processes_with_command(
            failing_ps_shim(),
            false,
            &mut native_nodes,
            &mut native_diagnostics,
        );

        assert!(python_nodes.is_empty());
        assert!(native_nodes.is_empty());
        assert!(python_diagnostics.iter().any(|diagnostic| {
            diagnostic.provider == RuntimeProviderKind::Python
                && diagnostic.severity == DiagnosticSeverity::Warning
                && diagnostic.message == "Python process discovery command failed"
        }));
        assert!(native_diagnostics.iter().any(|diagnostic| {
            diagnostic.provider == RuntimeProviderKind::Process
                && diagnostic.severity == DiagnosticSeverity::Warning
                && diagnostic.message == "Native process discovery command failed"
        }));
        assert!(python_diagnostics
            .iter()
            .chain(&native_diagnostics)
            .all(|diagnostic| !diagnostic
                .message
                .contains("ps-provider-output-must-not-leak")));
    }

    #[test]
    fn native_process_cap_is_reported_and_bounded() {
        // Pids beyond pid_max (4_194_304) are unreadable, so is_container_owned
        // keeps them as host processes and the count is deterministic in any
        // environment (containerized CI included).
        let mut table = String::new();
        for pid in 9_000_000..9_000_300 {
            table.push_str(&format!(
                "{pid:>7}  root  benchmark-{pid}  /usr/bin/benchmark-{pid}\n"
            ));
        }
        let (nodes, capped) = native_process_nodes_from_ps_output(&table, 9_000_500);
        assert!(
            capped,
            "300 filtered processes must exceed MAX_NATIVE_PROCESSES"
        );
        assert_eq!(nodes.len(), MAX_NATIVE_PROCESSES);
        // ps emits pids ascending, so the first MAX_NATIVE_PROCESSES surface.
        assert_eq!(
            nodes
                .first()
                .unwrap()
                .metadata
                .get("pid")
                .map(String::as_str),
            Some("9000000")
        );
        assert_eq!(
            nodes
                .last()
                .unwrap()
                .metadata
                .get("pid")
                .map(String::as_str),
            Some((9_000_000 + MAX_NATIVE_PROCESSES - 1).to_string().as_str())
        );
    }

    #[test]
    fn provider_output_cap_drops_partial_process_row_and_reports_diagnostic() {
        let complete_line =
            "  9000000  root  benchmark  /usr/bin/benchmark --arg xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n";
        let mut source = Vec::new();
        while source.len() + complete_line.len() <= MAX_PROVIDER_OUTPUT_BYTES - 96 {
            source.extend_from_slice(complete_line.as_bytes());
        }
        source.extend_from_slice(
            b"  9000999  root  partial  /usr/bin/partial --arg this-tail-must-not-become-a-row",
        );
        source.extend_from_slice(&vec![b'x'; 300_000]);

        let read = read_bounded(std::io::Cursor::new(source), MAX_PROVIDER_OUTPUT_BYTES);
        assert!(read.truncated);
        assert_eq!(read.bytes.len(), MAX_PROVIDER_OUTPUT_BYTES);
        let complete = complete_provider_lines(&read.bytes, read.truncated);
        assert!(complete.len() < read.bytes.len());
        assert!(parse_ps_table(&String::from_utf8_lossy(complete))
            .iter()
            .all(|record| record.pid != 9_000_999));

        let mut nodes = Vec::new();
        let mut diagnostics = Vec::new();
        collect_native_processes_from_output(
            &read.bytes,
            read.truncated,
            9_000_500,
            &mut nodes,
            &mut diagnostics,
        );
        assert!(nodes.iter().all(|node| node.id != "native_process_9000999"));
        assert!(diagnostics.iter().any(|diagnostic| {
            diagnostic.provider == RuntimeProviderKind::Process
                && diagnostic.message
                    == format!(
                        "Provider output exceeded {MAX_PROVIDER_OUTPUT_BYTES} bytes; truncated"
                    )
        }));
    }

    #[test]
    fn complete_unterminated_ps_row_is_retained_when_output_is_not_truncated() {
        let table = b"  9300000  root  worker  /usr/bin/worker --once";
        let mut nodes = Vec::new();
        let mut diagnostics = Vec::new();

        collect_native_processes_from_output(table, false, 9_000_500, &mut nodes, &mut diagnostics);

        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].id, "native_process_9300000");
        assert!(diagnostics.is_empty());
    }

    #[test]
    fn python_process_cap_is_reported_and_bounded() {
        let mut table = String::new();
        for pid in 9_000_000..(9_000_000 + MAX_PYTHON_PROCESSES as u32 + 1) {
            table.push_str(&format!(
                "{pid:>7}  root  python3  /usr/bin/python3 /srv/app-{pid}.py\n"
            ));
        }

        let mut nodes = Vec::new();
        let mut diagnostics = Vec::new();
        collect_python_processes_from_output(table.as_bytes(), false, &mut nodes, &mut diagnostics);
        assert_eq!(nodes.len(), MAX_PYTHON_PROCESSES);
        assert!(diagnostics.iter().any(|diagnostic| {
            diagnostic.provider == RuntimeProviderKind::Python
                && diagnostic.message
                    == format!(
                        "Python process discovery capped at {MAX_PYTHON_PROCESSES} processes"
                    )
        }));
    }

    #[test]
    fn redacts_native_process_secret_like_fixture_output() {
        let command =
            include_str!("../../../tests/fixtures/providers/redaction/process-cmdline.txt").trim();
        let mut node = RuntimeMapNode {
            id: "process_2412".into(),
            provider: RuntimeProviderKind::Process,
            kind: RuntimeNodeKind::Process,
            label: command.into(),
            status: Some("running".into()),
            layer: None,
            metadata: BTreeMap::from([
                ("pid".into(), "2412".into()),
                ("command".into(), command.into()),
            ]),
            service: None,
            package: None,
        };
        let mut edges = vec![RuntimeMapEdge {
            source: "process_2412".into(),
            target: "host_local".into(),
            relationship: RuntimeRelationshipKind::RunsOn,
            metadata: BTreeMap::from([("argv".into(), command.into())]),
            evidence_refs: Vec::new(),
        }];
        let mut diagnostics = vec![RuntimeMapDiagnostic {
            provider: RuntimeProviderKind::Process,
            severity: DiagnosticSeverity::Info,
            message: format!("process fixture skipped: {command}"),
        }];

        redact_runtime_node(&mut node);
        redact_runtime_edges(&mut edges);
        redact_runtime_diagnostics(&mut diagnostics);

        assert_eq!(node.label, REDACTED_VALUE);
        assert_eq!(
            node.metadata.get("command").map(String::as_str),
            Some(REDACTED_VALUE)
        );
        assert_no_raw_secrets(
            &(&node, &edges, &diagnostics),
            &[
                "DOCKERMAP_TEST_FAKE_PROCESS_PASSWORD",
                "DOCKERMAP_TEST_FAKE_PROCESS_URL_TOKEN",
            ],
        );
    }

    #[test]
    fn redacts_sensitive_provider_diagnostics_and_edge_metadata() {
        let mut edges = vec![RuntimeMapEdge {
            source: "a".into(),
            target: "b".into(),
            relationship: RuntimeRelationshipKind::RelatedTo,
            metadata: BTreeMap::from([(
                "header".into(),
                "Authorization: Bearer DOCKERMAP_TEST_FAKE_EDGE_TOKEN".into(),
            )]),
            evidence_refs: Vec::new(),
        }];
        let mut diagnostics = vec![RuntimeMapDiagnostic {
            provider: RuntimeProviderKind::Other,
            severity: DiagnosticSeverity::Warning,
            message: "skipped path with password=DOCKERMAP_TEST_FAKE_DIAGNOSTIC_PASSWORD".into(),
        }];

        redact_runtime_edges(&mut edges);
        redact_runtime_diagnostics(&mut diagnostics);

        assert_no_raw_secrets(
            &(&edges, &diagnostics),
            &[
                "DOCKERMAP_TEST_FAKE_EDGE_TOKEN",
                "DOCKERMAP_TEST_FAKE_DIAGNOSTIC_PASSWORD",
            ],
        );
    }

    #[test]
    fn runtime_evidence_redacts_controls_and_secrets_bounds_text_and_preserves_collisions() {
        let secret = "https://user:DOCKERMAP_TEST_FAKE_EVIDENCE_TOKEN@example.test/path";
        let oversized = "x".repeat(800);
        let evidence = |summary: String| RuntimeEvidenceRef {
            version: 1,
            id: format!("evidence-{oversized}"),
            provider: RuntimeEvidenceProvider::Docker,
            kind: RuntimeEvidenceKind::DockerNetworkMembership,
            assertion_kind: RuntimeEvidenceAssertionKind::Observed,
            summary,
            subject_ref: "docker_container_\u{202e}id".into(),
            collected_at: 1,
            provider_revision: oversized.clone(),
            provider_slot: None,
            freshness: RuntimeEvidenceFreshness::Fresh,
        };
        let mut edges = vec![RuntimeMapEdge {
            source: "docker_container_\u{202e}id".into(),
            target: "docker_network_network".into(),
            relationship: RuntimeRelationshipKind::ConnectedTo,
            metadata: BTreeMap::new(),
            evidence_refs: vec![
                evidence(secret.into()),
                evidence("safe\u{202e}summary".into()),
            ],
        }];

        redact_runtime_edges(&mut edges);

        assert_eq!(edges[0].evidence_refs.len(), 2);
        assert!(edges[0]
            .evidence_refs
            .iter()
            .all(|evidence| evidence.summary.chars().count() <= 259));
        assert!(edges[0]
            .evidence_refs
            .iter()
            .all(|evidence| evidence.id.chars().count() <= 259));
        assert!(edges[0].evidence_refs.iter().all(|evidence| {
            evidence.provider_revision.chars().count() <= 259
                && evidence.subject_ref == edges[0].source
        }));
        let serialized = serde_json::to_string(&edges).expect("evidence serializes");
        assert!(!serialized.contains("DOCKERMAP_TEST_FAKE_EVIDENCE_TOKEN"));
        assert!(!serialized.contains('\u{202e}'));
        assert!(serialized.contains(REDACTED_VALUE));
    }

    #[test]
    fn publication_retains_only_evidence_that_attests_its_docker_edge() {
        let snapshot = mock_snapshot();
        let mut map = derive_runtime_map(
            &snapshot,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            "opaque-observation",
        );
        let expected = map
            .edges
            .iter()
            .map(|edge| edge.evidence_refs.len())
            .sum::<usize>();
        assert!(expected > 0, "mock Docker snapshot emits evidence");

        redact_runtime_map(&mut map);

        assert_eq!(
            map.edges
                .iter()
                .map(|edge| edge.evidence_refs.len())
                .sum::<usize>(),
            expected,
            "publication must retain correctly bound Docker evidence"
        );
        assert!(map.edges.iter().any(|edge| {
            edge.evidence_refs.iter().any(|evidence| {
                evidence.kind == RuntimeEvidenceKind::DockerComposeDependsOn
                    && evidence.summary == "Docker recorded Compose dependency declaration"
                    && evidence.subject_ref == edge.source
                    && edge.source.starts_with("docker_container_")
                    && edge.target.starts_with("docker_container_")
                    && edge.source != edge.target
            })
        }));
    }

    #[test]
    fn pages_log_entries_to_strictly_older_pages() {
        let entries = (0..5)
            .map(|index| LogEntry {
                id: format!("svc-{index}"),
                timestamp: 1_000 - index,
                container: "svc".into(),
                level: dockermap_core::LogLevel::Info,
                message: format!("line {index}"),
            })
            .collect::<Vec<_>>();

        let (first, first_cursor) = page_log_entries(entries.clone(), None, None, 2);
        assert_eq!(first.len(), 2);
        assert_eq!(first[0].timestamp, 1_000, "page is sorted newest-first");
        assert_eq!(first[1].timestamp, 999);
        let first_cursor = first_cursor.expect("a full page carries a cursor");
        assert_eq!(
            first_cursor, "999:1",
            "cursor is the oldest kept entry's ms plus its same-ms count emitted"
        );

        let (second, second_cursor) =
            page_log_entries(entries.clone(), None, LogCursor::parse(&first_cursor), 2);
        assert_eq!(second.len(), 2);
        assert!(
            second.iter().all(|entry| entry.timestamp < 999),
            "next page must be strictly older than the cursor"
        );
        assert!(
            second
                .iter()
                .all(|entry| first.iter().all(|first_entry| first_entry.id != entry.id)),
            "pages must not overlap"
        );
        let second_cursor = second_cursor.expect("a full page carries a cursor");
        assert_eq!(second_cursor, "997:1");

        let (last, last_cursor) =
            page_log_entries(entries.clone(), None, LogCursor::parse(&second_cursor), 2);
        assert_eq!(last.len(), 1, "last page holds the remaining entry");
        assert_eq!(last[0].timestamp, 996);
        assert_eq!(last_cursor, None, "the last page has no cursor");
    }

    #[test]
    fn log_entry_ids_are_stable_and_unique_per_physical_line() {
        // Regression (round 8, F1): content hashing (service + timestamp +
        // message) gave two DISTINCT physical lines with the same service,
        // the same ms-truncated timestamp, and identical message text the
        // SAME id, so the UI's dedupe-by-id silently dropped the second line.
        // The within-ms ordinal — the line's index among same-ms entries in
        // stream order — must disambiguate identical-content same-ms lines
        // while staying stable for the same physical line across requests.
        let first = log_entry_id("api", 1_787_198_706_123, 0);
        let second = log_entry_id("api", 1_787_198_706_123, 1);
        assert_ne!(
            first, second,
            "identical-content same-ms lines must get distinct ids"
        );
        assert_eq!(
            log_entry_id("api", 1_787_198_706_123, 0),
            first,
            "the same physical line re-fetched must keep its id (stable ordinal)"
        );
        assert_ne!(
            log_entry_id("web", 1_787_198_706_123, 0),
            first,
            "different services must not collide"
        );
        assert_ne!(
            log_entry_id("api", 1_787_198_706_122, 0),
            first,
            "different timestamps must not collide"
        );
    }

    #[test]
    fn pages_log_entries_with_query_filter_and_sparse_last_page() {
        let entries = vec![
            LogEntry {
                id: log_entry_id("svc", 100, 0),
                timestamp: 100,
                container: "svc".into(),
                level: dockermap_core::LogLevel::Info,
                message: "boot ok".into(),
            },
            LogEntry {
                id: log_entry_id("svc", 100, 1),
                timestamp: 100,
                container: "svc".into(),
                level: dockermap_core::LogLevel::Info,
                message: "token=DOCKERMAP_TEST_FAKE_LOG_LINE".into(),
            },
            LogEntry {
                id: log_entry_id("svc", 99, 0),
                timestamp: 99,
                container: "svc".into(),
                level: dockermap_core::LogLevel::Warn,
                message: "retry".into(),
            },
        ];

        let (kept, cursor) = page_log_entries(entries.clone(), Some("boot"), None, 10);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].message, "boot ok");
        assert_eq!(cursor, None, "an unfilled page has no cursor");

        let (kept, cursor) = page_log_entries(
            entries.clone(),
            None,
            Some(LogCursor {
                millis: 100,
                offset: 2,
            }),
            2,
        );
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].timestamp, 99);
        assert_eq!(cursor, None, "an unfilled page has no cursor");
    }

    #[test]
    fn pages_log_entries_exact_multiple_of_limit_has_no_trailing_cursor() {
        let entries = (0..4)
            .map(|index| LogEntry {
                id: format!("svc-{index}"),
                timestamp: 1_000 - index,
                container: "svc".into(),
                level: dockermap_core::LogLevel::Info,
                message: format!("line {index}"),
            })
            .collect::<Vec<_>>();

        let (first, first_cursor) = page_log_entries(entries.clone(), None, None, 2);
        assert_eq!(first.len(), 2);
        let first_cursor = first_cursor.expect("a full page with more behind it carries a cursor");

        let (second, second_cursor) =
            page_log_entries(entries.clone(), None, LogCursor::parse(&first_cursor), 2);
        assert_eq!(second.len(), 2, "exact-multiple last page is exactly full");
        assert!(
            second_cursor.is_none(),
            "an exactly-full final page must NOT carry a cursor that would yield an empty next page"
        );
        assert_eq!(
            second.last().map(|entry| entry.timestamp),
            Some(997),
            "the final entry is still delivered on the last page"
        );
        assert_ne!(
            first_cursor, "997:1",
            "first cursor keeps pointing at its own oldest entry"
        );
    }

    #[test]
    fn log_window_contract_emits_cursor_for_live_docker() {
        // Every page — first and cursor — opens the same fixed window, which
        // is far wider than any page size, so page_log_entries can always
        // detect "a next page exists" (`entries.len() > limit`) for the live
        // stream — a plain `tail(limit)` window could never produce a cursor.
        assert_eq!(log_tail_count(), MAX_LOG_CURSOR_TAIL);
        assert!(
            log_tail_count() > MAX_LOG_PAGE_SIZE,
            "the fixed window must exceed any page size so a next page is detectable"
        );

        // Feeding a window wider than `limit` into page_log_entries must
        // yield a page of exactly `limit` entries plus a cursor.
        let entries = (0..=100)
            .map(|index| LogEntry {
                id: format!("svc-{index}"),
                timestamp: 10_000 - index,
                container: "svc".into(),
                level: dockermap_core::LogLevel::Info,
                message: format!("line {index}"),
            })
            .collect::<Vec<_>>();

        let (page, cursor) = page_log_entries(entries, None, None, 100);
        assert_eq!(page.len(), 100, "the window is truncated to the page size");
        let cursor = cursor.expect("a full page with more behind it carries a cursor");
        assert_eq!(cursor, "9901:1", "cursor is the oldest kept entry");
    }

    #[test]
    fn same_ms_ordinals_are_stable_across_page_windows() {
        // Round-9 F1 regression: the same-millisecond ordinal used to be
        // window-relative — the first page tailed `limit + 1` lines while a
        // cursor page tailed MAX_LOG_CURSOR_TAIL. With a same-ms run longer
        // than the first page's window, the SAME physical lines got DIFFERENT
        // ordinals depending on which window collected them, so a cursor page
        // produced the SAME id set as the first page; the client's
        // dedupe-by-id then discarded the whole cursor page (silent data
        // loss) and live refreshes double-showed lines whose ordinal shifted.
        // With one fixed window the ordinal is a property of the physical
        // line: line i of a same-ms run is always `service-timestamp-i` on
        // every fetch.
        let service = "svc";
        let timestamp = 1_000_000u64;
        // 250 same-ms lines — longer than the OLD first-page window of
        // limit + 1 = 101, which is what made the id sets collide.
        let lines = (0..250)
            .map(|index| LogEntry {
                id: String::new(),
                timestamp,
                container: service.into(),
                level: dockermap_core::LogLevel::Info,
                message: format!("burst line {index}"),
            })
            .collect::<Vec<_>>();

        // Fetch through the same fixed window exactly like collect_logs:
        // assign stream-order ordinals and ids, then page the window.
        let fetch = |window: &[LogEntry], cursor: Option<LogCursor>, limit: usize| {
            let mut seen = HashMap::<u64, usize>::new();
            let entries = window
                .iter()
                .map(|entry| {
                    let ordinal = seen.entry(entry.timestamp).or_insert(0);
                    let id = log_entry_id(&entry.container, entry.timestamp, *ordinal);
                    *ordinal += 1;
                    LogEntry {
                        id,
                        ..entry.clone()
                    }
                })
                .collect::<Vec<_>>();
            page_log_entries(entries, None, cursor, limit)
        };

        let window = lines.clone();
        let (first_page, first_cursor) = fetch(&window, None, 100);
        let first_cursor = first_cursor.expect("a full first page carries a cursor");
        let (second_page, second_cursor) = fetch(&window, LogCursor::parse(&first_cursor), 100);
        let second_cursor = second_cursor.expect("a full second page carries a cursor");
        let (third_page, third_cursor) = fetch(&window, LogCursor::parse(&second_cursor), 100);
        assert!(
            third_cursor.is_none(),
            "the run ends with a cursor-less page"
        );

        // Walk the pages: no id overlap between pages, no duplicates, and
        // every physical line keeps its TRUE ordinal — line i is
        // `service-timestamp-i` no matter which fetch saw it.
        let mut ids = HashSet::new();
        let mut id_by_line = HashMap::<usize, String>::new();
        for page in [&first_page, &second_page, &third_page] {
            for entry in page {
                let id = &entry.id;
                assert!(
                    ids.insert(id.clone()),
                    "id {id} delivered twice across pages"
                );
                let index = entry
                    .message
                    .strip_prefix("burst line ")
                    .and_then(|value| value.parse::<usize>().ok())
                    .expect("every entry carries its physical line index");
                assert!(
                    id_by_line.insert(index, id.clone()).is_none(),
                    "physical line {index} delivered twice"
                );
            }
        }
        for (index, id) in id_by_line {
            assert_eq!(
                id,
                log_entry_id(service, timestamp, index),
                "line {index} must keep its true ordinal on every fetch"
            );
        }
    }

    #[test]
    fn skips_blank_and_unprefixed_log_lines_and_keeps_real_timestamps() {
        // Docker emits a blank line as "<timestamp> " (timestamp, space, empty
        // body). It must be skipped, not fabricated into a now-stamped entry
        // whose message is the raw timestamp string.
        assert_eq!(
            parse_timestamped_log_line(b"2026-08-20T03:03:02.538671807Z "),
            None,
            "blank lines must be skipped"
        );

        // Docker prefixes ONLY the first line of a multi-line message;
        // continuation lines are bare text with no timestamp. They must be
        // skipped — NOT stamped with now() — and their first token must not
        // be eaten as if it were a prefix.
        assert_eq!(
            parse_timestamped_log_line(b"hello world"),
            None,
            "a continuation line without a timestamp prefix must be skipped"
        );
        assert_eq!(
            parse_timestamped_log_line(b""),
            None,
            "a completely empty line must be skipped"
        );
        assert_eq!(
            parse_timestamped_log_line(b"   "),
            None,
            "a whitespace-only line must be skipped"
        );

        // A normal line keeps its real timestamp rather than falling back to
        // now().
        let (timestamp, message) =
            parse_timestamped_log_line(b"2026-08-20T03:03:02.538671807Z hello")
                .expect("a normal line should parse");
        assert_eq!(message, "hello");
        assert_eq!(
            timestamp, 1_787_194_982_538,
            "the real timestamp must be preserved, not replaced with now()"
        );
    }

    #[test]
    fn log_until_covers_the_boundary_millisecond() {
        // Docker's `until` is second-resolution and exclusive. The compound
        // cursor's boundary millisecond must still be returned (its
        // not-yet-emitted same-ms entries resume via the offset), so `until`
        // is `floor(millis / 1000) + 1` — it covers the second CONTAINING
        // the boundary. Entries in that second that are newer than the
        // boundary are filtered out by page_log_entries afterwards.
        assert_eq!(log_until_seconds(1_785_175_506_123), 1_785_175_507);
        assert_eq!(
            log_until_seconds(1_785_175_506_000),
            1_785_175_507,
            "an exact second boundary must still include its own second"
        );
        assert_eq!(log_until_seconds(1_000), 2);
        assert_eq!(log_until_seconds(999), 1);
        assert_eq!(log_until_seconds(0), 1);
    }

    #[test]
    fn log_until_boundary_keeps_same_second_entries_before_cursor() {
        // Entries in the boundary second before the cursor survive the ms
        // filter, so a cursor at S.123 keeps [S.000, S.123) and drops the
        // rest — mirroring the div_ceil `until` contract.
        let entries = (0..6)
            .map(|index| LogEntry {
                id: format!("svc-{index}"),
                timestamp: 1_000_123 - index,
                container: "svc".into(),
                level: dockermap_core::LogLevel::Info,
                message: format!("line {index}"),
            })
            .collect::<Vec<_>>();

        let (page, _) = page_log_entries(
            entries,
            None,
            Some(LogCursor {
                millis: 1_000_123,
                offset: 1,
            }),
            10,
        );
        assert_eq!(
            page.len(),
            5,
            "all entries strictly older than the cursor are kept"
        );
        assert!(page.iter().all(|entry| entry.timestamp < 1_000_123));
        assert_eq!(page.last().map(|entry| entry.timestamp), Some(1_000_118));
    }

    #[test]
    fn provider_commands_time_out_and_report_diagnostics() {
        let started = std::time::Instant::now();
        let error = run_command_with_timeout(
            {
                let mut command = Command::new("sleep");
                command.arg("30");
                command
            },
            Duration::from_millis(200),
        )
        .expect_err("a hung provider command must time out");
        assert!(error.to_string().contains("timed out"), "{error}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the timeout must bound the wait, took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn provider_commands_succeed_within_timeout() {
        let output = run_command_with_timeout(
            {
                let mut command = Command::new("sh");
                command.arg("-c").arg("echo ok");
                command
            },
            Duration::from_secs(5),
        )
        .expect("a fast provider command should succeed");
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "ok");
    }

    #[test]
    fn docker_container_nodes_carry_layer_and_service_entity() {
        let snapshot = mock_snapshot();
        let map = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new(), "test");

        let container = map
            .nodes
            .iter()
            .find(|node| node.kind == RuntimeNodeKind::Container)
            .expect("derive_runtime_map should emit container nodes");
        assert_eq!(container.layer, Some(RuntimeNodeLayer::Container));
        let service = container
            .service
            .as_ref()
            .expect("container nodes carry a service entity");
        assert!(!service.name.is_empty());
        assert_eq!(
            service.status,
            RuntimeServiceStatus::from_status_text(container.status.as_deref().unwrap_or_default())
        );

        assert!(map.nodes.iter().any(|node| {
            node.kind == RuntimeNodeKind::DockerNetwork
                && node.layer == Some(RuntimeNodeLayer::Network)
        }));
        assert!(map.nodes.iter().any(|node| {
            node.kind == RuntimeNodeKind::DockerVolume
                && node.layer == Some(RuntimeNodeLayer::Storage)
        }));
    }

    #[test]
    fn redacts_compose_environment_fixture_output() {
        let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/providers/redaction");
        let file = project_root.join("compose-environment.yaml");
        let content = fs::read_to_string(&file).expect("compose redaction fixture");
        assert!(content.contains("DOCKERMAP_TEST_FAKE_COMPOSE_TOKEN"));
        assert!(content.contains("DOCKERMAP_TEST_FAKE_COMPOSE_PASSWORD"));

        let mut scan =
            scan_compose_files(&project_root, std::slice::from_ref(&file)).expect("fixture scans");
        redact_compose_scan(&mut scan);

        let serialized = serde_json::to_string(&scan).expect("scan should serialize");
        assert!(
            !serialized.contains("DOCKERMAP_TEST_FAKE_COMPOSE_TOKEN"),
            "scan JSON leaked the token sentinel: {serialized}"
        );
        assert!(
            !serialized.contains("DOCKERMAP_TEST_FAKE_COMPOSE_PASSWORD"),
            "scan JSON leaked the password sentinel: {serialized}"
        );
        assert!(
            serialized.contains("POSTGRES_PASSWORD"),
            "environment keys stay visible so the shape remains useful"
        );
        assert_no_raw_secrets(
            &scan,
            &[
                "DOCKERMAP_TEST_FAKE_COMPOSE_TOKEN",
                "DOCKERMAP_TEST_FAKE_COMPOSE_PASSWORD",
            ],
        );
    }

    #[test]
    fn redacts_compose_environment_keys_and_reports_normalization_collisions() {
        let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/providers/redaction");
        let file = project_root.join("compose-environment.yaml");
        let mut scan =
            scan_compose_files(&project_root, std::slice::from_ref(&file)).expect("fixture scans");
        let environment = &mut scan.services[0].environment;
        environment.insert(
            "DOCKERMAP_TEST_FAKE_SOL5_VALID_ENV_KEY".into(),
            "safe".into(),
        );
        environment.insert("bidi\u{202e}control\u{001b}key".into(), "safe".into());
        environment.insert("collision\u{200b}".into(), "first".into());
        environment.insert("collision\u{202e}".into(), "second".into());

        redact_compose_scan(&mut scan);

        let serialized = serde_json::to_string(&scan).expect("scan should serialize");
        assert!(!serialized.contains("DOCKERMAP_TEST_FAKE_SOL5_VALID_ENV_KEY"));
        assert!(!serialized.contains('\u{202e}'));
        assert!(!serialized.contains('\u{001b}'));
        let environment = &scan.services[0].environment;
        assert_eq!(
            environment
                .keys()
                .filter(|key| key.as_str() == "collision�")
                .count(),
            1,
            "normalization collisions retain one deterministic published key"
        );
        assert!(scan
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "compose_environment_key_collision"));
    }

    #[test]
    fn redacts_compose_graph_fixture_output() {
        let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/providers/redaction");
        let file = project_root.join("compose-environment.yaml");
        let content = fs::read_to_string(&file).expect("compose redaction fixture");
        assert!(content.contains("DOCKERMAP_TEST_FAKE_COMPOSE_TOKEN"));
        assert!(content.contains("DOCKERMAP_TEST_FAKE_COMPOSE_PASSWORD"));

        let mut scan =
            scan_compose_files(&project_root, std::slice::from_ref(&file)).expect("fixture scans");
        redact_compose_scan(&mut scan);
        let graph = derive_compose_graph(&scan);

        let serialized = serde_json::to_string(&graph).expect("graph should serialize");
        assert!(
            !serialized.contains("DOCKERMAP_TEST_FAKE_COMPOSE_TOKEN"),
            "graph JSON leaked the token sentinel: {serialized}"
        );
        assert!(
            !serialized.contains("DOCKERMAP_TEST_FAKE_COMPOSE_PASSWORD"),
            "graph JSON leaked the password sentinel: {serialized}"
        );
        assert!(
            serialized.contains("compose_host_path_"),
            "bind-source host-path nodes still appear with redacted ids/labels: {serialized}"
        );
    }

    #[test]
    fn redacts_sensitive_lines_in_unified_diffs() {
        let diff = "@@ -1,5 +1,5 @@\nservices:\n  app:\n    image: alpine\n-    - POSTGRES_PASSWORD=DOCKERMAP_TEST_FAKE_COMPOSE_PASSWORD\n+    - API_TOKEN=DOCKERMAP_TEST_FAKE_COMPOSE_TOKEN\n";
        // The literal above uses explicit `\n` escapes (no source line
        // continuations), so context-line leading spaces survive.
        let lines = diff.split('\n').count();
        assert_eq!(lines, 7, "diff should keep its line structure: {lines}");
        let redacted = redact_unified_diff(diff);
        assert!(!redacted.contains("DOCKERMAP_TEST_FAKE_COMPOSE_PASSWORD"));
        assert!(!redacted.contains("DOCKERMAP_TEST_FAKE_COMPOSE_TOKEN"));
        assert!(
            redacted.contains("-[redacted]"),
            "sensitive removal line keeps its marker: {redacted}"
        );
        assert!(
            redacted.contains("+[redacted]"),
            "sensitive addition line keeps its marker: {redacted}"
        );
        assert!(
            redacted.contains("  image: alpine"),
            "safe context lines stay intact: {redacted}"
        );
    }

    #[test]
    fn runtime_display_redaction_neutralizes_unicode_spoofing_in_process_comm_and_user_metadata() {
        // C0/DEL/C1, bidi controls, default-ignorables, separators, and
        // noncharacters are all operator-facing spoofing vectors. They must
        // be neutralized at the shared runtime publication boundary, not by
        // individual provider parsers.
        let unsafe_display = |value: &str| {
            value.chars().any(|character| {
                let code = character as u32;
                character.is_control()
                    || (0x200B..=0x200F).contains(&code)
                    || (0x2028..=0x202E).contains(&code)
                    || (0x2060..=0x2069).contains(&code)
                    || code == 0xFEFF
                    || (0xFDD0..=0xFDEF).contains(&code)
                    || matches!(code & 0xFFFF, 0xFFFE | 0xFFFF)
            })
        };
        let table = concat!(
            " 9000000  user\u{001b}\u{007f}\u{0080}  evil\u{202e}\u{200b}  /usr/bin/evil\n",
            " 9000001  user\u{001b}\u{007f}\u{0080}  python3  /srv/app\u{202e}\u{200b}.py\n"
        );
        let (mut native_nodes, _) = native_process_nodes_from_ps_output(table, 9_000_500);
        let (mut python_nodes, _) = python_nodes_from_ps_output(table);
        native_nodes.append(&mut python_nodes);

        redact_runtime_nodes(&mut native_nodes);

        assert_eq!(native_nodes.len(), 2);
        for node in native_nodes {
            assert!(!unsafe_display(&node.label), "unsafe label: {}", node.label);
            assert!(node.metadata.values().all(|value| !unsafe_display(value)));
        }
    }

    #[test]
    fn unavailable_ps_reports_static_warning_for_both_process_providers() {
        let unavailable_ps = || Command::new("/definitely-not-a-dockermap-ps-command");
        let mut python_nodes = Vec::new();
        let mut python_diagnostics = Vec::new();
        collect_python_processes_with_command(
            unavailable_ps(),
            &mut python_nodes,
            &mut python_diagnostics,
        );
        let mut native_nodes = Vec::new();
        let mut native_diagnostics = Vec::new();
        collect_native_processes_with_command(
            unavailable_ps(),
            false,
            &mut native_nodes,
            &mut native_diagnostics,
        );

        assert!(python_nodes.is_empty());
        assert!(native_nodes.is_empty());
        assert!(python_diagnostics.iter().any(|diagnostic| {
            diagnostic.provider == RuntimeProviderKind::Python
                && diagnostic.severity == DiagnosticSeverity::Warning
                && diagnostic.message == "Python process discovery command unavailable"
        }));
        assert!(native_diagnostics.iter().any(|diagnostic| {
            diagnostic.provider == RuntimeProviderKind::Process
                && diagnostic.severity == DiagnosticSeverity::Warning
                && diagnostic.message == "Native process discovery command unavailable"
        }));
    }

    #[test]
    fn pid_namespace_modes_require_affirmative_evidence_and_surface_ambiguity() {
        let runit = pid_namespace_scope_from_evidence(
            PidNamespaceMode::Auto,
            Some("runit"),
            "0::/\n",
            false,
            false,
            false,
        );
        assert_eq!(runit, PidNamespaceScope::Restricted);
        assert_eq!(
            pid_namespace_scope_from_evidence(
                PidNamespaceMode::Auto,
                Some("systemd"),
                "0::/\n",
                true,
                false,
                false,
            ),
            PidNamespaceScope::Restricted,
            "/.dockerenv is affirmative restricted evidence"
        );
        assert_eq!(
            pid_namespace_scope_from_evidence(
                PidNamespaceMode::Auto,
                Some("systemd"),
                "0::/\n",
                false,
                false,
                true,
            ),
            PidNamespaceScope::Restricted,
            "/run/.containerenv is affirmative Podman evidence"
        );
        assert_eq!(
            pid_namespace_scope_from_evidence(
                PidNamespaceMode::Restricted,
                Some("systemd"),
                "0::/\n",
                false,
                false,
                false,
            ),
            PidNamespaceScope::Restricted,
            "the explicit compose override wins over ambiguous auto evidence"
        );
        assert_eq!(
            pid_namespace_scope_from_evidence(
                PidNamespaceMode::Host,
                Some("entrypoint"),
                "0::/system.slice/docker-abc.scope\n",
                true,
                true,
                true,
            ),
            PidNamespaceScope::Host { diagnostic: None },
            "explicit host mode always collects host providers"
        );
        assert_eq!(
            PidNamespaceMode::from_env_value(None),
            PidNamespaceMode::Auto
        );
        assert_eq!(
            PidNamespaceMode::from_env_value(Some("restricted")),
            PidNamespaceMode::Restricted
        );
        assert_eq!(
            PidNamespaceMode::from_env_value(Some("unexpected")),
            PidNamespaceMode::Restricted,
            "invalid namespace configuration must not enable host collection"
        );
    }

    #[test]
    fn python_container_cgroup_rows_are_filtered_before_the_process_cap() {
        let cgroup = "0::/system.slice/docker-abc123def456.scope\n";
        assert!(cgroup_implies_container(cgroup));
        let table = concat!(
            " 9000000  root  python3  /usr/bin/python3 /container/app.py\n",
            " 9000001  root  python3  /usr/bin/python3 /host/app.py\n"
        );
        let (nodes, capped) = python_nodes_from_ps_output_with_container_filter(table, |pid| {
            pid == 9_000_000 && cgroup.lines().any(cgroup_implies_container)
        });
        assert!(!capped);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].id, "python_process_9000001");
    }

    #[test]
    fn restricted_namespace_omits_python_collection() {
        let mut nodes = Vec::new();
        let mut diagnostics = Vec::new();
        let mut python_command = Command::new("sh");
        python_command
            .arg("-c")
            .arg("printf ' 9000000 root python3 python3 /app.py'");
        collect_python_processes_with_command_in_scope(
            python_command,
            true,
            &mut nodes,
            &mut diagnostics,
        );

        assert!(nodes.is_empty());
        assert!(diagnostics
            .iter()
            .any(|diagnostic| diagnostic.provider == RuntimeProviderKind::Python));
    }

    #[test]
    fn provider_diagnostics_are_redacted_before_stderr_and_api_storage() {
        let sentinel = "DOCKERMAP_TEST_FAKE_STDERR_SECRET";
        let mut diagnostics = Vec::new();
        push_provider_diagnostic(
            &mut diagnostics,
            RuntimeProviderKind::Npm,
            DiagnosticSeverity::Warning,
            format!("npm discovery failed at /tmp/{sentinel}/package.json"),
        );
        let api_message = &diagnostics[0].message;
        let mut captured_stderr = Vec::new();
        write_provider_diagnostic(
            &mut captured_stderr,
            &RuntimeProviderKind::Npm,
            &DiagnosticSeverity::Warning,
            api_message,
        )
        .expect("test stderr capture should accept a diagnostic");
        let captured_stderr = String::from_utf8(captured_stderr).expect("stderr is utf-8");

        assert_eq!(api_message, REDACTED_VALUE);
        assert!(!api_message.contains(sentinel));
        assert!(!captured_stderr.contains(sentinel));
        assert!(captured_stderr.contains(REDACTED_VALUE));
    }

    #[test]
    fn publishes_live_and_mock_logs_through_the_shared_sanitizer_before_paging() {
        let sentinel = "DOCKERMAP_TEST_FAKE_LIVE_LOG_SECRET";
        let live = publish_log_response(
            Some("service\u{202e}name"),
            vec![LogEntry {
                id: "live\u{202e}id".into(),
                timestamp: 1,
                container: "container\u{202e}name".into(),
                level: dockermap_core::LogLevel::Info,
                message: format!("token={sentinel}"),
            }],
            Some("redacted"),
            None,
            10,
        );
        let live_json = serde_json::to_string(&live).expect("response should serialize");
        assert!(!live_json.contains(sentinel));
        assert!(!live_json.contains('\u{202e}'));
        assert_eq!(live.entries.len(), 1, "filtering sees the redacted message");
        assert_eq!(live.service.as_deref(), Some("service�name"));

        let mut snapshot = mock_snapshot();
        snapshot.containers[0].role = format!("token={sentinel}");
        let mock = publish_log_response(
            None,
            mock_log_entries(&snapshot, None),
            Some("redacted"),
            None,
            MAX_LOG_PAGE_SIZE,
        );
        let mock_json = serde_json::to_string(&mock).expect("response should serialize");
        assert!(!mock_json.contains(sentinel));
        assert!(
            mock.entries
                .iter()
                .any(|entry| entry.message == REDACTED_VALUE),
            "mock messages are redacted before filtering"
        );

        let raw_secret_query = publish_log_response(
            None,
            mock_log_entries(&snapshot, None),
            Some(sentinel),
            None,
            MAX_LOG_PAGE_SIZE,
        );
        assert!(
            raw_secret_query.entries.is_empty(),
            "a raw secret must not influence observable mock filtering"
        );
    }

    #[test]
    fn runtime_id_components_keep_raw_identity_variants_distinct() {
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
        let generated = identities
            .iter()
            .map(|identity| safe_runtime_id_component(identity, "fallback"))
            .collect::<HashSet<_>>();
        assert_eq!(
            generated.len(),
            identities.len(),
            "runtime and package IDs must include a raw-identity hash suffix"
        );
    }

    #[test]
    fn runtime_map_publication_normalizes_all_ids_and_keeps_edges_consistent() {
        let unsafe_id = "node\u{202e}id";
        let unsafe_package_id = "package\u{202e}id";
        let mut service =
            RuntimeServiceEntity::minimal("service".into(), RuntimeServiceStatus::Running);
        service.logs.push(RuntimeLogRef {
            id: "log\u{202e}id".into(),
            source: "source".into(),
            level: Some(RuntimeLogLevel::Info),
        });
        service.events.push(RuntimeEventRef {
            id: "event\u{202e}id".into(),
            kind: "event".into(),
            timestamp: None,
            message: None,
        });
        service.owner = Some(RuntimeOwnership {
            kind: RuntimeOwnershipKind::Person,
            name: "owner".into(),
            id: Some("owner\u{202e}id".into()),
        });
        let mut package = RuntimePackageEntity::minimal("package".into(), "1.0.0".into());
        package.update = Some(RuntimePackageUpdate {
            current_version: "1.0.0".into(),
            latest_version: None,
            available: true,
            advisories: vec![RuntimePackageAdvisory {
                id: "advisory\u{202e}id".into(),
                source: "source".into(),
                title: "title".into(),
                severity: RuntimeAdvisorySeverity::Low,
                fixed_version: None,
                url: None,
                published_at: None,
            }],
        });
        let node = RuntimeMapNode {
            id: unsafe_id.into(),
            provider: RuntimeProviderKind::Other,
            kind: RuntimeNodeKind::Service,
            label: "node".into(),
            status: None,
            layer: None,
            metadata: BTreeMap::new(),
            service: Some(service),
            package: None,
        };
        let duplicate_after_normalization = RuntimeMapNode {
            id: "node\u{202d}id".into(),
            ..node.clone()
        };
        let package_node = RuntimeMapNode {
            id: unsafe_package_id.into(),
            provider: RuntimeProviderKind::Npm,
            kind: RuntimeNodeKind::PackageDependency,
            label: "package".into(),
            status: None,
            layer: None,
            metadata: BTreeMap::new(),
            service: None,
            package: Some(package),
        };
        let edge = RuntimeMapEdge {
            source: unsafe_id.into(),
            target: unsafe_package_id.into(),
            relationship: RuntimeRelationshipKind::DependsOn,
            metadata: BTreeMap::new(),
            evidence_refs: Vec::new(),
        };
        let mut map = RuntimeMap {
            nodes: vec![node, duplicate_after_normalization, package_node],
            edges: vec![edge.clone(), edge],
            diagnostics: Vec::new(),
            last_updated: 0,
            ..Default::default()
        };

        redact_runtime_map(&mut map);

        let ids = map
            .nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(map.nodes.len(), 3, "normalized node IDs remain visible");
        assert!(
            map.diagnostics.iter().any(|diagnostic| diagnostic
                .message
                .contains("records remain visible and non-routable")),
            "a publication-time collision must be surfaced without discarding either node"
        );
        assert_eq!(
            map.edges.len(),
            1,
            "normalized equivalent edges are deduplicated"
        );
        assert!(map.edges.iter().all(|edge| {
            ids.contains(edge.source.as_str()) && ids.contains(edge.target.as_str())
        }));
        let service = map
            .nodes
            .iter()
            .find_map(|node| node.service.as_ref())
            .expect("service node remains");
        assert_eq!(service.logs[0].id, "log�id");
        assert_eq!(service.events[0].id, "event�id");
        assert_eq!(
            service.owner.as_ref().and_then(|owner| owner.id.as_deref()),
            Some("owner�id")
        );
        let advisory = map
            .nodes
            .iter()
            .find_map(|node| node.package.as_ref())
            .and_then(|package| package.update.as_ref())
            .and_then(|update| update.advisories.first())
            .expect("package advisory remains");
        assert_eq!(advisory.id, "advisory�id");
    }

    #[test]
    fn daemon_state_risk_evidence_stays_path_free_through_publication() {
        let mut snapshot = mock_snapshot();
        snapshot.containers[0].mounts = vec![ContainerMount {
            id: "private-daemon-state-mount".into(),
            kind: ComposeMountKind::Bind,
            source: Some("/private/DOCKERMAP_TEST_DAEMON_STATE/docker.sock".into()),
            target: "/private/target".into(),
            read_only: false,
        }];
        let mut map = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new(), "test");
        redact_runtime_map(&mut map);
        let serialized = serde_json::to_string(&map).unwrap();
        assert!(serialized.contains("host_risk_docker_daemon_state"));
        assert!(serialized.contains("docker_daemon_state_bind_mount"));
        for forbidden in [
            "DOCKERMAP_TEST_DAEMON_STATE",
            "/private/target",
            "private-daemon-state-mount",
            "readOnly",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "publication leaked {forbidden}"
            );
        }
    }

    #[test]
    fn compose_publication_normalizes_diagnostics_and_graph_inputs() {
        let mut scan = ComposeScan {
            files: vec!["/project\u{202e}/compose.yaml".into()],
            project_root: "/project\u{202e}".into(),
            services: Vec::new(),
            mounts: vec![ComposeMount {
                id: "mount\u{202e}id".into(),
                service: "service\u{202e}name".into(),
                kind: ComposeMountKind::Bind,
                source: Some("/host\u{202e}/source".into()),
                resolved_source: Some("/host\u{202e}/source".into()),
                target: "/container\u{202e}/target".into(),
                read_only: false,
                origin: ComposeFileOrigin {
                    file: "/project\u{202e}/compose.yaml".into(),
                    service: Some("service\u{202e}name".into()),
                    field: "services\u{202e}.volumes".into(),
                },
            }],
            correlations: Vec::new(),
            diagnostics: vec![ComposeDiagnostic {
                id: "diagnostic\u{202e}id".into(),
                severity: DiagnosticSeverity::Warning,
                message: "message\u{202e}text".into(),
                origin: ComposeFileOrigin {
                    file: "/project\u{202e}/compose.yaml".into(),
                    service: Some("service\u{202e}name".into()),
                    field: "services\u{202e}.volumes".into(),
                },
            }],
        };

        redact_compose_scan(&mut scan);
        let graph = derive_compose_graph(&scan);
        let scan_json = serde_json::to_string(&scan).expect("scan should serialize");
        let graph_json = serde_json::to_string(&graph).expect("graph should serialize");
        assert!(!scan_json.contains('\u{202e}'));
        assert!(!graph_json.contains('\u{202e}'));
        assert_eq!(scan.diagnostics[0].id, "diagnostic�id");
        assert_eq!(scan.diagnostics[0].origin.file, "/project�/compose.yaml");
        assert_eq!(
            scan.diagnostics[0].origin.service.as_deref(),
            Some("service�name")
        );
        assert_eq!(scan.diagnostics[0].origin.field, "services�.volumes");
    }

    #[test]
    fn publication_helpers_redact_and_normalize_compose_inventory_and_health() {
        let sentinel = "DOCKERMAP_TEST_FAKE_PUBLICATION_SECRET";
        let hostile = format!("token={sentinel}\u{202e}\u{200b}\u{001b}\u{2028}\u{fdd0}");
        let mut plan = ComposeEditPlan {
            file: hostile.clone(),
            service: hostile.clone(),
            mount_id: hostile.clone(),
            original_source: Some(hostile.clone()),
            original_target: hostile.clone(),
            new_source: Some(hostile.clone()),
            new_target: Some(hostile.clone()),
            unified_diff: format!(
                "--- {hostile}\n+++ {hostile}\n- token={sentinel}\n+ token={sentinel}"
            ),
            diagnostics: vec![ComposeDiagnostic {
                id: hostile.clone(),
                severity: DiagnosticSeverity::Warning,
                message: hostile.clone(),
                origin: ComposeFileOrigin {
                    file: hostile.clone(),
                    service: Some(hostile.clone()),
                    field: hostile.clone(),
                },
            }],
            will_write: false,
        };
        redact_compose_edit_plan(&mut plan);

        let mut snapshot = mock_snapshot();
        snapshot.containers[0].id = hostile.clone();
        snapshot.containers[0].name = hostile.clone();
        snapshot.containers[0].image = hostile.clone();
        snapshot.containers[0].status = hostile.clone();
        snapshot.containers[0].role = hostile.clone();
        snapshot.containers[0].networks = vec![hostile.clone()];
        snapshot.containers[0].ports = vec![hostile.clone()];
        snapshot.containers[0].mounts = vec![ContainerMount {
            id: hostile.clone(),
            kind: ComposeMountKind::Bind,
            source: Some(hostile.clone()),
            target: hostile.clone(),
            read_only: false,
        }];
        snapshot.containers[0].depends_on = vec![hostile.clone()];
        snapshot.images = vec![dockermap_core::ImageRecord {
            image: hostile.clone(),
            containers: vec![hostile.clone()],
            status: hostile.clone(),
        }];
        snapshot.networks = vec![NetworkRecord {
            id: hostile.clone(),
            name: hostile.clone(),
            driver: hostile.clone(),
            internal: false,
            members: vec![hostile.clone()],
        }];
        snapshot.volumes = vec![VolumeRecord {
            id: hostile.clone(),
            name: hostile.clone(),
            attached_to: vec![hostile.clone()],
        }];
        let published_snapshot = publish_docker_snapshot(&snapshot);
        assert!(
            snapshot.containers[0].name.contains(sentinel),
            "the internal cache must retain raw inventory identities for lookup"
        );

        let mut health = HealthResponse {
            status: HealthState::Degraded,
            mode: RuntimeMode::Mock,
            docker_reachable: false,
            last_updated: 1,
            snapshot_version: "1".into(),
            model_revision: String::new(),
            message: Some(hostile),
        };
        redact_health_response(&mut health);

        let serialized = serde_json::to_string(&(plan, published_snapshot, health))
            .expect("published values should serialize");
        assert!(!serialized.contains(sentinel));
        assert!(!serialized.chars().any(unsafe_runtime_display_character));
    }

    fn assert_no_raw_secrets<T: serde::Serialize>(value: &T, secrets: &[&str]) {
        let serialized = serde_json::to_string(value).expect("value should serialize");
        for secret in secrets {
            assert!(
                !serialized.contains(secret),
                "serialized provider output leaked `{secret}`: {serialized}"
            );
        }
    }
}
