#!/bin/bash -e

# Worker installer - refreshes the shipped worker runtime inside /sandbox.
#
# Keep this script narrowly focused on installing the Roomote worker release,
# the minimal worker launcher wrapper, and the shared node-pty compatibility
# check. Generic system/tool bootstrap belongs in the worker Dockerfiles or in
# apps/worker/src/commands/setup.ts.
#
# The controller is responsible for providing the worker release archive. This
# script never contacts GitHub directly.
#
# Installation modes:
#
#   Hosted sandbox (production + local dev):
#     - Controller uploads this script + archive to /sandbox/worker.tar.gz
#     - This script installs from the uploaded worker release archive
#
#   Hosted sandbox (snapshot resume):
#     - Environment snapshot launches restore a cached sandbox first, then run
#       this script to refresh the shipped Roomote worker/runtime in place
#     - Task snapshot launches also refresh the shipped worker/runtime while
#       preserving repositories, harness sessions, and other snapshot state
#
# Build worker release archive: ./scripts/build-worker-release.sh <version>

WORKER_RELEASE_ARCHIVE="${WORKER_RELEASE_ARCHIVE_PATH:-/sandbox/worker.tar.gz}"
WORKER_DIR="/sandbox/worker"
WORKER_RELEASE_TAG_FILE="$WORKER_DIR/WORKER_RELEASE_TAG"
NODE_PTY_VERSION_FILE="$WORKER_DIR/NODE_PTY_VERSION"
DATA_DIR="/sandbox"
INSTALL_WORKER_START_MS="$(date +%s%3N)"
INSTALL_WORKER_PHASE_NAMES=()
INSTALL_WORKER_PHASE_DURATIONS_MS=()

now_ms() {
  date +%s%3N
}

record_phase_result() {
  local phase_name="$1"
  local duration_ms="$2"
  local status="$3"
  local exit_code="${4:-0}"

  INSTALL_WORKER_PHASE_NAMES+=("$phase_name")
  INSTALL_WORKER_PHASE_DURATIONS_MS+=("$duration_ms")

  if [ "$status" = "ok" ]; then
    printf 'install_worker.phase=%s duration_ms=%s status=%s\n' \
      "$phase_name" \
      "$duration_ms" \
      "$status"
    return 0
  fi

  printf 'install_worker.phase=%s duration_ms=%s status=%s exit_code=%s\n' \
    "$phase_name" \
    "$duration_ms" \
    "$status" \
    "$exit_code"
}

run_phase() {
  local phase_name="$1"
  local start_ms
  local end_ms
  local duration_ms
  local exit_code

  shift
  start_ms="$(now_ms)"

  if "$@"; then
    end_ms="$(now_ms)"
    duration_ms=$((end_ms - start_ms))
    record_phase_result "$phase_name" "$duration_ms" "ok"
    return 0
  else
    exit_code=$?
  fi

  end_ms="$(now_ms)"
  duration_ms=$((end_ms - start_ms))
  record_phase_result "$phase_name" "$duration_ms" "error" "$exit_code"
  return "$exit_code"
}

emit_phase_summary() {
  local summary=""
  local index
  local phase_name
  local duration_ms

  if [ "${#INSTALL_WORKER_PHASE_NAMES[@]}" -eq 0 ]; then
    printf 'install_worker.summary phases=""\n'
    return 0
  fi

  while IFS='|' read -r duration_ms phase_name; do
    [ -z "$phase_name" ] && continue

    if [ -n "$summary" ]; then
      summary="${summary},"
    fi

    summary="${summary}${phase_name}=${duration_ms}ms"
  done < <(
    for index in "${!INSTALL_WORKER_PHASE_NAMES[@]}"; do
      printf '%s|%s\n' \
        "${INSTALL_WORKER_PHASE_DURATIONS_MS[$index]}" \
        "${INSTALL_WORKER_PHASE_NAMES[$index]}"
    done | sort -t'|' -k1,1nr -k2,2
  )

  printf 'install_worker.summary phases="%s"\n' "$summary"
}

on_install_worker_exit() {
  local exit_code="$1"
  local total_duration_ms
  local status="ok"

  total_duration_ms=$(( $(now_ms) - INSTALL_WORKER_START_MS ))

  if [ "$exit_code" -ne 0 ]; then
    status="error"
  fi

  record_phase_result "install_worker_total" "$total_duration_ms" "$status" "$exit_code"
  emit_phase_summary
}

