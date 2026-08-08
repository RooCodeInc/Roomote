#!/bin/bash
set -euo pipefail

# Shared browser automation installer.
#
# This script is the source of truth for installing or repairing the
# agent-browser runtime plus Roomote's wrapper behavior. It is used in two
# places:
#   1. Worker image builds (Dockerfiles) to prebake browser automation.
#   2. Worker setup compatibility fallbacks on older Linux images.

AGENT_BROWSER_VERSION="${AGENT_BROWSER_VERSION:-0.27.0}"
AGENT_BROWSER_INSTALL_ROOT="${AGENT_BROWSER_INSTALL_ROOT:-/opt/agent-browser}"
AGENT_BROWSER_EXECUTABLE_PATH="${AGENT_BROWSER_EXECUTABLE_PATH:-${AGENT_BROWSER_INSTALL_ROOT}/chrome}"
AGENT_BROWSER_SAVED_CLI_PATH="${AGENT_BROWSER_SAVED_CLI_PATH:-${AGENT_BROWSER_INSTALL_ROOT}/.cli-path}"
AGENT_BROWSER_INSTALL_MARKER="${AGENT_BROWSER_INSTALL_MARKER:-${AGENT_BROWSER_INSTALL_ROOT}/.installed}"
AGENT_BROWSER_SYSTEM_WRAPPER_PATH="${AGENT_BROWSER_SYSTEM_WRAPPER_PATH:-/usr/local/bin/agent-browser}"
AGENT_BROWSER_USER_WRAPPER_PATH="${AGENT_BROWSER_USER_WRAPPER_PATH:-${HOME}/.local/bin/agent-browser}"

is_executable_file() {
  local file_path="$1"
  [ -x "$file_path" ]
}

is_agent_browser_wrapper_script() {
  local file_path="$1"

  if [ ! -f "$file_path" ]; then
    return 1
  fi

  grep -q 'agent-browser wrapper: failed to resolve real CLI' "$file_path"
}

resolve_command_path() {
  local command_name="$1"
  command -v "$command_name" 2>/dev/null || true
}

resolve_global_npm_binary_path() {
  local binary_name="$1"
  local npm_prefix
  npm_prefix="$(npm prefix -g 2>/dev/null || true)"

  if [ -z "$npm_prefix" ]; then
    return 0
  fi

  local candidate_path="${npm_prefix}/bin/${binary_name}"

  if is_executable_file "$candidate_path"; then
    printf '%s\n' "$candidate_path"
  fi

  return 0
}

parse_agent_browser_version() {
  local output="$1"
  printf '%s\n' "$output" | grep -Eo '[0-9]+(\.[0-9]+)+' | head -n 1 || true
}

compare_numeric_dot_versions() {
  local left="$1"
  local right="$2"

  python3 - "$left" "$right" <<'PY'
import sys

left = [int(part) for part in sys.argv[1].split('.')]
right = [int(part) for part in sys.argv[2].split('.')]
length = max(len(left), len(right))

left.extend([0] * (length - len(left)))
right.extend([0] * (length - len(right)))

if left < right:
    print(-1)
elif left > right:
    print(1)
else:
    print(0)
PY
}

is_agent_browser_version_older() {
  local installed_version="${1:-}"
  local target_version="$2"

  if [ -z "$installed_version" ]; then
    return 1
  fi

  local compare_result
  compare_result="$(compare_numeric_dot_versions "$installed_version" "$target_version")"

  [ "$compare_result" = "-1" ]
}

read_text_file() {
  local file_path="$1"

  if [ -f "$file_path" ]; then
    tr -d '\r\n' < "$file_path"
  fi

  return 0
}

