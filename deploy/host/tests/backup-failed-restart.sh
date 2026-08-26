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
COMPOSE_FILE=docker-compose.prod.yml:docker-compose.caddy-dns.yml
EOF
printf 'services: {}\n' >"$install_root/docker-compose.prod.yml"
printf 'services: {}\n' >"$install_root/docker-compose.caddy-dns.yml"
printf 'test caddy configuration\n' >"$install_root/caddy/Caddyfile"
printf 'test passphrase\n' >"$passphrase_file"

# macOS has shasum but not sha256sum; give the CLI what it checks for.
if ! command -v sha256sum >/dev/null 2>&1; then
  printf '#!/usr/bin/env bash\nexec shasum -a 256 "$@"\n' >"$fake_bin/sha256sum"
  chmod +x "$fake_bin/sha256sum"
fi

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
# The interrupted-backup restart must include the registered override.
grep -Fq -- "-f $install_root/docker-compose.prod.yml -f $install_root/docker-compose.caddy-dns.yml up -d --wait --wait-timeout 600" "$docker_log"
if compgen -G "$install_root/backups/.backup-staging.*" >/dev/null; then
  printf 'backup staging directory was not cleaned up\n' >&2
  exit 1
fi

# The bundle written before the failed restart must contain the override.
tar_list="$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
  -pass "file:$passphrase_file" -in "$bundle" | tar -tzf -)"
printf '%s\n' "$tar_list" | grep -Fq 'config/compose-overrides/docker-compose.caddy-dns.yml'

printf 'Failed backup restart retained cleanup state, overrides, and staged them in the bundle.\n'