trap 'on_install_worker_exit $?' EXIT

get_installed_version() {
  if [ -f "$WORKER_DIR/VERSION" ]; then
    cat "$WORKER_DIR/VERSION"
  else
    echo ""
  fi
}

get_expected_node_pty_version() {
  if [ -f "$NODE_PTY_VERSION_FILE" ]; then
    cat "$NODE_PTY_VERSION_FILE"
  else
    echo ""
  fi
}

get_installed_node_pty_version() {
  WORKER_ENTRY="$WORKER_DIR/dist/worker.js" node --input-type=module -e '
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const workerEntry = process.env.WORKER_ENTRY;

if (!workerEntry) {
  throw new Error("WORKER_ENTRY is required");
}

const requireFromWorker = createRequire(pathToFileURL(workerEntry));
const resolvedEntry = requireFromWorker.resolve("node-pty");
let currentDir = path.dirname(resolvedEntry);

while (true) {
  const packageJsonPath = path.join(currentDir, "package.json");

  if (fs.existsSync(packageJsonPath)) {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

    if (pkg?.name === "node-pty" && typeof pkg.version === "string") {
      process.stdout.write(pkg.version);
      process.exit(0);
    }
  }

  const parentDir = path.dirname(currentDir);

  if (parentDir === currentDir) {
    break;
  }

  currentDir = parentDir;
}

throw new Error(`node-pty version metadata not found for ${resolvedEntry}`);
'
}

ensure_data_dir() {
  if [ ! -d "$DATA_DIR" ]; then
    mkdir -p "$DATA_DIR" 2>/dev/null || sudo -n mkdir -p "$DATA_DIR"
  fi

  # Provider-managed images ship a writable $DATA_DIR; bring-your-own images
  # (for example Box) may have it root-owned, so reclaim it when possible.
  if [ ! -w "$DATA_DIR" ] &&
    command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    echo "Making $DATA_DIR writable for $(id -un)"
    sudo -n chown "$(id -u):$(id -g)" "$DATA_DIR"
  fi

  if [ ! -w "$DATA_DIR" ]; then
    echo "Error: $DATA_DIR is not writable and non-interactive sudo is unavailable"
    return 1
  fi
}

