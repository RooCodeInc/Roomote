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

mkdir -p "$install_root" "$fake_bin"
cat >"$install_root/.env" <<'EOF'
ROOMOTE_VERSION=test
COMPOSE_FILE=docker-compose.prod.yml:docker-compose.caddy-dns.yml
EOF
printf 'services: {}\n' >"$install_root/docker-compose.prod.yml"
printf 'services: {}\n' >"$install_root/docker-compose.caddy-dns.yml"
printf 'services: {}\n' >"$install_root/docker-compose.extra.yml"
# Present on disk but not registered: must never be picked up implicitly.
printf 'services: {}\n' >"$install_root/docker-compose.stray.yml"

cat >"$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$MOCK_DOCKER_LOG"
EOF
chmod +x "$fake_bin/docker"

run_cli() {
  env PATH="$fake_bin:$PATH" \
    MOCK_DOCKER_LOG="$docker_log" \
    ROOMOTE_INSTALL_ROOT="$install_root" \
    ROOMOTE_TEST_MODE=true \
    "$roomote_cli" "$@"
}

# Registered overrides are appended in order; unregistered files are ignored.
run_cli status
grep -Fq -- "compose --env-file $install_root/.env -f $install_root/docker-compose.prod.yml -f $install_root/docker-compose.caddy-dns.yml ps" "$docker_log"
if grep -q 'stray' "$docker_log"; then
  printf 'unregistered compose file was passed to docker compose\n' >&2
  exit 1
fi

# override list prints the merge order.
run_cli override list >"$output_log"
grep -Fq 'docker-compose.prod.yml (managed base file)' "$output_log"
grep -Fq 'docker-compose.caddy-dns.yml' "$output_log"

# override add validates the merged config, then records the entry.
run_cli override add docker-compose.extra.yml >"$output_log"
grep -Fq 'COMPOSE_FILE=docker-compose.prod.yml:docker-compose.caddy-dns.yml:docker-compose.extra.yml' "$install_root/.env"
grep -Fq -- "-f $install_root/docker-compose.extra.yml config" "$docker_log"

# Adding a file that does not exist fails without touching the registry.
if run_cli override add docker-compose.missing.yml >"$output_log" 2>&1; then
  printf 'override add accepted a missing file\n' >&2
  exit 1
fi
grep -Fq 'COMPOSE_FILE=docker-compose.prod.yml:docker-compose.caddy-dns.yml:docker-compose.extra.yml' "$install_root/.env"

# override remove drops the entry but keeps the file.
run_cli override remove docker-compose.extra.yml >"$output_log"
grep -Fq 'COMPOSE_FILE=docker-compose.prod.yml:docker-compose.caddy-dns.yml' "$install_root/.env"
[ -f "$install_root/docker-compose.extra.yml" ]

# The base file cannot be removed.
if run_cli override remove docker-compose.prod.yml >"$output_log" 2>&1; then
  printf 'override remove accepted the managed base file\n' >&2
  exit 1
fi

# A registered-but-missing file fails loudly with the fix spelled out.
rm "$install_root/docker-compose.caddy-dns.yml"
if run_cli status >"$output_log" 2>&1; then
  printf 'status succeeded despite a missing registered override\n' >&2
  exit 1
fi
grep -Fq "roomote override remove docker-compose.caddy-dns.yml" "$output_log"

# COMPOSE_FILE must keep the managed base file first.
printf 'services: {}\n' >"$install_root/docker-compose.caddy-dns.yml"
sed -i.bak 's/^COMPOSE_FILE=.*/COMPOSE_FILE=docker-compose.caddy-dns.yml:docker-compose.prod.yml/' "$install_root/.env"
if run_cli status >"$output_log" 2>&1; then
  printf 'status accepted a COMPOSE_FILE without the base file first\n' >&2
  exit 1
fi
grep -Fq 'must list the managed base file' "$output_log"

printf 'Compose override registry behaves as documented.\n'