find_real_agent_browser_cli_path() {
  local saved_cli_path
  saved_cli_path="$(read_text_file "$AGENT_BROWSER_SAVED_CLI_PATH")"

  if [ -n "$saved_cli_path" ] && is_executable_file "$saved_cli_path"; then
    printf '%s\n' "$saved_cli_path"
    return 0
  fi

  local global_binary_path
  global_binary_path="$(resolve_global_npm_binary_path 'agent-browser')"

  if [ -n "$global_binary_path" ] && ! is_agent_browser_wrapper_script "$global_binary_path"; then
    printf '%s\n' "$global_binary_path"
    return 0
  fi

  local command_path
  command_path="$(resolve_command_path 'agent-browser')"

  if [ -n "$command_path" ] && ! is_agent_browser_wrapper_script "$command_path"; then
    printf '%s\n' "$command_path"
  fi

  return 0
}

resolve_agent_browser_cli_version() {
  local real_cli_path="$1"
  local output

  if [ -z "$real_cli_path" ] || ! is_executable_file "$real_cli_path"; then
    return 0
  fi

  output="$("$real_cli_path" --version 2>&1 || true)"
  parse_agent_browser_version "$output"

  return 0
}

resolve_installed_agent_browser_version() {
  local real_cli_path="$1"
  local cli_version
  cli_version="$(resolve_agent_browser_cli_version "$real_cli_path")"

  if [ -n "$cli_version" ]; then
    printf '%s\n' "$cli_version"
    return 0
  fi

  local marker_version
  marker_version="$(read_text_file "$AGENT_BROWSER_INSTALL_MARKER")"

  if [ -n "$marker_version" ]; then
    parse_agent_browser_version "$marker_version"
  fi

  return 0
}

find_installed_chrome_binary_path() {
  find "${HOME}/.agent-browser/browsers" -mindepth 2 -type f -name chrome 2>/dev/null \
    | sort -V \
    | tail -n 1 || true
}

find_installed_playwright_chrome_binary_path() {
  find "${HOME}/.cache/ms-playwright" -mindepth 2 -type f -name chrome 2>/dev/null \
    | sort -V \
    | tail -n 1 || true
}

# Chrome for Testing (what `agent-browser install` downloads) publishes no
# Linux arm64 builds, so arm64 hosts install Playwright's Chromium instead.
# The rest of the flow is unchanged: the resolved binary is symlinked to
# AGENT_BROWSER_EXECUTABLE_PATH, which the wrapper exports to the CLI.
AGENT_BROWSER_PLAYWRIGHT_VERSION="${AGENT_BROWSER_PLAYWRIGHT_VERSION:-1.57.0}"

install_browser_binary() {
  local real_cli_path="$1"

  case "$(uname -m)" in
    aarch64 | arm64)
      # Progress output goes to stderr so stdout carries only the path.
      npx -y "playwright@${AGENT_BROWSER_PLAYWRIGHT_VERSION}" install --with-deps chromium >&2
      find_installed_playwright_chrome_binary_path
      ;;
    *)
      "$real_cli_path" install --with-deps >&2
      find_installed_chrome_binary_path
      ;;
  esac
}

ensure_owned_directory() {
  local dir_path="$1"

  if mkdir -p "$dir_path" 2>/dev/null; then
    return 0
  fi

  sudo -n mkdir -p "$dir_path"
  sudo -n chown -R "$(id -un):$(id -gn)" "$dir_path"
}

write_text_file() {
  local file_path="$1"
  local allow_sudo="${2:-false}"

  if [ "$allow_sudo" = "true" ]; then
    sudo -n tee "$file_path" > /dev/null
    return 0
  fi

  if cat > "$file_path"; then
    return 0
  fi

  return 1
}

