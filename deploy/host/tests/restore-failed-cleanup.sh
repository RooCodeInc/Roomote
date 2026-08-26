#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
roomote_cli="$repo_root/deploy/host/roomote"
work_dir="$(mktemp -d)"
install_root="$work_dir/install"
fake_bin="$work_dir/bin"
docker_log="$work_dir/docker.log"
output_log="$work_dir/output.log"
tmp_dir="$work_dir/tmp"
bundle="$work_dir/backup.roomote"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

mkdir -p "$install_root/backups" "$install_root/caddy" "$fake_bin" "$tmp_dir"
cat >"$install_root/.env" <<'EOF'
DATABASE_URL=postgres://roomote.example.invalid/roomote
S3_ENDPOINT=https://objects.example.invalid
S3_BUCKET_ARTIFACTS=roomote-artifacts
ROOMOTE_VERSION=restore-test
EOF
printf 'services: {}\n' >"$install_root/docker-compose.prod.yml"
printf 'test caddy configuration\n' >"$install_root/caddy/Caddyfile"

if ! command -v sha256sum >/dev/null 2>&1; then
  printf '#!/usr/bin/env bash\nexec shasum -a 256 "$@"\n' >"$fake_bin/sha256sum"
  chmod +x "$fake_bin/sha256sum"
fi

cat >"$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"$MOCK_DOCKER_LOG"

if [ "${1:-}" = 'compose' ]; then
  if [ "${MOCK_FAIL_DOWN:-}" = 'true' ]; then
    case " $* " in
      *' down '*) exit 1 ;;
    esac
  fi
  case " $* " in
    *' ps -aq '*) printf 'mock-container\n' ;;
  esac
  exit 0
fi

if [ "${1:-}" = 'inspect' ]; then
  printf 'mock-volume\n'
  exit 0
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

# The bundle should carry a source-host Docker path that does not exist here,
# to prove restore re-records the recovery host's binary.
printf 'ROOMOTE_DOCKER_BIN=/nonexistent/source-docker\n' >>"$install_root/.env"

# Create a valid bundle first (everything mocked to succeed). The environment
# override wins over the .env value, like the systemd unit's environment does.
env PATH="$fake_bin:$PATH" \
  MOCK_DOCKER_LOG="$docker_log" \
  TMPDIR="$tmp_dir" \
  ROOMOTE_BACKUP_PASSPHRASE='restore-cleanup-passphrase' \
  ROOMOTE_DOCKER_BIN="$fake_bin/docker" \
  ROOMOTE_INSTALL_ROOT="$install_root" \
  ROOMOTE_TEST_MODE=true \
  "$roomote_cli" backup --output "$bundle" >"$output_log" 2>&1

# A successful run must leave no passphrase temp files behind either.
if [ -n "$(ls -A "$tmp_dir")" ]; then
  printf 'backup left temp files behind: %s\n' "$(ls -A "$tmp_dir")" >&2
  exit 1
fi

# Now fail the restore partway (compose down) and check the EXIT trap.
set +e
env PATH="$fake_bin:$PATH" \
  MOCK_DOCKER_LOG="$docker_log" \
  MOCK_FAIL_DOWN=true \
  TMPDIR="$tmp_dir" \
  ROOMOTE_BACKUP_PASSPHRASE='restore-cleanup-passphrase' \
  ROOMOTE_DOCKER_BIN="$fake_bin/docker" \
  ROOMOTE_INSTALL_ROOT="$install_root" \
  ROOMOTE_TEST_MODE=true \
  "$roomote_cli" restore "$bundle" --yes >"$output_log" 2>&1
status=$?
set -e

[ "$status" -ne 0 ]
if grep -q 'unbound variable' "$output_log"; then
  printf 'restore cleanup referenced function-local state after shell exit\n' >&2
  exit 1
fi
if compgen -G "$install_root/backups/.restore-staging.*" >/dev/null; then
  printf 'restore staging directory (with decrypted postgres.sql) was not cleaned up\n' >&2
  exit 1
fi
if [ -n "$(ls -A "$tmp_dir")" ]; then
  printf 'restore left the passphrase temp file behind: %s\n' "$(ls -A "$tmp_dir")" >&2
  exit 1
fi

# A successful restore must re-record this host's Docker binary instead of
# keeping the source host's absolute path from the bundled .env.
env PATH="$fake_bin:$PATH" \
  MOCK_DOCKER_LOG="$docker_log" \
  TMPDIR="$tmp_dir" \
  ROOMOTE_BACKUP_PASSPHRASE='restore-cleanup-passphrase' \
  ROOMOTE_DOCKER_BIN="$fake_bin/docker" \
  ROOMOTE_INSTALL_ROOT="$install_root" \
  ROOMOTE_TEST_MODE=true \
  "$roomote_cli" restore "$bundle" --yes >"$output_log" 2>&1
grep -q 'Restore complete' "$output_log"
grep -Fq "ROOMOTE_DOCKER_BIN=$fake_bin/docker" "$install_root/.env"
if grep -q '/nonexistent/source-docker' "$install_root/.env"; then
  printf 'restore kept the source host Docker path in .env\n' >&2
  exit 1
fi

printf 'Failed restore cleaned up; successful restore re-recorded the Docker path.\n'
