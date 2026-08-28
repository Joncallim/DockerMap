//! Default-deny Docker Read Gateway.
//!
//! The gateway deliberately has a fixed, measured Docker read contract.  It
//! validates an origin-form target before it ever opens the raw Docker socket,
//! then forwards a newly-built request over that socket.  It is not a generic
//! Docker proxy.

use std::{io, path::PathBuf, sync::Arc};

use bytes::Bytes;
use http::{header, Method, Request, Response, StatusCode};
use http_body_util::{BodyExt, Full};
use hyper::{
    body::Incoming, client::conn::http1, server::conn::http1 as server_http1, service::service_fn,
};
use hyper_util::rt::TokioIo;
use tokio::net::{UnixListener, UnixStream};

pub const LOG_TAIL: &str = "4096";

#[derive(Clone, Debug)]
pub struct GatewayConfig {
    pub listen_socket: PathBuf,
    pub docker_socket: PathBuf,
    pub label_filter: Option<String>,
}

impl GatewayConfig {
    pub fn new(
        listen_socket: impl Into<PathBuf>,
        docker_socket: impl Into<PathBuf>,
        label_filter: Option<String>,
    ) -> Self {
        Self {
            listen_socket: listen_socket.into(),
            docker_socket: docker_socket.into(),
            label_filter,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Policy {
    label_filter: Option<String>,
}

#[derive(Debug, Eq, PartialEq)]
pub enum Deny {
    Method,
    Framing,
    Target,
    Query,
}

impl Policy {
    pub fn new(label_filter: Option<String>) -> Self {
        Self {
            label_filter: label_filter.and_then(|value| {
                let trimmed = value.trim();
                (!trimmed.is_empty()).then(|| trimmed.to_owned())
            }),
        }
    }

    /// Validates the parsed HTTP request without normalising suspicious targets.
    /// The caller must use the returned exact target verbatim upstream.
    pub fn allow<B>(&self, request: &Request<B>) -> Result<String, Deny> {
        if request.method() != Method::GET {
            return Err(Deny::Method);
        }
        if request.uri().scheme().is_some() || request.uri().authority().is_some() {
            return Err(Deny::Target);
        }
        for name in [
            header::CONTENT_LENGTH,
            header::TRANSFER_ENCODING,
            header::UPGRADE,
            header::EXPECT,
            header::TRAILER,
            header::CONNECTION,
        ] {
            if request.headers().contains_key(name) {
                return Err(Deny::Framing);
            }
        }
        let target = request
            .uri()
            .path_and_query()
            .map(|v| v.as_str())
            .ok_or(Deny::Target)?;
        if !target.starts_with('/') || target.starts_with("//") {
            return Err(Deny::Target);
        }
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        if target.matches('?').count() > 1
            || path.contains("/./")
            || path.contains("/../")
            || path.ends_with("/.")
            || path.ends_with("/..")
            || path.contains('%')
            || path.contains('\\')
        {
            return Err(Deny::Target);
        }
        match path {
            "/containers/json" => self.inventory(target, "/containers/json?all=true&size=false"),
            "/networks" => self.inventory(target, "/networks?"),
            "/volumes" => self.inventory(target, "/volumes?"),
            _ if path.starts_with("/containers/") && path.ends_with("/logs") => {
                self.logs(target, path, query)
            }
            _ => Err(Deny::Target),
        }
    }

    fn inventory(&self, target: &str, base: &str) -> Result<String, Deny> {
        match &self.label_filter {
            None if target == base => Ok(target.into()),
            Some(label) => {
                let separator = if base.ends_with('?') { "" } else { "&" };
                let json = format!(
                    r#"{{"label":[{}]}}"#,
                    serde_json::to_string(label).expect("string serializes")
                );
                let encoded: String =
                    url::form_urlencoded::byte_serialize(json.as_bytes()).collect();
                let expected = format!("{base}{separator}filters={encoded}");
                if target == expected {
                    Ok(target.into())
                } else {
                    Err(Deny::Query)
                }
            }
            _ => Err(Deny::Query),
        }
    }

    fn logs(&self, target: &str, path: &str, query: &str) -> Result<String, Deny> {
        let name = &path[12..path.len() - 5];
        if !valid_container_name(name) {
            return Err(Deny::Target);
        }
        // This is the precise query order emitted by the measured Bollard wire
        // trace.  Do not accept a broader equivalent spelling at this boundary.
        let prefix = "follow=false&stdout=true&stderr=true&since=0&until=";
        let suffix = format!("&timestamps=true&tail={LOG_TAIL}");
        let Some(until) = query
            .strip_prefix(prefix)
            .and_then(|value| value.strip_suffix(&suffix))
        else {
            return Err(Deny::Query);
        };
        if until != "0"
            && (!until
                .bytes()
                .next()
                .is_some_and(|v| v.is_ascii_digit() && v != b'0')
                || !until.bytes().all(|v| v.is_ascii_digit()))
        {
            return Err(Deny::Query);
        }
        if until.is_empty() || query.matches('&').count() != 6 || query.contains('%') {
            return Err(Deny::Query);
        }
        Ok(target.into())
    }
}

fn valid_container_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name.bytes().enumerate().all(|(index, byte)| match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' => true,
            b'_' | b'.' | b'-' => index != 0,
            _ => false,
        })
}

/// Serves the filtered Unix socket until the caller stops the task.  The
/// listener is intentionally Unix-only: callers must explicitly mount the
/// filtered socket into the collector and never receive the raw socket.
pub async fn serve(config: GatewayConfig) -> io::Result<()> {
    if let Some(label) = config.label_filter.as_deref() {
        let trimmed = label.trim();
        if trimmed.is_empty()
            || trimmed.chars().count() > 256
            || trimmed.contains('\0')
            || trimmed.starts_with('=')
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid Docker label filter",
            ));
        }
    }
    if let Some(parent) = config.listen_socket.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    if config.listen_socket.exists() {
        std::fs::remove_file(&config.listen_socket)?;
    }
    let listener = UnixListener::bind(&config.listen_socket)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            &config.listen_socket,
            std::fs::Permissions::from_mode(0o660),
        )?;
    }
    let config = Arc::new(config);
    loop {
        let (stream, _) = listener.accept().await?;
        let config = Arc::clone(&config);
        tokio::spawn(async move {
            let service = service_fn(move |request| handle(request, Arc::clone(&config)));
            let _ = server_http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await;
        });
    }
}