write_agent_browser_wrapper() {
  cat <<'EOF_WRAPPER'
#!/bin/bash
set -euo pipefail

DEFAULT_AUTH_BYPASS_HEADER_NAME="x-bypass-roomote-auth"
HIDE_PREVIEW_WIDGET_COOKIE="roomote_hide_preview_widget"
CACHE_ROOT="/tmp/agent-browser-cookie-seed"
AGENT_BROWSER_BIN=""
AGENT_BROWSER_SESSION_VALUE="${AGENT_BROWSER_SESSION:-default}"
AGENT_BROWSER_COMMAND=""
AGENT_BROWSER_SUBCOMMAND=""
AGENT_BROWSER_PREFIX_ARGS=()
AGENT_BROWSER_EXEC_ARGS=()
AGENT_BROWSER_FORWARD_ARGS=()

resolve_cli_paths() {
  if [ -n "$AGENT_BROWSER_BIN" ]; then
    return
  fi

  local saved_path="/opt/agent-browser/.cli-path"
  if [ -f "$saved_path" ]; then
    AGENT_BROWSER_BIN="$(cat "$saved_path")"
    if [ -n "$AGENT_BROWSER_BIN" ] && [ -x "$AGENT_BROWSER_BIN" ]; then
      return
    fi
    AGENT_BROWSER_BIN=""
  fi

  local npm_prefix
  npm_prefix="$(npm prefix -g 2>/dev/null || true)"
  AGENT_BROWSER_BIN="${npm_prefix:+$npm_prefix/bin/agent-browser}"

  if [ -z "$AGENT_BROWSER_BIN" ] || [ ! -x "$AGENT_BROWSER_BIN" ]; then
    echo "agent-browser wrapper: failed to resolve real CLI" >&2
    exit 1
  fi
}

hash_value() {
  printf '%s' "$1" | sha256sum | awk '{print $1}'
}

scan_remaining_args_for_session() {
  local args=("$@")
  local i=0

  while [ "$i" -lt "${#args[@]}" ]; do
    local arg="${args[$i]}"

    case "$arg" in
      --session)
        AGENT_BROWSER_PREFIX_ARGS+=("$arg")
        i=$((i + 1))
        if [ "$i" -lt "${#args[@]}" ]; then
          AGENT_BROWSER_SESSION_VALUE="${args[$i]}"
          AGENT_BROWSER_PREFIX_ARGS+=("${args[$i]}")
        fi
        ;;
      --session=*)
        AGENT_BROWSER_SESSION_VALUE="${arg#*=}"
        AGENT_BROWSER_PREFIX_ARGS+=("$arg")
        ;;
    esac

    i=$((i + 1))
  done
}

