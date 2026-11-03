#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
roomote_cli="$repo_root/deploy/host/roomote"
work_dir="$(mktemp -d)"
fake_bin="$work_dir/bin"
passphrase_file="$work_dir/passphrase"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

mkdir -p "$fake_bin"
printf 'correct horse battery staple\n' >"$passphrase_file"

cat >"$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = compose ]; then
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env-file | -f) shift 2 ;;
      *) break ;;
    esac
  done
  case "${1:-} ${2:-} ${3:-}" in
    'config --images '*) printf 'example/roomote:backup-test\n' ;;
    'ps -aq gbrain') printf 'gbrain-container\n' ;;
  esac
  exit 0
fi

if [ "${1:-}" = ps ]; then
  exit 0
fi

if [ "${1:-} ${2:-}" = 'image inspect' ]; then
  case "$*" in
    *RepoDigests*) printf 'example/roomote@sha256:abc\n' ;;
    *'{{.Id}}'*) printf 'sha256:abc\n' ;;
  esac
  exit 0
fi

if [ "${1:-}" = inspect ]; then
  printf 'gbrain-data-volume\n'
  exit 0
fi

if [ "${1:-}" = run ]; then
  command_text="${*: -1}"
  case "$command_text" in
    *'SELECT 1 FROM pg_database'*)
      case "$MOCK_PROBE_MODE" in
        present) printf '1\n' ;;
        absent) ;;
        error) exit 42 ;;
      esac
      exit 0
      ;;
    *'GBRAIN_URL'*'pg_dump --clean'*)
      printf '%s\n' '-- Brain database dump'
      exit 0
      ;;
    *'SELECT hash FROM drizzle.__drizzle_migrations'*)
      printf 'schema-hash\n'
      exit 0
      ;;
    *'pg_dump --clean'*)
      printf '%s\n' '-- Roomote database dump'
      exit 0
      ;;
    *'tar -C /source -cf'*)
      staging_dir=''
      archive_name=''
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --volume)
            case "$2" in *:/backup) staging_dir="${2%:/backup}" ;; esac
            shift 2
            ;;
          --env)
            case "$2" in ARCHIVE_NAME=*) archive_name="${2#ARCHIVE_NAME=}" ;; esac
            shift 2
            ;;
          *) shift ;;
        esac
      done
      tar -cf "$staging_dir/$archive_name" --files-from /dev/null
      exit 0
      ;;
  esac
fi

printf 'unexpected docker call: %s\n' "$*" >&2
exit 1
EOF
chmod +x "$fake_bin/docker"

write_fixture() {
  local install_root="$1"
  mkdir -p "$install_root/backups"
  cat >"$install_root/.env" <<'EOF'
DATABASE_URL=postgres://postgres:password@postgres:5432/roomote
S3_ENDPOINT=https://objects.example.test
S3_BUCKET_ARTIFACTS=roomote-artifacts
ROOMOTE_VERSION=brain-probe-test
ROOMOTE_COMPOSE_NETWORK=roomote_default
DOCKER_WORKER_NETWORK=roomote_worker
GBRAIN_DATABASE_NAME=gbrain
EOF
  printf 'services: {}\n' >"$install_root/docker-compose.prod.yml"
}

inspect_bundle() {
  local bundle="$1"
  local inspection_dir="$2"
  mkdir -p "$inspection_dir"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
    -pass "file:$passphrase_file" -in "$bundle" |
    tar -xzf - --no-same-owner -C "$inspection_dir"
}

for probe_mode in present absent error; do
  install_root="$work_dir/$probe_mode"
  bundle="$work_dir/$probe_mode.roomote"
  output_log="$work_dir/$probe_mode.log"
  write_fixture "$install_root"

  set +e
  env PATH="$fake_bin:$PATH" \
    MOCK_PROBE_MODE="$probe_mode" \
    ROOMOTE_TEST_MODE=true \
    ROOMOTE_INSTALL_ROOT="$install_root" \
    "$roomote_cli" backup --passphrase-file "$passphrase_file" --output "$bundle" \
    >"$output_log" 2>&1
  status=$?
  set -e

  if [ "$probe_mode" = error ]; then
    [ "$status" -ne 0 ]
    [ ! -e "$bundle" ]
    grep -q 'could not determine whether the Brain index database exists' "$output_log"
    continue
  fi

  [ "$status" -eq 0 ]
  inspection_dir="$work_dir/$probe_mode-inspection"
  inspect_bundle "$bundle" "$inspection_dir"
  test -s "$inspection_dir/gbrain-data.tar"
  grep -A3 '"brain"' "$inspection_dir/manifest.json" | grep -q '"included": true'

  if [ "$probe_mode" = present ]; then
    test -s "$inspection_dir/gbrain.sql"
    grep -A3 '"brain"' "$inspection_dir/manifest.json" | grep -q '"databaseIncluded": true'
  else
    test ! -e "$inspection_dir/gbrain.sql"
    grep -A3 '"brain"' "$inspection_dir/manifest.json" | grep -q '"databaseIncluded": false'
  fi
