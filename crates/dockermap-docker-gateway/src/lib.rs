//! Default-deny Docker Read Gateway.
//!
//! The gateway deliberately has a fixed, measured Docker read contract.  It
//! validates an origin-form target before it ever opens the raw Docker socket,
//! then forwards a newly-built request over that socket.  It is not a generic
//! Docker proxy.

use std::{
    collections::{BTreeMap, BTreeSet},
    fmt, io,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use http::{header, Method, Request, Response, StatusCode};
use http_body_util::{BodyExt, Full};
use hyper::{
    body::Incoming, client::conn::http1, server::conn::http1 as server_http1, service::service_fn,
};
use hyper_util::rt::TokioIo;
use serde::de::{self, MapAccess, Visitor};
use tokio::net::{UnixListener, UnixStream};

pub const LOG_TAIL: &str = "4096";
/// Event replay and live-tail starts may inspect at most this recent window.
pub const EVENT_MAX_LOOKBACK_SECONDS: u64 = 300;

const EVENT_MAX_QUERY_BYTES: usize = 2_048;
const EVENT_ACTIONS: [&str; 7] = [
    "create",
    "start",
    "stop",
    "die",
    "restart",
    "destroy",
    "health_status",
];

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
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Deny::Query)?
            .as_secs();
        self.allow_at(request, now)
    }

    fn allow_at<B>(&self, request: &Request<B>, now: u64) -> Result<String, Deny> {
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
            "/events" => self.events(target, query, now),
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

    fn events(&self, target: &str, query: &str, now: u64) -> Result<String, Deny> {
        if query.is_empty() || query.len() > EVENT_MAX_QUERY_BYTES || !valid_percent_encoding(query)
        {
            return Err(Deny::Query);
        }

        let mut since = None;
        let mut until = None;
        let mut filters = None;
        for pair in query.split('&') {
            let (key, value) = pair.split_once('=').ok_or(Deny::Query)?;
            match key {
                "since" if since.is_none() => since = Some(parse_timestamp(value)?),
                "until" if until.is_none() => until = Some(parse_timestamp(value)?),
                "filters" if filters.is_none() => filters = Some(decode_filters(value)?),
                "since" | "until" | "filters" => return Err(Deny::Query),
                _ => return Err(Deny::Query),
            }
        }

        let since = since.ok_or(Deny::Query)?;
        if since > now || now - since > EVENT_MAX_LOOKBACK_SECONDS {
            return Err(Deny::Query);
        }
        if let Some(until) = until {
            // A finite replay cannot turn into an arbitrarily long live wait.
            if until < since || until > now || until - since > EVENT_MAX_LOOKBACK_SECONDS {
                return Err(Deny::Query);
            }
        }

        self.validate_event_filters(filters.ok_or(Deny::Query)?)?;
        Ok(target.into())
    }

    fn validate_event_filters(&self, mut filters: UniqueFilterMap) -> Result<(), Deny> {
        let types = filters.0.remove("type").ok_or(Deny::Query)?;
        if types.as_slice() != ["container"] {
            return Err(Deny::Query);
        }

        let actions = filters.0.remove("event").ok_or(Deny::Query)?;
        if actions.len() != EVENT_ACTIONS.len() {
            return Err(Deny::Query);
        }
        let action_set: BTreeSet<&str> = actions.iter().map(String::as_str).collect();
        if action_set.len() != EVENT_ACTIONS.len()
            || !EVENT_ACTIONS
                .iter()
                .all(|action| action_set.contains(action))
        {
            return Err(Deny::Query);
        }

        match &self.label_filter {
            Some(expected) => {
                let labels = filters.0.remove("label").ok_or(Deny::Query)?;
                if labels.len() != 1 || labels[0] != *expected {
                    return Err(Deny::Query);
                }
            }
            None if filters.0.contains_key("label") => return Err(Deny::Query),
            None => {}
        }

        if filters.0.is_empty() {
            Ok(())
        } else {
            Err(Deny::Query)
        }
    }
}

#[derive(Debug)]
struct UniqueFilterMap(BTreeMap<String, Vec<String>>);

impl<'de> serde::Deserialize<'de> for UniqueFilterMap {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct UniqueFilterVisitor;

        impl<'de> Visitor<'de> for UniqueFilterVisitor {
            type Value = UniqueFilterMap;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an event filter object with unique string-array keys")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut values = BTreeMap::new();
                while let Some((key, value)) = map.next_entry::<String, Vec<String>>()? {
                    if values.insert(key.clone(), value).is_some() {
                        return Err(de::Error::custom(format!(
                            "duplicate event filter key: {key}"
                        )));
                    }
                }
                Ok(UniqueFilterMap(values))
            }
        }

        deserializer.deserialize_map(UniqueFilterVisitor)
    }
}