parse_cli_context() {
  local args=("$@")
  local i=0
  AGENT_BROWSER_PREFIX_ARGS=()

  while [ "$i" -lt "${#args[@]}" ]; do
    local arg="${args[$i]}"

    case "$arg" in
      --session)
        AGENT_BROWSER_PREFIX_ARGS+=("$arg")
        i=$((i + 1))
        if [ "$i" -lt "${#args[@]}" ]; then
          AGENT_BROWSER_SESSION_VALUE="${args[$i]}"
          AGENT_BROWSER_PREFIX_ARGS+=("${args[$i]}")
        fi
        ;;
      --session=*)
        AGENT_BROWSER_SESSION_VALUE="${arg#*=}"
        AGENT_BROWSER_PREFIX_ARGS+=("$arg")
        ;;
      --profile|--session-name|--state|--headers|--user-agent|--proxy|--proxy-bypass|--provider|--device|--cdp|--color-scheme|--download-path|--max-output|--allowed-domains|--action-policy|--confirm-actions|--engine|--config|--extension|--executable-path|-p|-d|-s)
        AGENT_BROWSER_PREFIX_ARGS+=("$arg")
        i=$((i + 1))
        if [ "$i" -lt "${#args[@]}" ]; then
          AGENT_BROWSER_PREFIX_ARGS+=("${args[$i]}")
        fi
        ;;
      --profile=*|--session-name=*|--state=*|--headers=*|--user-agent=*|--proxy=*|--proxy-bypass=*|--provider=*|--device=*|--cdp=*|--color-scheme=*|--download-path=*|--max-output=*|--allowed-domains=*|--action-policy=*|--confirm-actions=*|--engine=*|--config=*|--extension=*|--executable-path=*)
        AGENT_BROWSER_PREFIX_ARGS+=("$arg")
        ;;
      --headed|--json|--full|-f|--annotate|--ignore-https-errors|--allow-file-access|--content-boundaries|--native|--debug|--version|-V|--auto-connect|--confirm-interactive|-i|-c)
        AGENT_BROWSER_PREFIX_ARGS+=("$arg")
        if [ "$i" -lt $(( ${#args[@]} - 1 )) ]; then
          case "${args[$((i + 1))]}" in
            true|false)
              i=$((i + 1))
              AGENT_BROWSER_PREFIX_ARGS+=("${args[$i]}")
              ;;
          esac
        fi
        ;;
      --*)
        AGENT_BROWSER_PREFIX_ARGS+=("$arg")
        if [ "$i" -lt $(( ${#args[@]} - 1 )) ]; then
          case "${args[$((i + 1))]}" in
            true|false)
              i=$((i + 1))
              AGENT_BROWSER_PREFIX_ARGS+=("${args[$i]}")
              ;;
          esac
        fi
        ;;
      -*)
        AGENT_BROWSER_PREFIX_ARGS+=("$arg")
        ;;
      *)
        AGENT_BROWSER_COMMAND="$arg"
        if [ "$i" -lt $(( ${#args[@]} - 1 )) ]; then
          AGENT_BROWSER_SUBCOMMAND="${args[$((i + 1))]}"
          scan_remaining_args_for_session "${args[@]:$((i + 1))}"
        fi
        break
        ;;
    esac

    i=$((i + 1))
  done
}

collect_cli_browser_args() {
  local args=("$@")
  local i=0
  AGENT_BROWSER_EXEC_ARGS=()
  AGENT_BROWSER_FORWARD_ARGS=()
  # Default headless; a caller may opt a single invocation into headed mode
  # (e.g. the feature-demo capture runner, so GPU-backed canvases present to
  # the compositor). On displayless Linux agent-browser auto-starts Xvfb.
  AGENT_BROWSER_WANT_HEADED=0

  while [ "$i" -lt "${#args[@]}" ]; do
    local arg="${args[$i]}"

    case "$arg" in
      --headed)
        AGENT_BROWSER_WANT_HEADED=1
        AGENT_BROWSER_FORWARD_ARGS+=("$arg")
        if [ "$i" -lt $(( ${#args[@]} - 1 )) ]; then
          case "${args[$((i + 1))]}" in
            true|false)
              i=$((i + 1))
              [ "${args[$i]}" = false ] && AGENT_BROWSER_WANT_HEADED=0
              AGENT_BROWSER_FORWARD_ARGS+=("${args[$i]}")
              ;;
          esac
        fi
        ;;
      --headed=false)
        AGENT_BROWSER_WANT_HEADED=0
        AGENT_BROWSER_FORWARD_ARGS+=("$arg")
        ;;
      --headed=*)
        AGENT_BROWSER_WANT_HEADED=1
        AGENT_BROWSER_FORWARD_ARGS+=("$arg")
        ;;
      --args)
        AGENT_BROWSER_FORWARD_ARGS+=("$arg")
        i=$((i + 1))
        if [ "$i" -lt "${#args[@]}" ]; then
          AGENT_BROWSER_FORWARD_ARGS+=("${args[$i]}")
        fi
        ;;
      --args=*)
        AGENT_BROWSER_FORWARD_ARGS+=("$arg")
        ;;
      *)
        AGENT_BROWSER_EXEC_ARGS+=("$arg")
        AGENT_BROWSER_FORWARD_ARGS+=("$arg")
        ;;
    esac

    i=$((i + 1))
  done
}

should_seed_preview_cookies() {
  case "$AGENT_BROWSER_COMMAND" in
    open|goto|navigate)
      return 0
      ;;
    record)
      case "$AGENT_BROWSER_SUBCOMMAND" in
        start|restart)
          return 0
          ;;
      esac
      ;;
  esac

  return 1
}

should_clear_seed_cache() {
  case "$AGENT_BROWSER_COMMAND" in
    close|quit|exit)
      return 0
      ;;
  esac

  return 1
}

