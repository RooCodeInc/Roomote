#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

"$ROOT_DIR/../../scripts/watchman.sh" \
  "controller" \
  "pnpm exec tsup" \
  "APP_ENV=development pnpm exec dotenvx run -f ../../.env.local -- node --watch --import ./dist/instrument.js ./dist/index.js"
