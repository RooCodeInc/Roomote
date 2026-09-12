#!/usr/bin/env bash
set -euo pipefail
ROOT="$(dirname "$(realpath "$0")")"
source "$ROOT/iron.lock"
BUILD="$ROOT/.build"
SOURCE="$BUILD/iron-proxy-$IRON_GIT_SHA"
mkdir -p "$BUILD" "$ROOT/bin"
ARCHIVE="$BUILD/$IRON_GIT_SHA.tar.gz"
if [[ ! -f "$ARCHIVE" ]]; then
  curl --fail --location --proto '=https' --tlsv1.2 \
    "https://codeload.github.com/ironsh/iron-proxy/tar.gz/$IRON_GIT_SHA" --output "$ARCHIVE.part"
  mv "$ARCHIVE.part" "$ARCHIVE"
fi
# Node is already required by archive validation and the source overlay patcher.
node --input-type=module - "$ARCHIVE" "$IRON_ARCHIVE_SHA256" <<'JS'
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const actual = createHash('sha256').update(readFileSync(process.argv[2])).digest('hex');
if (actual !== process.argv[3]) throw new Error('archive SHA256 mismatch');
JS
# The SHA-addressed archive and exact top-level name are both verified before extraction.
tar -tzf "$ARCHIVE" | node "$ROOT/verify-archive.mjs" "$IRON_GIT_SHA"
rm -rf "$SOURCE" # Only our ignored, SHA-addressed generated source directory.
tar -xzf "$ARCHIVE" -C "$BUILD"
cp -R "$ROOT/overlay/." "$SOURCE/"
node "$ROOT/patch-iron.mjs" "$SOURCE"
printf 'Iron source: %s\nGit SHA: %s\nArchive SHA256: %s\n' "$SOURCE" "$IRON_GIT_SHA" "$IRON_ARCHIVE_SHA256"
case "${1:-build}" in
  prepare) ;;
  test) mise exec go@1.26.1 -- go -C "$SOURCE" test -race ./internal/roomote/... ./internal/proxy ./internal/transform ./internal/certcache ;;
  vet) mise exec go@1.26.1 -- go -C "$SOURCE" vet ./internal/roomote/... ./internal/proxy ./internal/transform ;;
  build) mise exec go@1.26.1 -- go -C "$SOURCE" build -trimpath -o "$ROOT/bin/session-egress-gateway" ./cmd/iron-proxy ;;
  *) exit 2 ;;
esac