collect_preview_urls() {
  local name value
  while IFS='=' read -r name value; do
    case "$name" in
      ROOMOTE_EDITOR_HOST|ROOMOTE_SANDBOX_SERVER_HOST)
        continue
        ;;
      ROOMOTE_*_HOST)
        case "$value" in
          http://*|https://*)
            printf '%s\n' "$value"
            ;;
        esac
        ;;
    esac
  done < <(env | LC_ALL=C sort)
}

clear_seed_cache() {
  local session_hash
  session_hash="$(hash_value "$AGENT_BROWSER_SESSION_VALUE")"
  mkdir -p "$CACHE_ROOT"
  rm -f "$CACHE_ROOT/${session_hash}-"* 2>/dev/null || true
}

seed_preview_cookies() {
  mapfile -t preview_urls < <(collect_preview_urls | awk '!seen[$0]++')

  if [ "${#preview_urls[@]}" -eq 0 ]; then
    return 0
  fi

  local bypass_value="${ROOMOTE_AUTH_BYPASS_VALUE:-}"
  local header_name="${ROOMOTE_AUTH_BYPASS_HEADER_NAME:-$DEFAULT_AUTH_BYPASS_HEADER_NAME}"
  local cache_key
  local session_hash
  local cache_file
  local url

  cache_key="$(printf '%s\0' "$AGENT_BROWSER_SESSION_VALUE" "$header_name" "$bypass_value" "${AGENT_BROWSER_PREFIX_ARGS[*]}" "${preview_urls[@]}" | sha256sum | awk '{print $1}')"
  session_hash="$(hash_value "$AGENT_BROWSER_SESSION_VALUE")"
  cache_file="$CACHE_ROOT/${session_hash}-${cache_key}"

  if [ -f "$cache_file" ]; then
    return 0
  fi

  mkdir -p "$CACHE_ROOT"
  resolve_cli_paths

  for url in "${preview_urls[@]}"; do
    if [ -n "$bypass_value" ]; then
      AGENT_BROWSER_HEADED=false "$AGENT_BROWSER_BIN" "${AGENT_BROWSER_PREFIX_ARGS[@]}" cookies set "$header_name" "$bypass_value" --url "$url" --secure --sameSite Lax >/dev/null
    fi

    AGENT_BROWSER_HEADED=false "$AGENT_BROWSER_BIN" "${AGENT_BROWSER_PREFIX_ARGS[@]}" cookies set "$HIDE_PREVIEW_WIDGET_COOKIE" "1" --url "$url" --secure --sameSite Lax >/dev/null
  done

  : > "$cache_file"
}

export AGENT_BROWSER_EXECUTABLE_PATH="${AGENT_BROWSER_EXECUTABLE_PATH:-/opt/agent-browser/chrome}"

collect_cli_browser_args "$@"
parse_cli_context "${AGENT_BROWSER_EXEC_ARGS[@]}"

if should_seed_preview_cookies; then
  seed_preview_cookies
fi

if should_clear_seed_cache; then
  clear_seed_cache
fi

resolve_cli_paths
# Preview-cookie seeding above always runs headless (inline env). The task
# command itself honors an explicit --headed opt-in; everything else stays
# headless as before.
if [ "${AGENT_BROWSER_WANT_HEADED:-0}" = 1 ]; then
  export AGENT_BROWSER_HEADED=true
else
  export AGENT_BROWSER_HEADED=false
fi
exec "$AGENT_BROWSER_BIN" "${AGENT_BROWSER_FORWARD_ARGS[@]}"
EOF_WRAPPER
}

