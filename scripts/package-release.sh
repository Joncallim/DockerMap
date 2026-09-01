#!/usr/bin/env bash
set -euo pipefail

# Package the portable, reviewable artifacts produced by the release workflow.
# This intentionally does not publish an image or alter a registry: publication
# remains a separately authenticated release decision.

version="${1:?usage: scripts/package-release.sh <version> [--check]}"
check_only="${2:-}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$version" != v* ]]; then
  echo "release version must be a v-prefixed semantic version" >&2
  exit 2
fi

if [[ -n "$check_only" && "$check_only" != "--check" ]]; then
  echo "usage: scripts/package-release.sh <version> [--check]" >&2
  exit 2
fi

# Check every product-version mirror before touching the release directory. The
# root checker owns SemVer grammar, including valid `+build` metadata.
(cd "$root_dir" && node scripts/check-version-authority.mjs >/dev/null)
IFS= read -r product_version < "$root_dir/VERSION"
if [[ "$version" != "v$product_version" ]]; then
  echo "release tag $version must exactly match v$product_version from VERSION" >&2
  exit 2
fi

if [[ "$check_only" == "--check" ]]; then
  exit 0
fi

output_dir="${DOCKERMAP_RELEASE_DIR:-dist/release}"
stage_dir="$output_dir/dockermap-$version-linux-x86_64"

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
