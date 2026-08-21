#!/bin/sh
set -eu

# Read the token at runtime so Docker inspect never contains a credential in
# the healthcheck command. Bearer mode protects /health; unauthenticated mode
# intentionally remains usable without a header.
if [ -n "${DOCKERMAP_API_TOKEN:-}" ]; then
  exec curl --fail --silent --show-error --max-time 5 \
    --header "Authorization: Bearer ${DOCKERMAP_API_TOKEN}" \
    http://127.0.0.1:3233/health >/dev/null
fi

exec curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3233/health >/dev/null
