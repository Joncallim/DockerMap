#!/usr/bin/env bash
set -euo pipefail

# Package the portable, reviewable artifacts produced by the release workflow.
# This intentionally does not publish an image or alter a registry: publication
# remains a separately authenticated release decision.

version="${1:?usage: scripts/package-release.sh <version>}"
output_dir="${DOCKERMAP_RELEASE_DIR:-dist/release}"
stage_dir="$output_dir/dockermap-$version-linux-x86_64"

if [[ ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9._-]+)?$ ]]; then
  echo "release version must be a v-prefixed semantic version" >&2
  exit 2
fi

rm -rf "$stage_dir"
mkdir -p "$stage_dir/bin" "$stage_dir/web" "$stage_dir/deploy"

install -m 0755 crates/target/release/dockermap-daemon "$stage_dir/bin/"
install -m 0755 crates/target/release/dockermap-docker-gateway "$stage_dir/bin/"
cp -a apps/web/dist/. "$stage_dir/web/"
cp -a deploy/docker deploy/systemd "$stage_dir/deploy/"
install -m 0644 docs/release/RELEASE_CHECKLIST.md "$stage_dir/"

tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='UTC 2020-01-01' \
  -C "$output_dir" -czf "$output_dir/dockermap-$version-linux-x86_64.tar.gz" \
  "dockermap-$version-linux-x86_64"
(cd "$output_dir" && sha256sum "dockermap-$version-linux-x86_64.tar.gz" > "dockermap-$version-linux-x86_64.sha256")
