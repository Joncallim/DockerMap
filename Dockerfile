# syntax=docker/dockerfile:1

# ---- Rust daemon ----------------------------------------------------------
FROM rust:1.88-slim-bookworm AS rust-builder
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
COPY crates ./crates
COPY rust-toolchain.toml ./
RUN cargo build --release --manifest-path crates/Cargo.toml -p dockermap-daemon

# ---- Node API + React web app ---------------------------------------------
FROM node:22-bookworm-slim AS js-builder
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm run build

# ---- Runtime image ----------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends nginx \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/dockermap

COPY --from=js-builder /src/node_modules ./node_modules
COPY --from=js-builder /src/package.json ./package.json
COPY --from=js-builder /src/apps/api/dist ./apps/api/dist
COPY --from=js-builder /src/apps/api/package.json ./apps/api/package.json
COPY --from=js-builder /src/apps/web/dist ./apps/web/dist
COPY --from=js-builder /src/packages/contracts ./packages/contracts
COPY --from=rust-builder /src/crates/target/release/dockermap-daemon /usr/local/bin/dockermap-daemon

COPY deploy/docker/nginx.conf /etc/nginx/sites-enabled/default
COPY deploy/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production \
    PORT=4000 \
    DOCKERMAP_DAEMON_HOST=127.0.0.1 \
    DOCKERMAP_DAEMON_PORT=4100 \
    DOCKERMAP_DAEMON_URL=http://127.0.0.1:4100 \
    DOCKERMAP_PROJECT_ROOT=/opt/dockermap/project \
    DOCKERMAP_ALLOWED_ORIGINS=http://127.0.0.1:3233,http://localhost:3233

EXPOSE 3233

ENTRYPOINT ["/entrypoint.sh"]
