# Reverse Proxy And Review UI Notes

DockerMap is safest when it only listens on the local machine. A reverse proxy can make
it reachable from a browser on another computer, but that also turns local Docker and
Compose information into remote information. Treat that as a deliberate review setup,
not a casual default.

## Plain-English Rule

Keep the Rust daemon private. If you need remote review access, expose only the Node API
and static web app through a reverse proxy. The proxy should control who can see the UI,
and it should add the DockerMap API token when it talks to the local Node API.

Reverse-proxy authentication tools, SSO providers, VPNs, DNS providers, and TLS
automation may contact their own services. DockerMap does not manage those calls; it
only receives the proxy request and, by default, talks back to the local Node API and
Rust daemon.

## Recommended Review Setup

1. Keep the Rust daemon on loopback:

   ```bash
   DOCKERMAP_DAEMON_HOST=127.0.0.1
   ```

2. Keep the Node API on loopback:

   ```text
   http://127.0.0.1:4000
   ```

3. Set a long API token for the Node API:

   ```bash
   DOCKERMAP_API_TOKEN="replace-with-a-long-random-value"
   ```

4. Build the web app for the same public origin as the proxy:

   ```bash
   VITE_API_BASE_URL="" npm run build --workspace @dockermap/web
   ```

5. Serve `apps/web/dist` from the proxy.

6. Proxy `/api/*` and `/health` to `http://127.0.0.1:4000`.

7. Protect the public site with something humans can use, such as SSO, basic auth, a VPN,
   or an IP allowlist.

Important: if the proxy injects the DockerMap bearer token but does not authenticate
viewers, the API is effectively public. The proxy must protect the human-facing route.

## Nginx Shape

This is a starting point, not a complete production config.
There is also a deployable template at `deploy/nginx/dockermap.conf`.

```nginx
server {
  listen 443 ssl;
  server_name dockermap.example.com;

  root /srv/dockermap/apps/web/dist;
  index index.html;

  # Add your real viewer protection here:
  # auth_basic "DockerMap review";
  # auth_basic_user_file /etc/nginx/dockermap.htpasswd;

  location / {
    try_files $uri /index.html;
  }

  location /api/ {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Authorization "Bearer replace-with-the-same-token";
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
    proxy_set_header Host $host;
    proxy_set_header Authorization "Bearer replace-with-the-same-token";
    proxy_read_timeout 1h;
  }
}
```

## Required Negative Checks

Before release, verify these failures deliberately:

- Direct remote access to the daemon port fails.
- Direct remote access to the Node API without the proxy-injected token returns `401` for non-health routes.
- A browser origin not listed in `DOCKERMAP_ALLOWED_ORIGINS` does not receive an `Access-Control-Allow-Origin` header.
- The proxy requires viewer authentication before it injects the DockerMap bearer token.

## Smoke Test

After the proxy is up, check these from a browser or from `curl`:

- `/api/health` returns JSON without needing a bearer token.
- `/api/snapshot` works through the proxy.
- `/api/compose/scan` shows Compose files and mount checks.
- `/api/events/stream` stays connected for live updates.
- Direct access to `127.0.0.1:4100` is not possible from outside the host.

## Do Not Do This

- Do not publish the Rust daemon directly to the internet.
- Do not use `DOCKERMAP_ALLOWED_ORIGINS=*`; the API rejects wildcard origins.
- Do not rely on CORS as authentication. CORS is a browser rule, not a login system.
- Do not add write endpoints before DockerMap has backups, previews, confirmation, and
  rollback guidance.
