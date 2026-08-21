#!/bin/sh
set -eu

# Read the token at runtime so Docker inspect never contains a credential in
# the healthcheck command. Forward-auth calls the loopback API directly so it
# can provide the fixed internal identity without relying on nginx.
if [ "${DOCKERMAP_AUTH_REQUIRED:-}" = "true" ]; then
  header="${DOCKERMAP_AUTH_USER_HEADER:-x-remote-user}"
  exec curl --fail --silent --show-error --max-time 5 \
    --header "${header}: dockermap-healthcheck" \
    http://127.0.0.1:4000/health >/dev/null
fi

# Bearer mode protects /health; unauthenticated mode remains usable without a
# header.
if [ -n "${DOCKERMAP_API_TOKEN:-}" ]; then
  exec curl --fail --silent --show-error --max-time 5 \
    --header "Authorization: Bearer ${DOCKERMAP_API_TOKEN}" \
    http://127.0.0.1:3233/health >/dev/null
fi

exec curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3233/health >/dev/null