async fn handle(
    request: Request<Incoming>,
    config: Arc<GatewayConfig>,
) -> Result<Response<http_body_util::combinators::BoxBody<Bytes, hyper::Error>>, hyper::Error> {
    let policy = Policy::new(config.label_filter.clone());
    let target = match policy.allow(&request) {
        Ok(target) => target,
        Err(_) => return Ok(empty_response(StatusCode::FORBIDDEN)),
    };
    // Refuse any body bytes even if a peer managed to present a body without
    // legal framing.  No upstream connection is made in that case.
    let collected = request.into_body().collect().await?;
    if !collected.to_bytes().is_empty() {
        return Ok(empty_response(StatusCode::FORBIDDEN));
    }

    let upstream = match UnixStream::connect(&config.docker_socket).await {
        Ok(stream) => stream,
        Err(_) => return Ok(empty_response(StatusCode::BAD_GATEWAY)),
    };
    let (mut sender, connection) = http1::handshake(TokioIo::new(upstream)).await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let upstream_request = Request::builder()
        .method(Method::GET)
        .uri(target)
        .header(header::HOST, "docker")
        .body(Full::new(Bytes::new()))
        .expect("fixed valid Docker request");
    let response = sender.send_request(upstream_request).await?;
    Ok(response.map(|body| body.boxed()))
}

