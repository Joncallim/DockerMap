//! Read-only TCP listener discovery from the fixed kernel proc tables.
//!
//! This provider reads only `/proc/net/tcp` and `/proc/net/tcp6`, and is
//! invoked only after the daemon has established that it has host PID
//! visibility. It does not inspect process file descriptors or perform any
//! network I/O.

use crate::push_provider_diagnostic;
use dockermap_core::{
    collision_resistant_id_component, DiagnosticSeverity, RuntimeMapDiagnostic, RuntimeMapNode,
    RuntimeNodeKind, RuntimeNodeLayer, RuntimeProviderKind,
};
use std::{collections::BTreeMap, fs};

const PROC_TCP_TABLES: [&str; 2] = ["/proc/net/tcp", "/proc/net/tcp6"];

pub(crate) fn collect_network_listeners(
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    for path in PROC_TCP_TABLES {
        let Ok(content) = read_proc_listener_table(path) else {
            push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Network,
                DiagnosticSeverity::Info,
                format!("network listener discovery skipped for {path}"),
            );
            continue;
        };
        for line in content.lines().skip(1) {
            let Some((address, port, socket_inode)) = parse_proc_net_listener_line(line) else {
                continue;
            };
            let mut metadata = BTreeMap::new();
            metadata.insert("address".into(), address.clone());
            metadata.insert("port".into(), port.to_string());
            metadata.insert("socketInode".into(), socket_inode);
            nodes.push(RuntimeMapNode {
                id: format!(
                    "network_listener_{}_{}",
                    collision_resistant_id_component(&address),
                    port
                ),
                provider: RuntimeProviderKind::Network,
                kind: RuntimeNodeKind::NetworkListener,
                label: format!("{address}:{port}"),
                status: Some("listening".into()),
                layer: Some(RuntimeNodeLayer::Host),
                metadata,
                service: None,
                package: None,
            });
        }
    }
}

/// The paths are fixed in `PROC_TCP_TABLES`; callers cannot supply a proc
/// location. Keeping this narrow helper here makes the provider's complete
/// filesystem authority explicit.
fn read_proc_listener_table(path: &str) -> std::io::Result<String> {
    fs::read_to_string(path)
}

/// Parse one `/proc/net/tcp` (or tcp6) line into `(address, port, inode)` for
/// a LISTEN-state socket; returns `None` for anything else.
fn parse_proc_net_listener_line(line: &str) -> Option<(String, u16, String)> {
    let fields = line.split_whitespace().collect::<Vec<_>>();
    if fields.len() < 10 || fields[3] != "0A" {
        return None;
    }
    let (address, port) = parse_proc_net_local_address(fields[1])?;
    Some((address, port, fields[9].to_string()))
}

fn parse_proc_net_local_address(value: &str) -> Option<(String, u16)> {
    let (raw_address, raw_port) = value.split_once(':')?;
    let port = u16::from_str_radix(raw_port, 16).ok()?;
    let address = if raw_address.len() == 8 {
        let bytes = (0..4)
            .filter_map(|index| u8::from_str_radix(&raw_address[index * 2..index * 2 + 2], 16).ok())
            .collect::<Vec<_>>();
        if bytes.len() != 4 {
            return None;
        }
        format!("{}.{}.{}.{}", bytes[3], bytes[2], bytes[1], bytes[0])
    } else {
        raw_address.to_ascii_lowercase()
    };
    Some((address, port))
}

#[cfg(test)]
mod tests {
    use super::parse_proc_net_listener_line;

    #[test]
    fn parses_proc_net_tcp_listener_fixture() {
        let fixture =
            include_str!("../../../../tests/fixtures/providers/parser/listeners-proc-net-tcp.txt");
        let listeners = fixture
            .lines()
            .skip(1)
            .filter_map(parse_proc_net_listener_line)
            .collect::<Vec<_>>();

        assert_eq!(listeners.len(), 3);
        assert_eq!(listeners[0].0, "127.0.0.1");
        assert_eq!(listeners[0].1, 8080);
        assert_eq!(listeners[0].2, "12345");
        assert_eq!(listeners[1].0, "0.0.0.0");
        assert_eq!(listeners[1].1, 3000);
        assert_eq!(listeners[2].0, "127.0.0.1");
        assert_eq!(listeners[2].1, 4096);
        assert_eq!(listeners[2].2, "34567");
    }
}
