#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
roomote_cli="$repo_root/deploy/host/roomote"
work_dir="$(mktemp -d)"
install_root="$work_dir/install"
fake_bin="$work_dir/bin"
docker_log="$work_dir/docker.log"
output_log="$work_dir/output.log"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

mkdir -p "$install_root/backups" "$install_root/caddy" "$fake_bin"
cat >"$install_root/.env" <<'EOF'
ROOMOTE_REPO=RooCodeInc/Roomote
ROOMOTE_VERSION=v1.0.0
ROOMOTE_PREVIOUS_VERSION=v0.9.0
ROOMOTE_APP_DOMAIN=roomote.example.com
IMAGE_REGISTRY=ghcr.io
IMAGE_NAMESPACE=roocodeinc
DOCKER_WORKER_IMAGE=ghcr.io/roocodeinc/roomote-worker:v1.0.0
MODAL_BASE_IMAGE_REF=ghcr.io/roocodeinc/roomote-worker:v1.0.0
R_DISCORD_GATEWAY_SECRET=test-secret
EOF
printf 'original compose\n' >"$install_root/docker-compose.prod.yml"
printf 'custom caddy override\n' >"$install_root/docker-compose.caddy-dns.yml"
printf 'original caddy\n' >"$install_root/caddy/Caddyfile"
cp "$install_root/.env" "$work_dir/original.env"
cp "$install_root/docker-compose.prod.yml" "$work_dir/original-compose.yml"
cp "$install_root/caddy/Caddyfile" "$work_dir/original-Caddyfile"

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
  *) exit 1 ;;
esac
EOF

cat >"$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"$MOCK_DOCKER_LOG"
if [ "${1:-}" = 'compose' ] && [ "${*: -1}" = 'pull' ]; then
  exit 1
fi
EOF

chmod +x "$fake_bin/curl" "$fake_bin/docker"

set +e
env PATH="$fake_bin:$PATH" \
  MOCK_DOCKER_LOG="$docker_log" \
  ROOMOTE_FETCH_BASE='https://example.invalid' \
  ROOMOTE_INSTALL_ROOT="$install_root" \
  ROOMOTE_TEST_MODE=true \
  "$roomote_cli" upgrade missing-tag --skip-backup >"$output_log" 2>&1
status=$?
set -e

[ "$status" -ne 0 ]
cmp "$work_dir/original.env" "$install_root/.env"
cmp "$work_dir/original-compose.yml" "$install_root/docker-compose.prod.yml"
cmp "$work_dir/original-Caddyfile" "$install_root/caddy/Caddyfile"
grep -q '^compose .* start controller$' "$docker_log"
grep -Fq -- "-f $install_root/docker-compose.prod.yml -f $install_root/docker-compose.caddy-dns.yml config" "$docker_log"
grep -Fq -- "-f $install_root/docker-compose.prod.yml -f $install_root/docker-compose.caddy-dns.yml pull" "$docker_log"
grep -q 'Upgrade failed; restoring the previous deployment configuration' "$output_log"
if compgen -G "$install_root/backups/.upgrade-staging.*" >/dev/null; then
  printf 'upgrade staging directory was not cleaned up\n' >&2
  exit 1
fi

printf 'Failed image pull preserved the deployed release metadata.\n'