install_from_release_archive() {
  local archive_path="$1"
  echo "Installing worker from release archive..."

  if [ -d "$WORKER_DIR" ]; then
    echo "Removing old worker installation..."
    # Clear contents instead of removing directory (may be a mount point).
    rm -rf "$WORKER_DIR"/* "$WORKER_DIR"/.[!.]* 2>/dev/null || true
  else
    mkdir -p "$WORKER_DIR" || return 1
  fi

  tar -xzf "$archive_path" --strip-components=1 -C "$WORKER_DIR" || return 1

  if [ -n "${WORKER_RELEASE_TAG:-}" ]; then
    printf "%s\n" "$WORKER_RELEASE_TAG" > "$WORKER_RELEASE_TAG_FILE"
  fi

  if [ "$archive_path" != "$WORKER_RELEASE_ARCHIVE" ]; then
    rm -f "$archive_path"
  fi

  local version
  version="$(get_installed_version)"
  echo "Worker ${version:-unknown} installed at $WORKER_DIR"
}

install_worker() {
  ensure_data_dir || return 1

  if [ -f "$WORKER_RELEASE_ARCHIVE" ]; then
    install_from_release_archive "$WORKER_RELEASE_ARCHIVE" || return 1
  elif [ -f "$WORKER_DIR/dist/worker.js" ]; then
    echo "Worker already installed (v$(get_installed_version))"
  else
    echo "Error: No worker release archive found and worker not installed"
    echo "The controller should have uploaded the worker release archive."
    return 1
  fi

  if [ ! -f "$WORKER_DIR/dist/worker.js" ]; then
    echo "Error: worker install finished but $WORKER_DIR/dist/worker.js is missing"
    return 1
  fi
}

install_worker_cli() {
  local cli_path="/usr/local/bin/worker"
  local cli_dir="/usr/local/bin"
  local cli_contents="#!/bin/bash
exec node $WORKER_DIR/dist/worker.js \"\$@\""

  if [ ! -f "$WORKER_DIR/dist/worker.js" ]; then
    echo "Warning: worker.js not found, skipping CLI installation"
    return 0
  fi

  if [ -w "$cli_dir" ]; then
    echo "Installing worker CLI to $cli_path"
    printf "%s\n" "$cli_contents" > "$cli_path"
    chmod +x "$cli_path"
    return 0
  fi

  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    echo "Installing worker CLI to $cli_path"
    printf "%s\n" "$cli_contents" | sudo -n tee "$cli_path" > /dev/null
    sudo -n chmod +x "$cli_path"
    return 0
  fi

  cli_path="$HOME/.local/bin/worker"
  echo "No non-interactive sudo available; installing worker CLI to $cli_path"
  mkdir -p "$HOME/.local/bin"
  printf "%s\n" "$cli_contents" > "$cli_path"
  chmod +x "$cli_path"
}

ensure_node_pty() {
  local expected_version
  local installed_version
  local package_spec="node-pty"

  if [ ! -f "$WORKER_DIR/dist/worker.js" ]; then
    echo "Warning: worker.js not found, skipping node-pty validation"
    return 0
  fi

  expected_version="$(get_expected_node_pty_version)"

  if installed_version="$(get_installed_node_pty_version 2>/dev/null)"; then
    if [ -z "$expected_version" ] || [ "$installed_version" = "$expected_version" ]; then
      echo "node-pty already installed (v${installed_version})"
      return 0
    fi

    echo "node-pty version mismatch: found v${installed_version}, expected v${expected_version}; reinstalling..."
  else
    if [ -n "$expected_version" ]; then
      echo "node-pty missing; installing v${expected_version}..."
    else
      echo "node-pty missing; installing latest compatible release..."
    fi
  fi

  ensure_data_dir || return 1

  if [ -n "$expected_version" ]; then
    package_spec="${package_spec}@${expected_version}"
  fi

  npm install --prefix "$DATA_DIR" --no-save --no-package-lock "$package_spec"

  if ! installed_version="$(get_installed_node_pty_version)"; then
    echo "Error: node-pty is still not resolvable from $WORKER_DIR/dist/worker.js after installation"
    return 1
  fi

  if [ -n "$expected_version" ] && [ "$installed_version" != "$expected_version" ]; then
    echo "Error: node-pty resolved to v${installed_version} after installation, expected v${expected_version}"
    return 1
  fi

  echo "node-pty ${installed_version} installed and validated for $WORKER_DIR/dist/worker.js"
}

# The worker's detached process manager requires pm2. Worker Docker images
# bundle it at /usr/local/bin/pm2; bring-your-own images (for example Box)
# ship without it, so install it next to node-pty and expose a launcher on
# the path the worker resolves first.
ensure_pm2() {
  if [ -x "/usr/local/bin/pm2" ] || command -v pm2 >/dev/null 2>&1; then
    echo "pm2 already available"
    return 0
  fi

  echo "pm2 missing; installing..."
  ensure_data_dir || return 1
  npm install --prefix "$DATA_DIR" --no-save --no-package-lock pm2 || return 1

  local pm2_entry="$DATA_DIR/node_modules/pm2/bin/pm2"
  if [ ! -f "$pm2_entry" ]; then
    echo "Error: pm2 install completed but $pm2_entry is missing"
    return 1
  fi

  local cli_path="/usr/local/bin/pm2"
  local cli_contents="#!/bin/bash
exec node $pm2_entry \"\$@\""

  if [ -w "/usr/local/bin" ]; then
    printf "%s\n" "$cli_contents" > "$cli_path"
    chmod +x "$cli_path"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    printf "%s\n" "$cli_contents" | sudo -n tee "$cli_path" > /dev/null
    sudo -n chmod +x "$cli_path"
  else
    mkdir -p "$HOME/.local/bin"
    cli_path="$HOME/.local/bin/pm2"
    printf "%s\n" "$cli_contents" > "$cli_path"
    chmod +x "$cli_path"
  fi

  echo "pm2 installed at $cli_path"
}

# Fail fast per phase: the script's exit code must reflect the first failing
# phase, not the last phase, and callers invoke this via `bash <script>` so
# the shebang's -e does not apply.
run_phase "worker_install" install_worker || exit "$?"
run_phase "worker_cli_install" install_worker_cli || exit "$?"
run_phase "node_pty_install" ensure_node_pty || exit "$?"
run_phase "pm2_install" ensure_pm2 || exit "$?"