done

printf 'Brain backup probe outcomes remain distinct.\n'

# Exercise a real OpenSSL write failure without limiting the other backup
# commands. The final output name must represent a complete encrypted bundle,
# and removing the fault must allow the identical command to be retried.
real_openssl=$(command -v openssl)
export REAL_OPENSSL="$real_openssl"
cat >"$fake_bin/openssl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${LIMIT_BACKUP_OUTPUT:-false}" = true ]; then
  ulimit -c 0
  ulimit -f 1
fi
"$REAL_OPENSSL" "$@"
if [ -n "${BACKUP_COLLISION_FILE:-}" ]; then
  printf 'concurrent output must survive\n' >"$BACKUP_COLLISION_FILE"
fi
EOF
chmod +x "$fake_bin/openssl"

install_root="$work_dir/output-failure"
bundle="$install_root/backups/retry.tar.gz.enc"
write_fixture "$install_root"
# A large, incompressible configuration makes the native encrypted output
# exceed the one-block file-size limit deterministically.
mkdir -p "$install_root/caddy"
dd if=/dev/urandom of="$install_root/caddy/Caddyfile" bs=16384 count=1 2>/dev/null

if env PATH="$fake_bin:$PATH" MOCK_PROBE_MODE=present LIMIT_BACKUP_OUTPUT=true \
  ROOMOTE_TEST_MODE=true ROOMOTE_INSTALL_ROOT="$install_root" \
  "$roomote_cli" backup --passphrase-file "$passphrase_file" --output "$bundle" \
  >"$work_dir/output-failure.log" 2>&1; then
  printf 'backup unexpectedly succeeded with a real encrypted-output size limit\n' >&2
  exit 1
fi
if [ -e "$bundle" ]; then
  printf 'failed encryption published a partial backup at the final output path\n' >&2
  exit 1
fi
grep -q 'File size limit exceeded' "$work_dir/output-failure.log"
if compgen -G "$install_root/backups/.roomote-backup.*" >/dev/null; then
  printf 'failed encryption left a temporary encrypted output behind\n' >&2
  exit 1
fi
env PATH="$fake_bin:$PATH" MOCK_PROBE_MODE=present \
  ROOMOTE_TEST_MODE=true ROOMOTE_INSTALL_ROOT="$install_root" \
  "$roomote_cli" backup --passphrase-file "$passphrase_file" --output "$bundle" \
  >"$work_dir/output-retry.log" 2>&1
inspect_bundle "$bundle" "$work_dir/output-inspection"
test "$(stat -c '%a' "$bundle")" = '600'
cmp "$install_root/caddy/Caddyfile" "$work_dir/output-inspection/config/caddy/Caddyfile"
(cd "$work_dir/output-inspection" && sha256sum -c SHA256SUMS >/dev/null)
cp "$bundle" "$work_dir/completed-backup"
if env PATH="$fake_bin:$PATH" MOCK_PROBE_MODE=present \
  ROOMOTE_TEST_MODE=true ROOMOTE_INSTALL_ROOT="$install_root" \
  "$roomote_cli" backup --passphrase-file "$passphrase_file" --output "$bundle" \
  >"$work_dir/output-existing.log" 2>&1; then
  printf 'backup unexpectedly overwrote an existing completed bundle\n' >&2
  exit 1
fi
cmp "$bundle" "$work_dir/completed-backup"

collision_bundle="$install_root/backups/concurrent.tar.gz.enc"
if env PATH="$fake_bin:$PATH" MOCK_PROBE_MODE=present BACKUP_COLLISION_FILE="$collision_bundle" \
  ROOMOTE_TEST_MODE=true ROOMOTE_INSTALL_ROOT="$install_root" \
  "$roomote_cli" backup --passphrase-file "$passphrase_file" --output "$collision_bundle" \
  >"$work_dir/output-collision.log" 2>&1; then
  printf 'backup unexpectedly succeeded after another writer created its output\n' >&2
  exit 1
fi
test "$(cat "$collision_bundle")" = 'concurrent output must survive'
if compgen -G "$install_root/backups/.roomote-backup.*" >/dev/null; then
  printf 'backup publication left a temporary encrypted output behind\n' >&2
  exit 1
fi
printf 'Failed backup output stays unpublished and the same command can retry.\n'