fn parse_timestamp(value: &str) -> Result<u64, Deny> {
    if value.is_empty()
        || value.len() > 20
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err(Deny::Query);
    }
    value.parse().map_err(|_| Deny::Query)
}

fn decode_filters(value: &str) -> Result<UniqueFilterMap, Deny> {
    if value.is_empty() {
        return Err(Deny::Query);
    }
    let encoded = format!("filters={value}");
    let mut pairs = url::form_urlencoded::parse(encoded.as_bytes());
    let (key, decoded) = pairs.next().ok_or(Deny::Query)?;
    if key != "filters" || pairs.next().is_some() {
        return Err(Deny::Query);
    }
    serde_json::from_str(&decoded).map_err(|_| Deny::Query)
}

fn valid_percent_encoding(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit()
            {
                return false;
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    true
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
    use bollard::{query_parameters::EventsOptionsBuilder, Docker, API_DEFAULT_VERSION};
    use futures_util::StreamExt;
    use std::{
        collections::HashMap,
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

    fn encoded(json: &str) -> String {
        url::form_urlencoded::byte_serialize(json.as_bytes()).collect()
    }

    fn event_filters(label: Option<&str>) -> String {
        let label = label
            .map(|value| format!(r#","label":[{}]"#, serde_json::to_string(value).unwrap()))
            .unwrap_or_default();
        format!(
            r#"{{"type":["container"],"event":["create","start","stop","die","restart","destroy","health_status"]{label}}}"#
        )
    }

    fn event_target(since: u64, until: Option<u64>, filters: &str) -> String {
        match until {
            Some(until) => format!(
                "/events?since={since}&until={until}&filters={}",
                encoded(filters)
            ),
            None => format!("/events?since={since}&filters={}", encoded(filters)),
        }
    }

    #[test]
    fn only_measured_unfiltered_requests_pass() {
        let policy = Policy::new(None);
        for target in ["/containers/json?all=true&size=false", "/networks?", "/volumes?", "/containers/api/logs?follow=false&stdout=true&stderr=true&since=0&until=0&timestamps=true&tail=4096"] { assert!(policy.allow(&req(target)).is_ok(), "{target}"); }
        for target in ["/containers/json?all=true", "/events", "/v1.44/containers/json?all=true&size=false", "/containers/api/json", "/containers/api/logs?follow=true&stdout=true&stderr=true&since=0&until=0&timestamps=true&tail=4096", "/containers/api/logs?follow=false&stdout=true&stderr=true&since=0&until=0&timestamps=true&tail=4097"] { assert!(policy.allow(&req(target)).is_err(), "{target}"); }
    }

    #[test]
    fn events_allow_only_recent_live_or_finite_replay_with_the_closed_filter_set() {
        let now = 1_800_000_000;
        let filters = event_filters(None);
        let live = event_target(now - 30, None, &filters);
        let replay = event_target(now - EVENT_MAX_LOOKBACK_SECONDS, Some(now), &filters);
        let policy = Policy::new(None);

        assert_eq!(policy.allow_at(&req(&live), now), Ok(live));
        assert_eq!(policy.allow_at(&req(&replay), now), Ok(replay));

        let configured_filters = event_filters(Some("com.dockermap.fixture=trace-123"));
        let configured = event_target(now - 30, None, &configured_filters);
        assert_eq!(
            Policy::new(Some("com.dockermap.fixture=trace-123".into()))
                .allow_at(&req(&configured), now),
            Ok(configured)
        );
        assert_eq!(
            Policy::new(Some("com.dockermap.fixture=other".into())).allow_at(
                &req(&event_target(now - 30, None, &configured_filters)),
                now
            ),
            Err(Deny::Query)
        );
        assert_eq!(
            Policy::new(Some("com.dockermap.fixture=trace-123".into()))
                .allow_at(&req(&event_target(now - 30, None, &filters)), now),
            Err(Deny::Query)
        );
        assert_eq!(
            policy.allow_at(
                &req(&event_target(now - 30, None, &configured_filters)),
                now
            ),
            Err(Deny::Query)
        );
    }

    #[test]
    fn event_filter_and_query_order_are_semantic_only_after_closed_validation() {
        let now = 1_800_000_000;
        let filters = r#"{"event":["health_status","destroy","restart","die","stop","start","create"],"type":["container"]}"#;
        let target = format!(
            "/events?filters={}&since={}&until={}",
            encoded(filters),
            now - 10,
            now
        );
        assert_eq!(Policy::new(None).allow_at(&req(&target), now), Ok(target));
    }

    #[test]
    fn hostile_event_queries_fail_closed() {
        let now = 1_800_000_000;
        let valid = encoded(&event_filters(None));
        let missing_type = encoded(
            r#"{"event":["create","start","stop","die","restart","destroy","health_status"]}"#,
        );
        let missing_event = encoded(r#"{"type":["container"]}"#);
        let action_subset = encoded(r#"{"type":["container"],"event":["start"]}"#);
        let duplicate_action = encoded(
            r#"{"type":["container"],"event":["create","start","stop","die","restart","destroy","destroy"]}"#,
        );
        let unknown_action = encoded(
            r#"{"type":["container"],"event":["create","start","stop","die","restart","destroy","exec_start"]}"#,
        );
        let wrong_type = encoded(
            r#"{"type":["image"],"event":["create","start","stop","die","restart","destroy","health_status"]}"#,
        );
        let extra_filter = encoded(
            r#"{"type":["container"],"event":["create","start","stop","die","restart","destroy","health_status"],"container":["victim"]}"#,
        );
        let duplicate_json_key = encoded(
            r#"{"type":["container"],"type":["container"],"event":["create","start","stop","die","restart","destroy","health_status"]}"#,
        );
        let policy = Policy::new(None);
        let targets = vec![
            "/events".to_owned(),
            "/events?".to_owned(),
            format!("/events?filters={valid}"),
            format!("/events?since={}", now - 10),
            format!("/events?since={}&filters={valid}&filters={valid}", now - 10),
            format!(
                "/events?since={}&since={}&filters={valid}",
                now - 10,
                now - 9
            ),
            format!("/events?since={}&filters={valid}&unknown=1", now - 10),
            format!("/events?since={}&filters=%GG", now - 10),
            format!("/events?since={}&filters=%7B", now - 10),
            format!("/events?since={}&filters={missing_type}", now - 10),
            format!("/events?since={}&filters={missing_event}", now - 10),
            format!("/events?since={}&filters={action_subset}", now - 10),
            format!("/events?since={}&filters={duplicate_action}", now - 10),
            format!("/events?since={}&filters={unknown_action}", now - 10),
            format!("/events?since={}&filters={wrong_type}", now - 10),
            format!("/events?since={}&filters={extra_filter}", now - 10),
            format!("/events?since={}&filters={duplicate_json_key}", now - 10),
            format!("/events?since=&filters={valid}"),
            format!("/events?since=-1&filters={valid}"),
            format!("/events?since=1.5&filters={valid}"),
            format!("/events?since=01799999990&filters={valid}"),
            format!("/events?since=18446744073709551616&filters={valid}"),
            format!(
                "/events?since={}&filters={valid}",
                now - EVENT_MAX_LOOKBACK_SECONDS - 1
            ),
            format!("/events?since={}&filters={valid}", now + 1),
            format!(
                "/events?since={}&until={}&filters={valid}",
                now - 5,
                now - 6
            ),
            format!(
                "/events?since={}&until={}&filters={valid}",
                now - 5,
                now + 1
            ),
            format!(
                "/events?since={}&until={}&filters={valid}",
                now - EVENT_MAX_LOOKBACK_SECONDS - 1,
                now
            ),
            format!(
                "/events?since={}&filters={}",
                now - 10,
                "x".repeat(EVENT_MAX_QUERY_BYTES)
            ),
            format!("/v1.44/events?since={}&filters={valid}", now - 10),
            format!("/events/?since={}&filters={valid}", now - 10),
            format!("/%65vents?since={}&filters={valid}", now - 10),
            format!("/events%2f?since={}&filters={valid}", now - 10),
            format!(
                "/events/../containers/json?since={}&filters={valid}",
                now - 10
            ),
        ];
        for target in targets {
            assert!(policy.allow_at(&req(&target), now).is_err(), "{target}");
        }
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
    async fn bollard_0_19_event_request_shape_is_accepted_without_json_key_order_assumptions() {
        let raw_socket = socket("bollard-events");
        let listener = UnixListener::bind(&raw_socket).unwrap();
        let capture = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut bytes = [0; 1_024];
            loop {
                let read = stream.read(&mut bytes).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&bytes[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
                assert!(request.len() <= 8_192);
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n")
                .await
                .unwrap();
            String::from_utf8(request)
                .unwrap()
                .lines()
                .next()
                .unwrap()
                .to_owned()
        });

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let label = "com.dockermap.fixture=trace-123";
        let mut filters = HashMap::<String, Vec<String>>::new();
        filters.insert("type".into(), vec!["container".into()]);
        filters.insert(
            "event".into(),
            EVENT_ACTIONS
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
        );
        filters.insert("label".into(), vec![label.into()]);
        let options = EventsOptionsBuilder::new()
            .since(&(now - 30).to_string())
            .until(&now.to_string())
            .filters(&filters)
            .build();
        let docker =
            Docker::connect_with_unix(raw_socket.to_str().unwrap(), 5, API_DEFAULT_VERSION)
                .unwrap();
        let mut stream = Box::pin(docker.events(Some(options)));
        tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .expect("Bollard event request completes against the stub");

        let line = capture.await.unwrap();
        let target = line
            .strip_prefix("GET ")
            .and_then(|value| value.strip_suffix(" HTTP/1.1"))
            .expect("Bollard uses an HTTP/1.1 GET origin-form target");
        assert!(
            target.starts_with(&format!("/events?since={}&until={now}&filters=", now - 30)),
            "{line}"
        );
        assert_eq!(
            Policy::new(Some(label.into())).allow_at(&req(target), now),
            Ok(target.to_owned())
        );
        let _ = std::fs::remove_file(raw_socket);
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
    async fn hostile_event_requests_never_reach_the_raw_docker_socket() {
        let raw_socket = socket("raw-denied-events");
        let gateway_socket = socket("filtered-denied-events");
        let upstream_hits = Arc::new(AtomicUsize::new(0));
        let listener = UnixListener::bind(&raw_socket).unwrap();
        let hits = Arc::clone(&upstream_hits);
        let upstream = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                hits.fetch_add(1, Ordering::SeqCst);
                let mut bytes = [0; 2_048];
                let _ = stream.read(&mut bytes).await.unwrap();
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok")
                    .await
                    .unwrap();
            }
        });
        let label = "com.dockermap.fixture=trace-123";
        let gateway = tokio::spawn(serve(GatewayConfig::new(
            &gateway_socket,
            &raw_socket,
            Some(label.into()),
        )));
        for _ in 0..40 {
            if gateway_socket.exists() {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let valid = encoded(&event_filters(Some(label)));
        let unscoped = encoded(&event_filters(None));
        let subset = encoded(
            r#"{"type":["container"],"event":["start"],"label":["com.dockermap.fixture=trace-123"]}"#,
        );
        let unrelated = encoded(
            r#"{"type":["container"],"event":["create","start","stop","die","restart","destroy","health_status"],"label":["com.dockermap.fixture=trace-123"],"image":["private"]}"#,
        );
        let requests = vec![
            format!("GET /events?since={} HTTP/1.1\r\nHost: docker\r\n\r\n", now - 1),
            format!(
                "GET /events?since={}&filters={subset} HTTP/1.1\r\nHost: docker\r\n\r\n",
                now - 1
            ),
            format!(
                "GET /events?since={}&filters={unscoped} HTTP/1.1\r\nHost: docker\r\n\r\n",
                now - 1
            ),
            format!(
                "GET /events?since={}&filters={unrelated} HTTP/1.1\r\nHost: docker\r\n\r\n",
                now - 1
            ),
            format!(
                "GET /events?since={}&filters={valid}&filters={valid} HTTP/1.1\r\nHost: docker\r\n\r\n",
                now - 1
            ),
            format!(
                "GET /v1.44/events?since={}&filters={valid} HTTP/1.1\r\nHost: docker\r\n\r\n",
                now - 1
            ),
            format!(
                "GET /events?since={}&filters={valid} HTTP/1.1\r\nHost: docker\r\nContent-Length: 1\r\n\r\nx",
                now - 1
            ),
            format!(
                "GET /events?since={}&filters={valid} HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
                now - 1
            ),
        ];
        for raw in requests {
            assert!(
                !request(&gateway_socket, &raw)
                    .await
                    .starts_with("HTTP/1.1 200"),
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

    #[tokio::test]
    async fn exact_safe_event_request_is_forwarded_verbatim_to_the_raw_socket() {
        let raw_socket = socket("raw-events-allowed");
        let gateway_socket = socket("filtered-events-allowed");
        let listener = UnixListener::bind(&raw_socket).unwrap();
        let upstream = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 2_048];
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

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let target = event_target(now - 1, Some(now), &event_filters(None));
        let raw = format!("GET {target} HTTP/1.1\r\nHost: docker\r\n\r\n");
        let response = request(&gateway_socket, &raw).await;
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert_eq!(upstream.await.unwrap(), format!("GET {target} HTTP/1.1"));
        gateway.abort();
        let _ = std::fs::remove_file(raw_socket);
        let _ = std::fs::remove_file(gateway_socket);
    }
}