install_agent_browser_wrappers() {
  local real_cli_path="$1"

  ensure_owned_directory "$(dirname "$AGENT_BROWSER_USER_WRAPPER_PATH")"

  if [ "$real_cli_path" != "$AGENT_BROWSER_USER_WRAPPER_PATH" ]; then
    write_agent_browser_wrapper | write_text_file "$AGENT_BROWSER_USER_WRAPPER_PATH"
    chmod +x "$AGENT_BROWSER_USER_WRAPPER_PATH"
  fi

  if [ "$real_cli_path" != "$AGENT_BROWSER_SYSTEM_WRAPPER_PATH" ]; then
    if [ -w "$(dirname "$AGENT_BROWSER_SYSTEM_WRAPPER_PATH")" ]; then
      write_agent_browser_wrapper | write_text_file "$AGENT_BROWSER_SYSTEM_WRAPPER_PATH"
      chmod +x "$AGENT_BROWSER_SYSTEM_WRAPPER_PATH"
    elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      write_agent_browser_wrapper | write_text_file "$AGENT_BROWSER_SYSTEM_WRAPPER_PATH" true
      sudo -n chmod +x "$AGENT_BROWSER_SYSTEM_WRAPPER_PATH"
    fi
  fi

  if ! grep -q 'AGENT_BROWSER_EXECUTABLE_PATH' "${HOME}/.bashrc" 2>/dev/null; then
    printf 'export AGENT_BROWSER_EXECUTABLE_PATH=%s\n' "$AGENT_BROWSER_EXECUTABLE_PATH" >> "${HOME}/.bashrc"
  fi
}

# Chromium's GPU child process drops all capabilities, so it is subject to
# normal permission bits when loading bundled Vulkan/SwiftShader libs under
# $HOME/.agent-browser. Allow others execute (traverse-only) on $HOME so the
# GPU process can reach those libraries. Files under $HOME keep their own
# modes; this repairs older snapshots still shipped with a 750 home from
# useradd.
ensure_home_dir_traversable_for_gpu_process() {
  local home_dir="${HOME:-}"
  local mode

  if [ -z "$home_dir" ] || [ ! -d "$home_dir" ]; then
    return 0
  fi

  mode="$(stat -c '%a' "$home_dir" 2>/dev/null || true)"
  case "${mode: -1}" in
    1|3|5|7)
      return 0
      ;;
  esac

  chmod o+x "$home_dir" 2>/dev/null || true
}

main() {
  ensure_owned_directory "$AGENT_BROWSER_INSTALL_ROOT"
  ensure_home_dir_traversable_for_gpu_process

  local real_cli_path
  real_cli_path="$(find_real_agent_browser_cli_path)"

  local installed_version=""
  installed_version="$(resolve_installed_agent_browser_version "$real_cli_path")"

  local browser_ready=false
  if is_executable_file "$AGENT_BROWSER_EXECUTABLE_PATH" && [ -n "$real_cli_path" ]; then
    browser_ready=true
  fi

  local needs_upgrade=false
  if is_agent_browser_version_older "$installed_version" "$AGENT_BROWSER_VERSION"; then
    needs_upgrade=true
  fi

  if [ "$browser_ready" = false ] || [ "$needs_upgrade" = true ]; then
    npm install -g "agent-browser@${AGENT_BROWSER_VERSION}"

    real_cli_path="$(resolve_global_npm_binary_path 'agent-browser')"

    if [ -z "$real_cli_path" ]; then
      echo "agent-browser install: npm global binary was not found" >&2
      exit 1
    fi

    local browser_binary_path
    browser_binary_path="$(install_browser_binary "$real_cli_path")"

    if [ -z "$browser_binary_path" ] || ! is_executable_file "$browser_binary_path"; then
      echo "agent-browser install: installed Chrome binary was not found" >&2
      exit 1
    fi

    ln -sf "$browser_binary_path" "$AGENT_BROWSER_EXECUTABLE_PATH"
    printf '%s\n' "$AGENT_BROWSER_VERSION" > "$AGENT_BROWSER_INSTALL_MARKER"
  fi

  real_cli_path="$(find_real_agent_browser_cli_path)"

  if [ -z "$real_cli_path" ]; then
    echo "agent-browser install: failed to resolve real CLI after install/repair" >&2
    exit 1
  fi

  printf '%s\n' "$real_cli_path" > "$AGENT_BROWSER_SAVED_CLI_PATH"
  install_agent_browser_wrappers "$real_cli_path"
}

main "$@"
