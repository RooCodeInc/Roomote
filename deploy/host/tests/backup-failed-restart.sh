#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
roomote_cli="$repo_root/deploy/host/roomote"
work_dir="$(mktemp -d)"
install_root="$work_dir/install"
fake_bin="$work_dir/bin"
docker_log="$work_dir/docker.log"
output_log="$work_dir/output.log"
passphrase_file="$work_dir/passphrase"
bundle="$work_dir/backup.roomote"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

mkdir -p "$install_root/backups" "$install_root/caddy" "$fake_bin"
cat >"$install_root/.env" <<'EOF'
DATABASE_URL=postgres://roomote.example.invalid/roomote
S3_ENDPOINT=https://objects.example.invalid
S3_BUCKET_ARTIFACTS=roomote-artifacts
ROOMOTE_VERSION=backup-test
EOF
printf 'services: {}\n' >"$install_root/docker-compose.prod.yml"
printf 'services: {}\n' >"$install_root/docker-compose.caddy-dns.yml"
printf 'test caddy configuration\n' >"$install_root/caddy/Caddyfile"
printf 'test passphrase\n' >"$passphrase_file"

cat >"$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"$MOCK_DOCKER_LOG"

if [ "${1:-}" = 'compose' ]; then
  case " $* " in
    *' config --images '*) exit 0 ;;
    *' up -d --wait --wait-timeout 600 '*) exit 1 ;;
    *) exit 0 ;;
  esac
fi

if [ "${1:-}" = 'ps' ]; then
  exit 0
fi

if [ "${1:-}" = 'run' ]; then
  case "$*" in
    *pg_dump*) printf '%s\n' '-- database dump' ;;
    *'SELECT hash'*) printf '%s\n' 'migration-hash' ;;
  esac
fi
EOF
chmod +x "$fake_bin/docker"

set +e
env PATH="$fake_bin:$PATH" \
  MOCK_DOCKER_LOG="$docker_log" \
  ROOMOTE_INSTALL_ROOT="$install_root" \
  ROOMOTE_TEST_MODE=true \
  "$roomote_cli" backup --passphrase-file "$passphrase_file" --output "$bundle" >"$output_log" 2>&1
status=$?
set -e

[ "$status" -ne 0 ]
grep -q 'Restarting Roomote after interrupted backup' "$output_log"
if grep -q 'unbound variable' "$output_log"; then
  printf 'backup cleanup referenced function-local state after shell exit\n' >&2
  exit 1
fi
grep -Fq -- "-f $install_root/docker-compose.prod.yml -f $install_root/docker-compose.caddy-dns.yml up -d --wait --wait-timeout 600" "$docker_log"

printf 'Failed backup restart retained cleanup state and Compose overrides.\n'
