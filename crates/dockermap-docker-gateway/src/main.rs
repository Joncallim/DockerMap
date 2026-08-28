use std::env;

use dockermap_docker_gateway::{serve, GatewayConfig};

const DEFAULT_LISTEN_SOCKET: &str = "/run/dockermap/docker-read.sock";
const DEFAULT_DOCKER_SOCKET: &str = "/var/run/docker.sock";

#[tokio::main]
async fn main() {
    let config = GatewayConfig::new(
        env::var("DOCKERMAP_DOCKER_GATEWAY_SOCKET")
            .unwrap_or_else(|_| DEFAULT_LISTEN_SOCKET.into()),
        env::var("DOCKERMAP_RAW_DOCKER_SOCKET").unwrap_or_else(|_| DEFAULT_DOCKER_SOCKET.into()),
        env::var("DOCKERMAP_DOCKER_LABEL_FILTER")
            .ok()
            .filter(|value| !value.is_empty()),
    );
    if let Err(error) = serve(config).await {
        eprintln!("Docker Read Gateway stopped: {error}");
        std::process::exit(1);
    }
}
