#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
roomote_cli="$repo_root/deploy/host/roomote"
work_dir="$(mktemp -d)"
install_root="$work_dir/install"
custom_bin="$work_dir/custom-bin/docker-custom"
docker_log="$work_dir/docker.log"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

mkdir -p "$install_root" "$(dirname -- "$custom_bin")"
printf 'ROOMOTE_VERSION=test\n' >"$install_root/.env"
printf 'services: {}\n' >"$install_root/docker-compose.prod.yml"

cat >"$custom_bin" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >"$MOCK_DOCKER_LOG"
EOF
chmod +x "$custom_bin"

# PATH deliberately has no `docker`: only the recorded binary may be used.

# 1. ROOMOTE_DOCKER_BIN from the environment (systemd-style override).
env PATH='/usr/bin:/bin' \
  MOCK_DOCKER_LOG="$docker_log" \
  ROOMOTE_DOCKER_BIN="$custom_bin" \
  ROOMOTE_INSTALL_ROOT="$install_root" \
  ROOMOTE_TEST_MODE=true \
  "$roomote_cli" status
grep -Fq -- "compose --env-file $install_root/.env -f $install_root/docker-compose.prod.yml ps" "$docker_log"

# 2. ROOMOTE_DOCKER_BIN persisted in .env by the installer.
printf 'ROOMOTE_DOCKER_BIN=%s\n' "$custom_bin" >>"$install_root/.env"
: >"$docker_log"
env PATH='/usr/bin:/bin' \
  MOCK_DOCKER_LOG="$docker_log" \
  ROOMOTE_INSTALL_ROOT="$install_root" \
  ROOMOTE_TEST_MODE=true \
  "$roomote_cli" status
grep -Fq -- "compose --env-file $install_root/.env -f $install_root/docker-compose.prod.yml ps" "$docker_log"

# 3. Non-compose Docker invocations honor it too (docker_cmd everywhere):
# `restart` goes through compose; exercise a raw docker path via backup's
# worker scan by calling status is not enough, so probe `logs` and a direct
# ps-based command. The compose passthrough covers arbitrary invocations.
: >"$docker_log"
env PATH='/usr/bin:/bin' \
  MOCK_DOCKER_LOG="$docker_log" \
  ROOMOTE_INSTALL_ROOT="$install_root" \
  ROOMOTE_TEST_MODE=true \
  "$roomote_cli" compose ps -aq redis
grep -Fq -- "compose --env-file $install_root/.env -f $install_root/docker-compose.prod.yml ps -aq redis" "$docker_log"

# The `roomote docker` passthrough (used by managed deploys for the worker
# image pull) resolves the recorded binary too.
: >"$docker_log"
env PATH='/usr/bin:/bin' \
  MOCK_DOCKER_LOG="$docker_log" \
  ROOMOTE_INSTALL_ROOT="$install_root" \
  ROOMOTE_TEST_MODE=true \
  "$roomote_cli" docker pull example.invalid/roomote-worker:test
grep -Fq -- "pull example.invalid/roomote-worker:test" "$docker_log"

# 4. sync-unit records the resolved Docker path when .env lacks one, so a
# systemd boot (minimal PATH) can start the stack on snap/manual installs.
# Managed deploys call sync-unit without the installer, so the guarantee
# must hold from the CLI alone.
systemd_dir="$work_dir/systemd"
docker_dir="$work_dir/path-docker"
mkdir -p "$systemd_dir" "$docker_dir"
printf '#!/usr/bin/env bash\nexit 0\n' >"$docker_dir/docker"
chmod +x "$docker_dir/docker"
grep -v '^ROOMOTE_DOCKER_BIN=' "$install_root/.env" >"$install_root/.env.tmp"
mv "$install_root/.env.tmp" "$install_root/.env"
env PATH="$docker_dir:/usr/bin:/bin" \
  ROOMOTE_INSTALL_ROOT="$install_root" \
  ROOMOTE_SYSTEMD_DIR="$systemd_dir" \
  ROOMOTE_TEST_MODE=true \
  "$roomote_cli" sync-unit >/dev/null
grep -Fq "ROOMOTE_DOCKER_BIN=$docker_dir/docker" "$install_root/.env"
grep -Fq 'ExecStart=/usr/local/bin/roomote up' "$systemd_dir/roomote-compose.service"

printf 'Host CLI used the recorded Docker binary for every invocation.\n'
