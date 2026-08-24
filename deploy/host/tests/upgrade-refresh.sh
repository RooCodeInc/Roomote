#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
roomote_cli="$repo_root/deploy/host/roomote"
work_dir="$(mktemp -d)"
install_root="$work_dir/install"
fake_bin="$work_dir/bin"
cli_path="$work_dir/cli/roomote"
systemd_dir="$work_dir/systemd"
docker_log="$work_dir/docker.log"
output_log="$work_dir/output.log"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

mkdir -p "$install_root/backups" "$install_root/caddy" "$fake_bin" \
  "$(dirname -- "$cli_path")" "$systemd_dir"
cat >"$install_root/.env" <<'EOF'
ROOMOTE_REPO=RooCodeInc/Roomote
ROOMOTE_VERSION=v1.0.0
ROOMOTE_APP_DOMAIN=roomote.example.com
IMAGE_REGISTRY=ghcr.io
IMAGE_NAMESPACE=roocodeinc
DOCKER_WORKER_IMAGE=ghcr.io/roocodeinc/roomote-worker:v1.0.0
MODAL_BASE_IMAGE_REF=ghcr.io/roocodeinc/roomote-worker:v1.0.0
R_DISCORD_GATEWAY_SECRET=test-secret
COMPOSE_FILE=docker-compose.prod.yml:docker-compose.caddy-dns.yml
EOF
printf 'original compose\n' >"$install_root/docker-compose.prod.yml"
printf 'custom caddy override\n' >"$install_root/docker-compose.caddy-dns.yml"
printf 'original caddy\n' >"$install_root/caddy/Caddyfile"
cp "$install_root/docker-compose.caddy-dns.yml" "$work_dir/original-override.yml"
printf '#!/usr/bin/env bash\nexit 0\n' >"$cli_path"
chmod +x "$cli_path"
printf 'old unit with direct docker compose ExecStart\n' >"$systemd_dir/roomote-compose.service"

cat >"$fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

output=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      output="$2"
      shift 2
      ;;
    http*)
      url="$1"
      shift
      ;;
    *) shift ;;
  esac
done

case "$url" in
  */docker-compose.prod.yml) printf 'refreshed compose\n' >"$output" ;;
  */Caddyfile) printf 'refreshed caddy\n' >"$output" ;;
  */deploy/host/roomote) cat "$MOCK_REAL_CLI" >"$output" ;;
  *) exit 1 ;;
esac
EOF

cat >"$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$MOCK_DOCKER_LOG"
EOF

chmod +x "$fake_bin/curl" "$fake_bin/docker"

env PATH="$fake_bin:$PATH" \
  MOCK_DOCKER_LOG="$docker_log" \
  MOCK_REAL_CLI="$roomote_cli" \
  ROOMOTE_FETCH_BASE='https://example.invalid' \
  ROOMOTE_INSTALL_ROOT="$install_root" \
  ROOMOTE_CLI_PATH="$cli_path" \
  ROOMOTE_SYSTEMD_DIR="$systemd_dir" \
  ROOMOTE_TEST_MODE=true \
  "$roomote_cli" upgrade v1.1.0 --skip-backup >"$output_log" 2>&1

# The upgrade must deliver the new CLI and rewrite the systemd unit.
cmp "$roomote_cli" "$cli_path"
grep -Fq "ExecStart=$cli_path up" "$systemd_dir/roomote-compose.service"
grep -Fq "ExecStop=$cli_path down" "$systemd_dir/roomote-compose.service"
grep -Fq "ROOMOTE_INSTALL_ROOT=$install_root" "$systemd_dir/roomote-compose.service"
if grep -q 'direct docker compose ExecStart' "$systemd_dir/roomote-compose.service"; then
  printf 'old systemd unit content survived the upgrade\n' >&2
  exit 1
fi

# Operator override survives and is part of the final start.
cmp "$work_dir/original-override.yml" "$install_root/docker-compose.caddy-dns.yml"
grep -Fq -- "-f $install_root/docker-compose.prod.yml -f $install_root/docker-compose.caddy-dns.yml up -d --wait --wait-timeout 600" "$docker_log"
grep -Fq -- "-f $install_root/docker-compose.prod.yml -f $install_root/docker-compose.caddy-dns.yml pull" "$docker_log"

# Migration seeding for pre-registry installs (values already present are kept).
grep -Fq 'COMPOSE_FILE=docker-compose.prod.yml:docker-compose.caddy-dns.yml' "$install_root/.env"
grep -Eq '^ROOMOTE_DOCKER_BIN=' "$install_root/.env"
grep -Fq 'ROOMOTE_VERSION=v1.1.0' "$install_root/.env"

printf 'Upgrade refreshed the host CLI and systemd unit and preserved overrides.\n'