fn empty_response(
    status: StatusCode,
) -> Response<http_body_util::combinators::BoxBody<Bytes, hyper::Error>> {
    Response::builder()
        .status(status)
        .body(
            Full::new(Bytes::new())
                .map_err(|never| match never {})
                .boxed(),
        )
        .expect("fixed response")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::Path,
        sync::atomic::{AtomicUsize, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        time::{sleep, Duration},
    };

    fn req(target: &str) -> Request<()> {
        Request::builder()
            .method("GET")
            .uri(target)
            .body(())
            .unwrap()
    }
    #[test]
    fn only_measured_unfiltered_requests_pass() {
        let policy = Policy::new(None);
        for target in ["/containers/json?all=true&size=false", "/networks?", "/volumes?", "/containers/api/logs?follow=false&stdout=true&stderr=true&since=0&until=0&timestamps=true&tail=4096"] { assert!(policy.allow(&req(target)).is_ok(), "{target}"); }
        for target in ["/containers/json?all=true", "/events", "/v1.44/containers/json?all=true&size=false", "/containers/api/json", "/containers/api/logs?follow=true&stdout=true&stderr=true&since=0&until=0&timestamps=true&tail=4096", "/containers/api/logs?follow=false&stdout=true&stderr=true&since=0&until=0&timestamps=true&tail=4097"] { assert!(policy.allow(&req(target)).is_err(), "{target}"); }
    }
    #[test]
    fn filtered_inventory_requires_exact_label_scope() {
        let policy = Policy::new(Some("com.dockermap.fixture=trace-123".into()));
        let target =
            "/networks?filters=%7B%22label%22%3A%5B%22com.dockermap.fixture%3Dtrace-123%22%5D%7D";
        assert!(policy.allow(&req(target)).is_ok());
        assert!(policy.allow(&req("/networks?")).is_err());
        assert!(Policy::new(None).allow(&req(target)).is_err());
    }
    #[test]
    fn parser_bypass_forms_fail_closed() {
        let policy = Policy::new(None);
        for target in ["//containers/json?all=true&size=false", "/containers%2fjson?all=true&size=false", "/containers/../events", "/containers/api/logs?follow=false&stdout=true&stderr=true&since=0&until=0&timestamps=true&tail=4096&x=1"] { assert!(policy.allow(&req(target)).is_err(), "{target}"); }
        assert_eq!(
            policy.allow(
                &Request::builder()
                    .method("POST")
                    .uri("/containers/create")
                    .body(())
                    .unwrap()
            ),
            Err(Deny::Method)
        );
    }

    #[test]
    fn policy_rejects_the_full_denial_class_without_normalising_it() {
        let policy = Policy::new(None);
        for target in [
            "/containers/create",
            "/containers/api/start",
            "/containers/api/stop",
            "/containers/api/restart",
            "/containers/api/json",
            "/containers/api/top",
            "/containers/api/archive",
            "/containers/api/export",
            "/exec",
            "/events",
            "/stats",
            "/images/json",
            "/build",
            "/networks/create",
            "/volumes/create",
            "/v1.44/containers/json?all=true&size=false",
            "/containers//json?all=true&size=false",
            "/containers%252fjson?all=true&size=false",
            "/containers%5cjson?all=true&size=false",
        ] {
            assert!(policy.allow(&req(target)).is_err(), "{target}");
        }
        for method in ["POST", "PUT", "PATCH", "DELETE", "CONNECT", "HEAD"] {
            assert_eq!(
                policy.allow(
                    &Request::builder()
                        .method(method)
                        .uri("/containers/create")
                        .body(())
                        .unwrap()
                ),
                Err(Deny::Method),
                "{method}"
            );
        }
        for (name, value) in [
            (header::CONTENT_LENGTH, "0"),
            (header::TRANSFER_ENCODING, "chunked"),
            (header::UPGRADE, "h2c"),
            (header::EXPECT, "100-continue"),
            (header::CONNECTION, "Upgrade"),
        ] {
            let request = Request::builder()
                .method("GET")
                .uri("/networks?")
                .header(name, value)
                .body(())
                .unwrap();
            assert_eq!(policy.allow(&request), Err(Deny::Framing));
        }
    }

    fn socket(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "dockermap-gateway-{name}-{}-{nonce}.sock",
            std::process::id()
        ))
    }

    async fn request(socket: &Path, raw: &str) -> String {
        let mut stream = UnixStream::connect(socket).await.unwrap();
        stream.write_all(raw.as_bytes()).await.unwrap();
        let mut bytes = vec![0; 1024];
        let read = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        String::from_utf8_lossy(&bytes[..read]).into_owned()
    }

    #[tokio::test]
    async fn denied_requests_never_reach_the_raw_docker_socket() {
        let raw_socket = socket("raw");
        let gateway_socket = socket("filtered");
        let upstream_hits = Arc::new(AtomicUsize::new(0));
        let listener = UnixListener::bind(&raw_socket).unwrap();
        let hits = Arc::clone(&upstream_hits);
        let upstream = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                hits.fetch_add(1, Ordering::SeqCst);
                let mut bytes = [0; 2048];
                let _ = stream.read(&mut bytes).await.unwrap();
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok")
                    .await
                    .unwrap();
            }
        });
        let gateway = tokio::spawn(serve(GatewayConfig::new(
            &gateway_socket,
            &raw_socket,
            None,
        )));
        for _ in 0..40 {
            if gateway_socket.exists() {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }
        for raw in [
            "POST /containers/create HTTP/1.1\r\nHost: docker\r\n\r\n",
            "PUT /containers/api/start HTTP/1.1\r\nHost: docker\r\n\r\n",
            "PATCH /containers/api/update HTTP/1.1\r\nHost: docker\r\n\r\n",
            "DELETE /containers/api HTTP/1.1\r\nHost: docker\r\n\r\n",
            "CONNECT docker HTTP/1.1\r\nHost: docker\r\n\r\n",
            "GET /events HTTP/1.1\r\nHost: docker\r\n\r\n",
            "GET /containers/api/json HTTP/1.1\r\nHost: docker\r\n\r\n",
            "GET /containers/api/top HTTP/1.1\r\nHost: docker\r\n\r\n",
            "GET /containers/api/archive HTTP/1.1\r\nHost: docker\r\n\r\n",
            "GET /containers/api/export HTTP/1.1\r\nHost: docker\r\n\r\n",
            "GET /images/json HTTP/1.1\r\nHost: docker\r\n\r\n",
            "GET /build HTTP/1.1\r\nHost: docker\r\n\r\n",
            "GET /v1.44/containers/json?all=true&size=false HTTP/1.1\r\nHost: docker\r\n\r\n",
            "GET //containers/json?all=true&size=false HTTP/1.1\r\nHost: docker\r\n\r\n",
            "GET /containers%2fjson?all=true&size=false HTTP/1.1\r\nHost: docker\r\n\r\n",
            "GET /containers%252fjson?all=true&size=false HTTP/1.1\r\nHost: docker\r\n\r\n",
            "GET /containers/../events HTTP/1.1\r\nHost: docker\r\n\r\n",
            "GET http://docker/containers/json?all=true&size=false HTTP/1.1\r\nHost: docker\r\n\r\n",
            "GET /containers/json?all=true&size=false&x=1 HTTP/1.1\r\nHost: docker\r\n\r\n",
            "GET /containers/json?all=true&size=false&size=false HTTP/1.1\r\nHost: docker\r\n\r\n",
            "GET /containers/json?all=true&size=%GG HTTP/1.1\r\nHost: docker\r\n\r\n",
            "GET /containers/api/logs?follow=true&stdout=true&stderr=true&since=0&until=0&timestamps=true&tail=4096 HTTP/1.1\r\nHost: docker\r\n\r\n",
            "GET /containers/api/logs?follow=false&stdout=true&stderr=true&since=0&until=0&timestamps=true&tail=4096&tail=4096 HTTP/1.1\r\nHost: docker\r\n\r\n",
            "GET /networks? HTTP/1.1\r\nHost: docker\r\nContent-Length: 0\r\n\r\n",
            "GET /networks? HTTP/1.1\r\nHost: docker\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
            "GET /networks? HTTP/1.1\r\nHost: docker\r\nUpgrade: h2c\r\n\r\n",
            "GET /networks? HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        ] {
            assert!(
                !request(&gateway_socket, raw).await.starts_with("HTTP/1.1 200"),
                "{raw}"
            );
        }
        assert_eq!(upstream_hits.load(Ordering::SeqCst), 0);
        gateway.abort();
        upstream.abort();
        let _ = std::fs::remove_file(raw_socket);
        let _ = std::fs::remove_file(gateway_socket);
    }

    #[tokio::test]
    async fn exact_allowed_request_is_forwarded_verbatim_to_the_raw_socket() {
        let raw_socket = socket("raw-allowed");
        let gateway_socket = socket("filtered-allowed");
        let listener = UnixListener::bind(&raw_socket).unwrap();
        let upstream = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 2048];
            let read = stream.read(&mut bytes).await.unwrap();
            let line = String::from_utf8_lossy(&bytes[..read])
                .lines()
                .next()
                .unwrap()
                .to_owned();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok")
                .await
                .unwrap();
            line
        });
        let gateway = tokio::spawn(serve(GatewayConfig::new(
            &gateway_socket,
            &raw_socket,
            None,
        )));
        for _ in 0..40 {
            if gateway_socket.exists() {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }
        let response = request(&gateway_socket, "GET /containers/api/logs?follow=false&stdout=true&stderr=true&since=0&until=1706000124&timestamps=true&tail=4096 HTTP/1.1\r\nHost: docker\r\n\r\n").await;
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert_eq!(upstream.await.unwrap(), "GET /containers/api/logs?follow=false&stdout=true&stderr=true&since=0&until=1706000124&timestamps=true&tail=4096 HTTP/1.1");
        gateway.abort();
        let _ = std::fs::remove_file(raw_socket);
        let _ = std::fs::remove_file(gateway_socket);
    }
}
