#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

"$ROOT_DIR/../../scripts/watchman.sh" \
  "api" \
  "pnpm exec tsup" \
  "pnpm exec dotenvx run -f ../../.env.local -- node --watch dist/index.js"
