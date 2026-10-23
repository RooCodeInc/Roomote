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

  echo "[$SERVICE_NAME:watchman] Initial build..."
  bash -lc "$BUILD_CMD"

  # Use watchman trigger for reliable file-change detection.
  # watchman-make subscriptions stall under PM2's piped stdio.
  TRIGGER_NAME="${SERVICE_NAME}-build"

  # Remove any stale trigger first
  watchman -- trigger-del "$REPO_ROOT" "$TRIGGER_NAME" >/dev/null 2>&1 || true

  # Capture PATH so the trigger command can find pnpm/node/etc.
  CURRENT_PATH="$PATH"

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
  exec bash -lc "$RUN_CMD"
fi

if command -v inotifywait &>/dev/null; then
  echo "[$SERVICE_NAME:inotifywait] watchman not available, using inotifywait fallback"

  CURRENT_PATH="$PATH"

  RUN_PID=""
  WATCH_PID=""
  EVENT_DIR=""
  EVENT_FD=""
  cleanup_inotify() {
    local status=$?
    trap - EXIT INT TERM
    if [[ -n "$EVENT_FD" ]]; then
      exec {EVENT_FD}<&-
    fi
    if [[ -n "$WATCH_PID" ]]; then
      kill "$WATCH_PID" 2>/dev/null || true
      wait "$WATCH_PID" 2>/dev/null || true
    fi
    if [[ -n "$RUN_PID" ]]; then
      kill "$RUN_PID" 2>/dev/null || true
      wait "$RUN_PID" 2>/dev/null || true
    fi
    if [[ -n "$EVENT_DIR" ]]; then
      rm -rf "$EVENT_DIR"
    fi
    exit "$status"
  }
  trap cleanup_inotify EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  # Keep one monitor alive through compilation. A one-shot watch loses every
  # edit made while the build is running. Its readiness line also fences the
  # initial build so that startup edits cannot fall through the same gap.
  EVENT_DIR=$(mktemp -d)
  mkfifo "$EVENT_DIR/events"
  LC_ALL=C inotifywait -m -r \
    --include '\.ts$' \
    --format '%w%f' \
    -e modify,create,delete,move \
    "$REPO_ROOT/$APP_REL/src" \
    "$REPO_ROOT/packages" \
    >"$EVENT_DIR/events" 2>&1 &
  WATCH_PID=$!
  # Let Bash choose an unused descriptor: PM2 reserves fd3 for Node IPC, which
  # build/runtime children must continue to inherit unchanged.
  exec {EVENT_FD}<"$EVENT_DIR/events"
  WATCH_READY=false
  while IFS= read -r -u "$EVENT_FD" event; do
    if [[ "$event" == "Watches established." ]]; then
      WATCH_READY=true
      break
    fi
    printf '%s\n' "$event"
  done
  if [[ "$WATCH_READY" != true ]]; then
    echo "[$SERVICE_NAME:inotifywait] Failed to establish file watches." >&2
    exit 1
  fi

  echo "[$SERVICE_NAME:inotifywait] Initial build..."
  bash -lc "$BUILD_CMD" {EVENT_FD}<&-

  echo "[$SERVICE_NAME:inotifywait] Starting runtime..."
  bash -c "export PATH='$CURRENT_PATH' && cd '$APP_DIR' && $RUN_CMD" {EVENT_FD}<&- &
  RUN_PID=$!

  echo "[$SERVICE_NAME:inotifywait] Watching for changes in $APP_REL/src/ and packages/..."
  while IFS= read -r -u "$EVENT_FD" event; do
    sleep 0.2
    # Coalesce the pre-build burst only. Events received during the build stay
    # queued for the next pass. Bound draining so continuous edits cannot starve
    # compilation, and treat monitor EOF as failure rather than a rebuild loop.
    for ((i = 0; i < 1000; i++)); do
      if IFS= read -r -t 0.01 -u "$EVENT_FD" event; then
        continue
      else
        read_status=$?
        if [[ "$read_status" -eq 1 ]]; then
          echo "[$SERVICE_NAME:inotifywait] File watcher stopped." >&2
          exit 1
        fi
        break
      fi
    done

    echo "[$SERVICE_NAME:inotifywait] Change detected, rebuilding..."

    kill "$RUN_PID" 2>/dev/null || true
    wait "$RUN_PID" 2>/dev/null || true

    RUN_PID=""
    bash -c "export PATH='$CURRENT_PATH' && cd '$APP_DIR' && $BUILD_CMD" {EVENT_FD}<&- || true

    echo "[$SERVICE_NAME:inotifywait] Restarting runtime..."
    bash -c "export PATH='$CURRENT_PATH' && cd '$APP_DIR' && $RUN_CMD" {EVENT_FD}<&- &
    RUN_PID=$!
  done
  echo "[$SERVICE_NAME:inotifywait] File watcher stopped." >&2
  exit 1
fi

# ── No file watcher available ───────────────────────────────────────────────
echo "[$SERVICE_NAME] ERROR: Neither watchman nor inotifywait found." >&2
echo "[$SERVICE_NAME] Run: ./scripts/install-watchman.sh" >&2
exit 1
