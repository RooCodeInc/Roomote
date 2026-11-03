#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
roomote_cli="$repo_root/deploy/host/roomote"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

mkdir -p "$work_dir/bin"
cat >"$work_dir/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf 'unexpected deployment operation\n' >"$DOCKER_CALL_MARKER"
exit 99
EOF
chmod +x "$work_dir/bin/docker"
printf 'disposable restore test passphrase\n' >"$work_dir/passphrase"

for failure in checksum missing-manifest wrong-passphrase; do
  for key_source in generated supplied; do
    fixture="$work_dir/$failure-$key_source"
    install_root="$fixture/install"
    input="$fixture/input"
    mkdir -p "$install_root/backups" "$input/config" "$fixture/temp"
    printf 'existing configuration\n' >"$install_root/.env"
    printf 'services: {}\n' >"$install_root/docker-compose.prod.yml"
    cp "$install_root/.env" "$fixture/original.env"
    cp "$install_root/docker-compose.prod.yml" "$fixture/original-compose.yml"
    printf 'disposable plaintext backup data\n' >"$input/config/.env"
    printf 'services: {}\n' >"$input/config/docker-compose.prod.yml"
    printf '%s\n' '-- disposable PostgreSQL dump' >"$input/postgres.sql"
    printf 'fixture-image\n' >"$input/images.txt"
    cat >"$input/manifest.json" <<'EOF'
{
  "format": "roomote-backup",
  "formatVersion": 1,
  "fixture": true
}
EOF
    (cd "$input" && sha256sum postgres.sql >SHA256SUMS)
    case "$failure" in
      checksum)
        printf '%s\n' '-- changed after checksum creation' >>"$input/postgres.sql"
        expected='computed checksum did NOT match'
        ;;
      missing-manifest)
        rm "$input/manifest.json"
        expected='backup manifest is missing'
        ;;
      wrong-passphrase) expected='could not decrypt backup|unsupported links or special files' ;;
    esac
    tar -czf "$fixture/backup.tar.gz" -C "$input" .
    openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
      -pass "file:$work_dir/passphrase" -in "$fixture/backup.tar.gz" -out "$fixture/bundle.enc"

    phrase='disposable restore test passphrase'
    if [ "$failure" = wrong-passphrase ]; then
      phrase='incorrect restore test passphrase'
    fi
    printf '%s\n' "$phrase" >"$fixture/operator-passphrase"
    cp "$fixture/operator-passphrase" "$fixture/original-passphrase"
    key_args=()
    if [ "$key_source" = supplied ]; then
      key_args=(--passphrase-file "$fixture/operator-passphrase")
    fi

    if env PATH="$work_dir/bin:$PATH" DOCKER_CALL_MARKER="$fixture/docker-called" \
      ROOMOTE_TEST_MODE=true ROOMOTE_INSTALL_ROOT="$install_root" \
      TMPDIR="$fixture/temp" ROOMOTE_BACKUP_PASSPHRASE="$phrase" \
      "$roomote_cli" restore "$fixture/bundle.enc" --yes "${key_args[@]}" >"$fixture/output.log" 2>&1; then
      printf 'restore unexpectedly accepted %s (%s key)\n' "$failure" "$key_source" >&2
      exit 1
    fi

    grep -Eq "$expected" "$fixture/output.log"
    if grep -q 'unbound variable' "$fixture/output.log" ||
      compgen -G "$install_root/backups/.restore-staging.*" >/dev/null ||
      compgen -G "$fixture/temp/*" >/dev/null; then
      cat "$fixture/output.log" >&2
      printf 'restore failed to clean temporary data for %s (%s key)\n' "$failure" "$key_source" >&2
      exit 1
    fi
    test ! -e "$fixture/docker-called"
    cmp "$fixture/original.env" "$install_root/.env"
    cmp "$fixture/original-compose.yml" "$install_root/docker-compose.prod.yml"
    cmp "$fixture/original-passphrase" "$fixture/operator-passphrase"
    printf 'Restore rejected %s, cleaned temporary data and preserved deployment and operator key (%s key).\n' "$failure" "$key_source"
  done
done
