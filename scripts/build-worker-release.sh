#!/bin/bash
#
# Build and optionally publish a worker release
#
# Usage:
#   ./scripts/build-worker-release.sh [version] [--release-channel <stable|preview>] [--output-dir <path>] [--publish] [--ci]
#
# Examples:
#   ./scripts/build-worker-release.sh                    # Build only (version: local-test)
#   ./scripts/build-worker-release.sh 0.0.1              # Build with version
#   ./scripts/build-worker-release.sh local-dev --output-dir releases
#   ./scripts/build-worker-release.sh 0.0.1-preview.1 --release-channel preview
#   ./scripts/build-worker-release.sh 0.0.1 --publish    # Build and publish to GitHub
#

set -euo pipefail

# Parse arguments
VERSION=""
RELEASE_CHANNEL="stable"
OUTPUT_DIR=""
PUBLISH=false
CI_MODE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release-channel)
      RELEASE_CHANNEL="${2:-}"
      if [[ -z "$RELEASE_CHANNEL" ]]; then
        echo "Error: --release-channel requires stable or preview"
        exit 1
      fi
      shift 2
      ;;
    --publish)
      PUBLISH=true
      shift
      ;;
    --ci)
      CI_MODE=true
      shift
      ;;
    --output-dir)
      OUTPUT_DIR="${2:-}"
      if [[ -z "$OUTPUT_DIR" ]]; then
        echo "Error: --output-dir requires a directory path"
        exit 1
      fi
      shift 2
      ;;
    -*)
      echo "Unknown option: $1"
      exit 1
      ;;
    *)
      if [[ -n "$VERSION" ]]; then
        echo "Error: multiple version arguments provided"
        exit 1
      fi
      VERSION="$1"
      shift
      ;;
  esac
done

[ -z "$VERSION" ] && { [ "$CI_MODE" = true ] && { echo "Error: Version required in CI"; exit 1; } || VERSION="local-test"; }

case "$RELEASE_CHANNEL" in
  stable)
    TAG_PREFIX="worker-v"
    ;;
  preview)
    TAG_PREFIX="worker-preview-v"
    ;;
  *)
    echo "Error: Unsupported release channel '$RELEASE_CHANNEL'. Expected stable or preview."
    exit 1
    ;;
esac

TAG="${TAG_PREFIX}${VERSION}"
ARCHIVE_NAME="${TAG}.tar.gz"
REPO="${GITHUB_REPOSITORY:-Roomote/Roomote}"
RELEASE_TARGET="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo)}"

if [[ -n "$OUTPUT_DIR" && "$OUTPUT_DIR" != /* ]]; then
  OUTPUT_DIR="${PWD}/${OUTPUT_DIR}"
fi

if [[ -n "$OUTPUT_DIR" ]]; then
  mkdir -p "$OUTPUT_DIR"
fi

ARCHIVE_PATH="${OUTPUT_DIR:+${OUTPUT_DIR}/}${ARCHIVE_NAME}"
CHECKSUM_PATH="${ARCHIVE_PATH}.sha256"

# Validate version format for publishing.
if [ "$PUBLISH" = true ]; then
  if [ "$RELEASE_CHANNEL" = "stable" ] && ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "Error: Stable worker releases must use plain semver (expected X.Y.Z)"
    exit 1
  fi

  if [ "$RELEASE_CHANNEL" = "preview" ] && ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+-[a-zA-Z0-9.]+$'; then
    echo "Error: Preview worker releases must use prerelease semver (expected X.Y.Z-suffix)"
    exit 1
  fi
fi

echo "Building worker release: $TAG"

NODE_PTY_VERSION="$(
  node -e 'const pkg=require("./apps/worker/package.json"); const raw=pkg.dependencies?.["node-pty"]; if (typeof raw !== "string") { throw new Error("apps/worker/package.json is missing dependencies.node-pty"); } const normalized=raw.replace(/^[^0-9]*/, ""); if (!normalized) { throw new Error(`Unable to normalize node-pty version from ${raw}`); } process.stdout.write(normalized);'
)"

# The worker image's Dockerfile ARG is the source of truth for the pm2
# version; ship it in the release so bring-your-own-image bootstraps
# (install-worker.sh) install the same pin instead of drifting to latest.
PM2_VERSION="$(sed -n 's/^ARG PM2_VERSION=//p' apps/worker/Dockerfile | head -1)"
if [ -z "$PM2_VERSION" ]; then
  echo "Error: ARG PM2_VERSION not found in apps/worker/Dockerfile"
  exit 1
fi

# Build
pnpm --filter @roomote/worker build
[ -f "apps/worker/dist/worker.js" ] || { echo "Build failed"; exit 1; }

if [[ "$PUBLISH" = true && -n "${SENTRY_AUTH_TOKEN:-}" ]]; then
  # Task environments may also provide SENTRY_AUTH_TOKEN values that are not
  # worker-release publish credentials, so only use it for sourcemap uploads.
  : "${SENTRY_ORG:?SENTRY_ORG is required when publishing with SENTRY_AUTH_TOKEN}"
  : "${SENTRY_PROJECT:?SENTRY_PROJECT is required when publishing with SENTRY_AUTH_TOKEN}"
  SENTRY_CLI_PACKAGE="@sentry/cli@2.58.1"

  echo "Injecting Sentry Debug IDs into worker dist/"
  pnpm dlx "$SENTRY_CLI_PACKAGE" sourcemaps inject apps/worker/dist

  echo "Uploading worker sourcemaps to Sentry (${SENTRY_ORG}/${SENTRY_PROJECT})"
  pnpm dlx "$SENTRY_CLI_PACKAGE" sourcemaps upload \
    --org "$SENTRY_ORG" \
    --project "$SENTRY_PROJECT" \
    apps/worker/dist
