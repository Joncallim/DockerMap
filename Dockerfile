# syntax=docker/dockerfile:1

# ---- Rust daemon ----------------------------------------------------------
# These manifest-list digests fix the selected base-image identity while
# retaining the upstream images' supported platforms. They do not make the
# whole build byte-for-byte reproducible; see docs/release/SUPPLY_CHAIN.md.
FROM rust:1.88-slim-bookworm@sha256:38bc5a86d998772d4aec2348656ed21438d20fcdce2795b56ca434cf21430d89 AS rust-builder
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
COPY crates ./crates
COPY VERSION ./VERSION
COPY rust-toolchain.toml ./
RUN cargo build --release --manifest-path crates/Cargo.toml \
    -p dockermap-daemon -p dockermap-docker-gateway
RUN cargo build --release --manifest-path crates/Cargo.toml \
    -p dockermap-core --bin generate-contract-schemas

# ---- Node API + React web app ---------------------------------------------
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS js-builder
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY VERSION ./VERSION
COPY scripts/check-version-authority.mjs scripts/check-version-authority.mjs
COPY scripts/check-rust-contract-schemas.mjs scripts/generate-rust-contract-types.mjs scripts/generate-rust-contract-types.test.mjs ./scripts/
# The version checker validates every Rust package mirror too. These sources
# remain builder-only and never reach the runtime image.
COPY crates ./crates
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY tests/fixtures ./tests/fixtures
COPY --from=rust-builder /src/crates/target/release/generate-contract-schemas /usr/local/bin/generate-contract-schemas
# The single-container image serves the SPA and the API from the SAME origin
# (nginx proxies /api/* to the Node API on 4000), so the bundle must call
# relative /api/... URLs. The default in api.ts points at the user's
# localhost:4000, which never exists inside this container — an empty string
# is not nullish, so apiUrl() yields same-origin paths the proxy can serve.
ENV VITE_API_BASE_URL=""
ENV DOCKERMAP_CONTRACT_SCHEMA_GENERATOR=/usr/local/bin/generate-contract-schemas
RUN npm run check:version && npm run check:contracts && npm run build
# `@dockermap/contracts` is a real runtime dependency of the compiled API.
# Build and assert the entire package artifact, rather than relying on a
# source-tree module that happened to be copied into the image.
RUN test -f packages/contracts/dist/index.js && test -f packages/contracts/dist/nodeSchemas.js

# ---- Runtime image ----------------------------------------------------------
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends nginx procps curl \
    && rm -rf /var/lib/apt/lists/*

# The split deployment uses one shared non-root group for the filtered Unix
# socket.  The gateway receives the host Docker-socket GID as a supplemental
# group at runtime; neither frontend nor collector does.
RUN groupadd --gid 10003 dockermap && \
    useradd --uid 10001 --gid 10003 --create-home --home-dir /nonexistent --shell /usr/sbin/nologin dockermap-frontend && \
    useradd --uid 10002 --gid 10003 --create-home --home-dir /nonexistent --shell /usr/sbin/nologin dockermap-gateway && \
    useradd --uid 10003 --gid 10003 --create-home --home-dir /nonexistent --shell /usr/sbin/nologin dockermap-collector && \
    mkdir -p /run/dockermap && chown 10002:10003 /run/dockermap && chmod 0770 /run/dockermap

WORKDIR /opt/dockermap

COPY --from=js-builder /src/node_modules ./node_modules
# npm nests workspace deps in the lockfile layout (apps/api/node_modules/express
# etc.); the runtime image must mirror that layout or the API cannot resolve
# its deps.
COPY --from=js-builder /src/apps/api/node_modules ./apps/api/node_modules
COPY --from=js-builder /src/package.json ./package.json
COPY --from=js-builder /src/apps/api/dist ./apps/api/dist
COPY --from=js-builder /src/apps/api/package.json ./apps/api/package.json
COPY --from=js-builder /src/apps/web/dist ./apps/web/dist
COPY --from=js-builder /src/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=js-builder /src/packages/contracts/dist ./packages/contracts/dist
COPY --from=rust-builder /src/crates/target/release/dockermap-daemon /usr/local/bin/dockermap-daemon
COPY --from=rust-builder /src/crates/target/release/dockermap-docker-gateway /usr/local/bin/dockermap-docker-gateway

COPY deploy/docker/nginx.conf /etc/nginx/sites-enabled/default
COPY deploy/docker/nginx-main.conf /etc/nginx/nginx.conf
COPY deploy/docker/entrypoint.sh /entrypoint.sh
COPY deploy/docker/frontend-entrypoint.sh /frontend-entrypoint.sh
COPY deploy/docker/healthcheck.sh /usr/local/bin/dockermap-healthcheck
RUN chmod +x /entrypoint.sh /frontend-entrypoint.sh /usr/local/bin/dockermap-healthcheck

ENV NODE_ENV=production \
    PORT=4000 \
    DOCKERMAP_DAEMON_HOST=127.0.0.1 \
    DOCKERMAP_DAEMON_PORT=4100 \
    DOCKERMAP_DAEMON_URL=http://127.0.0.1:4100 \
    DOCKERMAP_PROJECT_ROOT=/opt/dockermap/project \
    DOCKERMAP_ALLOWED_ORIGINS=http://127.0.0.1:3233,http://localhost:3233

EXPOSE 3233

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["/usr/local/bin/dockermap-healthcheck"]

ENTRYPOINT ["/entrypoint.sh"]
