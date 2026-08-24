#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
roomote_cli="$repo_root/deploy/host/roomote"
work_dir="$(mktemp -d)"
install_root="$work_dir/install"
custom_bin="$work_dir/custom-bin/docker"
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

env PATH='/usr/bin:/bin' \
  MOCK_DOCKER_LOG="$docker_log" \
  ROOMOTE_DOCKER_BIN="$custom_bin" \
  ROOMOTE_INSTALL_ROOT="$install_root" \
  ROOMOTE_TEST_MODE=true \
  "$roomote_cli" status

grep -Fq -- "compose --env-file $install_root/.env -f $install_root/docker-compose.prod.yml ps" "$docker_log"

printf 'Host CLI used the installer-provided Docker binary.\n'