fi

# Package
rm -rf "$TAG" "$CHECKSUM_PATH"
mkdir -p "$TAG/dist" "$TAG/.agents/skills"
# Copy the entire worker dist tree so runtime assets such as bundled patch files
# ship alongside the JS entrypoints they are resolved from.
cp -R apps/worker/dist/. "$TAG/dist/"
# Strip sourcemaps from the packaged release. Sourcemaps embed the original
# TypeScript via sourcesContent, so they must not ship in release archives
# (which are baked into the app image and injected into task sandboxes).
# The Sentry upload above reads from apps/worker/dist and is unaffected.
find "$TAG/dist" -type f -name '*.map' -delete
# MCP configs go into .agents/ (Claude Code reads them).
[ -d ".docker/config/mcp" ] && cp -r .docker/config/mcp "$TAG/.agents/"
# Packaged skills source folders live outside .agents/ so they don't pollute the
# agent home. activateSkillsFolder() copies the selected one into .agents/skills/.
[ -d "packages/cloud-agents/src/server/workflows/skills" ] && cp -r packages/cloud-agents/src/server/workflows/skills "$TAG/.packaged-skills"
echo "$VERSION" > "$TAG/VERSION"
echo "${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}" > "$TAG/COMMIT"
echo "$NODE_PTY_VERSION" > "$TAG/NODE_PTY_VERSION"
echo "$PM2_VERSION" > "$TAG/PM2_VERSION"

# Strip macOS xattrs if needed
command -v xattr &>/dev/null && xattr -cr "$TAG" 2>/dev/null || true

# Create release archive atomically to avoid race with fs.watch consumers.
# Write to a temp file first, then mv to the final path so watchers only
# ever see a complete archive.
ARCHIVE_TMP="${ARCHIVE_PATH}.tmp.$$"
if command -v gtar &>/dev/null; then
  gtar -czf "$ARCHIVE_TMP" "$TAG"
elif [[ "$OSTYPE" == "darwin"* ]]; then
  COPYFILE_DISABLE=1 tar --no-xattrs -czf "$ARCHIVE_TMP" "$TAG" 2>/dev/null || COPYFILE_DISABLE=1 tar -czf "$ARCHIVE_TMP" "$TAG"
else
  tar -czf "$ARCHIVE_TMP" "$TAG"
fi
mv -f "$ARCHIVE_TMP" "$ARCHIVE_PATH"

# Checksum
CHECKSUM=$(sha256sum "$ARCHIVE_PATH" 2>/dev/null || shasum -a 256 "$ARCHIVE_PATH")
CHECKSUM="${CHECKSUM%%  *}"  # Extract just the hash (before the double-space separator)
echo "$CHECKSUM  $ARCHIVE_NAME" > "$CHECKSUM_PATH"

rm -rf "$TAG"
echo "✓ Created $ARCHIVE_PATH ($(ls -lh "$ARCHIVE_PATH" | awk '{print $5}'))"

# CI outputs
[ "$CI_MODE" = true ] && [ -n "$GITHUB_OUTPUT" ] && {
  echo "version=$VERSION" >> "$GITHUB_OUTPUT"
  echo "release_channel=$RELEASE_CHANNEL" >> "$GITHUB_OUTPUT"
  echo "tag=$TAG" >> "$GITHUB_OUTPUT"
  echo "archive=$ARCHIVE_NAME" >> "$GITHUB_OUTPUT"
  echo "checksum=$CHECKSUM" >> "$GITHUB_OUTPUT"
}

# Publish
if [ "$PUBLISH" = true ]; then
  command -v gh &>/dev/null || { echo "Error: gh CLI not installed"; exit 1; }
  gh auth status &>/dev/null || { echo "Error: Not authenticated with gh"; exit 1; }
  
  # Delete existing release if any
  gh release view "$TAG" &>/dev/null && {
    gh release delete "$TAG" --yes
    git tag -d "$TAG" 2>/dev/null || true
    git push origin ":refs/tags/$TAG" 2>/dev/null || true
  }
  
  # Always prerelease worker archive tags. Product `v*` GitHub Releases own
  # `releases/latest` for the self-host installer; a non-prerelease worker tag
  # would steal that pointer.
  PRERELEASE_FLAG="--prerelease"

  RELEASE_TITLE="Worker $VERSION"
  [[ "$RELEASE_CHANNEL" == "preview" ]] && RELEASE_TITLE="Worker Preview $VERSION"
  
  gh release create "$TAG" \
    --target "$RELEASE_TARGET" \
    --title "$RELEASE_TITLE" \
    --notes "Worker release $VERSION. SHA256: \`$CHECKSUM\`" \
    $PRERELEASE_FLAG \
    "$ARCHIVE_PATH" "$CHECKSUM_PATH"
  
  echo "✓ Published: https://github.com/$REPO/releases/tag/$TAG"
  
  [ "$CI_MODE" = true ] && [ -n "$GITHUB_STEP_SUMMARY" ] && {
    echo "## Worker $VERSION released" >> "$GITHUB_STEP_SUMMARY"
    echo "SHA256: \`$CHECKSUM\`" >> "$GITHUB_STEP_SUMMARY"
  }
else
  echo "To publish: ./scripts/build-worker-release.sh $VERSION --publish"
fi
