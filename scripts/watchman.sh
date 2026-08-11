#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 <service-name> <build-cmd> <run-cmd>"
  exit 1
fi

SERVICE_NAME="$1"
BUILD_CMD="$2"
RUN_CMD="$3"

APP_DIR="$(pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ "$APP_DIR" != "$REPO_ROOT" && "$APP_DIR" != "$REPO_ROOT/"* ]]; then
  echo "Current directory must be inside repository root."
  echo "Current: $APP_DIR"
  echo "Repo: $REPO_ROOT"
  exit 1
fi

APP_REL="${APP_DIR#$REPO_ROOT/}"

if command -v watchman &>/dev/null && watchman version &>/dev/null; then
  cleanup() {
    watchman -- trigger-del "$REPO_ROOT" "${SERVICE_NAME}-build" >/dev/null 2>&1 || true
  }

  trap cleanup EXIT INT TERM

  # Capture PATH so build/trigger/runtime commands can find pnpm/node/etc.
  # `bash -lc` starts a login shell, which re-sources bash's own profile
  # instead of inheriting this PATH (mise/nodenv setup living in the
  # invoking shell's own dotfiles, e.g. zsh, is not picked up), so every
  # `bash -lc` call below must re-export it explicitly.
  CURRENT_PATH="$PATH"

  echo "[$SERVICE_NAME:watchman] Initial build..."
  bash -lc "export PATH='$CURRENT_PATH' && $BUILD_CMD"

  # Use watchman trigger for reliable file-change detection.
  # watchman-make subscriptions stall under PM2's piped stdio.
  TRIGGER_NAME="${SERVICE_NAME}-build"

  # Remove any stale trigger first
  watchman -- trigger-del "$REPO_ROOT" "$TRIGGER_NAME" >/dev/null 2>&1 || true

  echo "[$SERVICE_NAME:watchman] Ensuring watchman is watching $REPO_ROOT..."
  watchman watch-project "$REPO_ROOT" >/dev/null 2>&1

  echo "[$SERVICE_NAME:watchman] Setting up watchman trigger (root: $REPO_ROOT)..."
  watchman -j <<WATCHMAN_CMD
["trigger", "$REPO_ROOT", {
  "name": "$TRIGGER_NAME",
  "expression": ["anyof",
    ["match", "$APP_REL/src/**/*.ts", "wholename"],
    ["match", "packages/**/*.ts", "wholename"]
  ],
  "command": ["bash", "-lc", "export PATH='$CURRENT_PATH' && cd '$APP_DIR' && $BUILD_CMD"],
  "append_files": false,
  "stdin": "/dev/null",
  "settle": 200
}]
WATCHMAN_CMD

  echo "[$SERVICE_NAME:watchman] Starting runtime..."
  exec bash -lc "export PATH='$CURRENT_PATH' && $RUN_CMD"
fi

if command -v inotifywait &>/dev/null; then
  echo "[$SERVICE_NAME:inotifywait] watchman not available, using inotifywait fallback"

  CURRENT_PATH="$PATH"

  echo "[$SERVICE_NAME:inotifywait] Initial build..."
  bash -lc "export PATH='$CURRENT_PATH' && $BUILD_CMD"

  echo "[$SERVICE_NAME:inotifywait] Starting runtime..."
  bash -c "export PATH='$CURRENT_PATH' && cd '$APP_DIR' && $RUN_CMD" &
  RUN_PID=$!

  cleanup_inotify() {
    kill "$RUN_PID" 2>/dev/null || true
  }
  trap cleanup_inotify EXIT INT TERM

  echo "[$SERVICE_NAME:inotifywait] Watching for changes in $APP_REL/src/ and packages/..."
  while true; do
    inotifywait -r -q \
      --include '\.ts$' \
      -e modify,create,delete,move \
      "$REPO_ROOT/$APP_REL/src" \
      "$REPO_ROOT/packages" \
      2>/dev/null || true

    sleep 0.2

    echo "[$SERVICE_NAME:inotifywait] Change detected, rebuilding..."

    kill "$RUN_PID" 2>/dev/null || true
    wait "$RUN_PID" 2>/dev/null || true

    bash -c "export PATH='$CURRENT_PATH' && cd '$APP_DIR' && $BUILD_CMD" || true

    echo "[$SERVICE_NAME:inotifywait] Restarting runtime..."
    bash -c "export PATH='$CURRENT_PATH' && cd '$APP_DIR' && $RUN_CMD" &
    RUN_PID=$!
  done
fi

# ── No file watcher available ───────────────────────────────────────────────
echo "[$SERVICE_NAME] ERROR: Neither watchman nor inotifywait found." >&2
echo "[$SERVICE_NAME] Run: ./scripts/install-watchman.sh" >&2
exit 1
