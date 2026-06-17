# Reverse Proxy And Nginx Notes

DockerMap is local-first. Exposing it through nginx, Caddy, Traefik, SSH tunnels, remote dev boxes, or corporate gateways should be an explicit operator decision.

## Baseline Rules

- Keep `dockermap-daemon` bound to `127.0.0.1`.
- Keep `apps/api` bound to `127.0.0.1` unless a reverse proxy is deliberately fronting it.
- Do not expose DockerMap beyond localhost without authentication at the proxy or a future app auth layer.
- Do not blindly trust `X-Forwarded-*` headers.
- Keep CORS origins explicit with `DOCKERMAP_ALLOWED_ORIGINS`.
- Let the TLS-owning proxy decide whether to set HSTS.

## Nginx Considerations

- Disable response buffering for SSE routes such as `/api/events/stream`.
- Set bounded request body and header limits.
- Set upstream connection, send, and read timeouts.
- Preserve or intentionally strip path prefixes; DockerMap should be smoke-tested when mounted below a prefix such as `/dockermap`.
- Ensure forwarded headers are overwritten by nginx, not passed through from clients.

## Example Shape

```nginx
location /api/ {
  proxy_pass http://127.0.0.1:4000;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  client_max_body_size 32k;
  proxy_connect_timeout 5s;
  proxy_send_timeout 15s;
  proxy_read_timeout 30s;
}

location /api/events/stream {
  proxy_pass http://127.0.0.1:4000;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_cache off;
  proxy_read_timeout 1h;
}
```

This is guidance, not a production authentication model. Before remote exposure, add authentication and run a proxied smoke test for health, snapshot, Compose scan, Compose graph, edit-plan, and SSE disconnect behavior.
