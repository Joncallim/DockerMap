#!/usr/bin/env bash
set -euo pipefail

# Package the portable audit/review bundle produced by the release workflow.
# This intentionally does not publish an image or alter a registry: publication
# remains a separately authenticated release decision. The archive is not a
# standalone installer; its metadata says so explicitly.

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

if ! source_sha="$(git -C "$root_dir" rev-parse --verify HEAD)" \
  || [[ ! "$source_sha" =~ ^[0-9a-f]{40,64}$ ]]; then
  echo "release audit bundle requires an exact Git source commit" >&2
  exit 2
fi
if [[ -n "$(git -C "$root_dir" status --porcelain --untracked-files=normal --ignore-submodules)" ]]; then
  echo "release audit bundle refuses modified or untracked source files" >&2
  exit 2
fi

output_dir="${DOCKERMAP_RELEASE_DIR:-dist/release}"
stage_dir="$output_dir/dockermap-$version-linux-x86_64"

cd "$root_dir"
rm -rf "$stage_dir"
mkdir -p "$stage_dir/bin" "$stage_dir/web" "$stage_dir/deploy"

install -m 0755 crates/target/release/dockermap-daemon "$stage_dir/bin/"
install -m 0755 crates/target/release/dockermap-docker-gateway "$stage_dir/bin/"
cp -a apps/web/dist/. "$stage_dir/web/"
cp -a deploy/docker deploy/systemd "$stage_dir/deploy/"
install -m 0644 docs/release/RELEASE_CHECKLIST.md "$stage_dir/"

{
  printf 'artifact_type=dockermap-audit-review-bundle\n'
  printf 'installable=false\n'
  printf 'product_version=%s\n' "$product_version"
  printf 'release_tag=%s\n' "$version"
  printf 'source_sha=%s\n' "$source_sha"
  printf 'platform=linux-x86_64\n'
} > "$stage_dir/ARTIFACT-METADATA"

# The internal manifest proves every staged file independently of the outer
# transport checksum. All staged names are controlled by this script.
(
  cd "$stage_dir"
  find . -type f ! -name MANIFEST.sha256 -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum > MANIFEST.sha256
  sha256sum --check MANIFEST.sha256 >/dev/null
)

tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='UTC 2020-01-01' \
  -C "$output_dir" -czf "$output_dir/dockermap-$version-linux-x86_64.tar.gz" \
  "dockermap-$version-linux-x86_64"
(cd "$output_dir" && sha256sum "dockermap-$version-linux-x86_64.tar.gz" > "dockermap-$version-linux-x86_64.sha256")
