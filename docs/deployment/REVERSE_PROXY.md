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

## Authentik Forward-Auth (Deployable Nginx Example)

Use this mode when Authentik, rather than DockerMap, authenticates viewers. In
DockerMap's protected env file set:

```dotenv
DOCKERMAP_AUTH_REQUIRED=true
DOCKERMAP_AUTH_USER_HEADER=x-remote-user
DOCKERMAP_AUTH_NAME_HEADER=x-remote-name
DOCKERMAP_AUTH_EMAIL_HEADER=x-remote-email
DOCKERMAP_AUTH_GROUPS_HEADER=x-remote-groups
```

Create an Authentik **Proxy Provider** and application for the DockerMap public
origin, attach it to an outpost, and replace `authentik:9000` below with that
outpost's reachable service. This Nginx server is a complete shape for a host
that serves the built web files and keeps DockerMap's Node API on loopback:

```nginx
server {
  listen 443 ssl http2;
  server_name dockermap.example.com;

  # Configure real certificates for this public origin.
  ssl_certificate /etc/letsencrypt/live/dockermap.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/dockermap.example.com/privkey.pem;
  root /srv/dockermap/apps/web/dist;
  index index.html;

  # Authentik proxy outpost endpoint. Do not protect its own callback paths.
  location /outpost.goauthentik.io {
    auth_request off;
    proxy_pass http://authentik:9000/outpost.goauthentik.io;
    proxy_set_header Host $host;
    proxy_set_header X-Original-URL $scheme://$http_host$request_uri;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
  }

  location @authentik_signin {
    internal;
    add_header Set-Cookie $authentik_cookie;
    return 302 /outpost.goauthentik.io/start?rd=$scheme://$http_host$request_uri;
  }

  # Repeated in each public location so every browser/API route, including
  # /health, requires Authentik before DockerMap sees it.
  location / {
    auth_request /outpost.goauthentik.io/auth/nginx;
    error_page 401 = @authentik_signin;
    auth_request_set $authentik_cookie $upstream_http_set_cookie;
    add_header Set-Cookie $authentik_cookie;
    try_files $uri /index.html;
  }

  location /api/events/stream {
    auth_request /outpost.goauthentik.io/auth/nginx;
    error_page 401 = @authentik_signin;
    auth_request_set $authentik_cookie $upstream_http_set_cookie;
    auth_request_set $authentik_username $upstream_http_x_authentik_username;
    auth_request_set $authentik_name $upstream_http_x_authentik_name;
    auth_request_set $authentik_email $upstream_http_x_authentik_email;
    auth_request_set $authentik_groups $upstream_http_x_authentik_groups;
    add_header Set-Cookie $authentik_cookie;
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Remote-User $authentik_username;
    proxy_set_header X-Remote-Name $authentik_name;
    proxy_set_header X-Remote-Email $authentik_email;
    proxy_set_header X-Remote-Groups $authentik_groups;
  }

  location /api/ {
    auth_request /outpost.goauthentik.io/auth/nginx;
    error_page 401 = @authentik_signin;
    auth_request_set $authentik_cookie $upstream_http_set_cookie;
    auth_request_set $authentik_username $upstream_http_x_authentik_username;
    auth_request_set $authentik_name $upstream_http_x_authentik_name;
    auth_request_set $authentik_email $upstream_http_x_authentik_email;
    auth_request_set $authentik_groups $upstream_http_x_authentik_groups;
    add_header Set-Cookie $authentik_cookie;
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Override, do not append, client-supplied identity headers.
    proxy_set_header X-Remote-User $authentik_username;
    proxy_set_header X-Remote-Name $authentik_name;
    proxy_set_header X-Remote-Email $authentik_email;
    proxy_set_header X-Remote-Groups $authentik_groups;
  }

  location = /health {
    auth_request /outpost.goauthentik.io/auth/nginx;
    error_page 401 = @authentik_signin;
    auth_request_set $authentik_cookie $upstream_http_set_cookie;
    auth_request_set $authentik_username $upstream_http_x_authentik_username;
    add_header Set-Cookie $authentik_cookie;
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header X-Remote-User $authentik_username;
  }
}
```

**Trust boundary:** DockerMap treats those four `X-Remote-*` headers as proof
of identity only because its Node API is bound to `127.0.0.1` and this proxy
overwrites each header after a successful Authentik subrequest. Never expose
port `4000`, route around this proxy, or pass client-provided identity headers
through unchanged. The container's own healthcheck is an internal loopback
request and supplies the configured user-header itself; that does not make the
public `/health` route unauthenticated.

## Required Negative Checks

Before release, verify these failures deliberately:

- Direct remote access to the daemon port fails.
- Direct remote access to the Node API without a bearer token or trusted forward-auth identity returns `401` for **every API route, including `/health`**.
- A browser origin not listed in `DOCKERMAP_ALLOWED_ORIGINS` does not receive an `Access-Control-Allow-Origin` header.
- The proxy requires viewer authentication before it injects a bearer token or trusted forward-auth identity.

## Smoke Test

After the proxy is up, check these from a browser or from `curl`:

- `/health` returns JSON through the proxy after viewer authentication (or its configured proxy-injected credential/identity).
- Direct unauthenticated access to the Node API's `/health` returns `401` in bearer or forward-auth mode; only unauthenticated mode permits it without credentials.
- `/api/snapshot` works through the proxy.
- `/api/runtime/map` works through the proxy.
- `/api/compose/scan` shows Compose files and mount checks.
- `/api/events/stream` stays connected for live updates.
- Direct access to `127.0.0.1:4100` is not possible from outside the host.

`scripts/smoke-deploy.sh` can cover the route checks above. When you export
`DOCKERMAP_API_TOKEN`, it also verifies that direct browser API access
returns `401` without the bearer token before retrying the protected routes
with auth.

## Do Not Do This

- Do not publish the Rust daemon directly to the internet.
- Do not use `DOCKERMAP_ALLOWED_ORIGINS=*`; the API rejects wildcard origins.
- Do not rely on CORS as authentication. CORS is a browser rule, not a login system.
- Do not add write endpoints before DockerMap has backups, previews, confirmation, and
  rollback guidance.
