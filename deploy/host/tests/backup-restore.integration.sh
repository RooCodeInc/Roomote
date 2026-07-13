#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
roomote_cli="$repo_root/deploy/host/roomote"
work_dir="$(mktemp -d)"
source_root="$work_dir/source"
fresh_root="$work_dir/fresh"
passphrase_file="$work_dir/passphrase"
bundle="$work_dir/recovery.roomote"
compose_project='roomote-backup-ci'

compose_at() {
  local root="$1"
  shift
  docker compose --project-name "$compose_project" \
    --env-file "$root/.env" -f "$root/docker-compose.prod.yml" "$@"
}

cleanup() {
  if [ -f "$fresh_root/docker-compose.prod.yml" ] && [ -f "$fresh_root/.env" ]; then
    docker compose --project-name "$compose_project" \
      --env-file "$fresh_root/.env" -f "$fresh_root/docker-compose.prod.yml" down -v --remove-orphans >/dev/null 2>&1 || true
  elif [ -f "$source_root/docker-compose.prod.yml" ]; then
    compose_at "$source_root" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

write_fixture() {
  local root="$1"
  local encryption_key="$2"

  mkdir -p "$root/backups" "$root/caddy"
  cat >"$root/.env" <<EOF
DATABASE_URL=postgres://postgres:password@postgres:5432/roomote
POSTGRES_PASSWORD=password
REDIS_URL=redis://redis:6379
S3_ENDPOINT=http://minio:9000
S3_BUCKET_ARTIFACTS=roomote-artifacts
ENCRYPTION_KEY=$encryption_key
ROOMOTE_VERSION=backup-ci
ROOMOTE_COMPOSE_NETWORK=roomote_backup_ci_default
R_DOCKER_WORKER_IMAGE=redis:7-alpine
R_DOCKER_WORKER_NETWORK=roomote_backup_ci_worker
EOF
  cat >"$root/docker-compose.prod.yml" <<'EOF'
name: roomote-backup-ci

services:
  postgres:
    image: postgres:17.5
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
      POSTGRES_DB: roomote
    volumes:
      - pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres -d roomote']
      interval: 1s
      timeout: 5s
      retries: 30
  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
  minio:
    image: redis:7-alpine
    command: ['sh', '-c', 'sleep infinity']
    volumes:
      - minio_data:/data
  web:
    image: redis:7-alpine
    command: ['sh', '-c', 'sleep infinity']
  api:
    image: redis:7-alpine
    command: ['sh', '-c', 'sleep infinity']
  controller:
    image: redis:7-alpine
    command: ['sh', '-c', 'sleep infinity']
  bullmq:
    image: redis:7-alpine
    command: ['sh', '-c', 'sleep infinity']
  preview-proxy:
    image: redis:7-alpine
    command: ['sh', '-c', 'sleep infinity']
volumes:
  pg_data:
  redis_data:
  minio_data:
networks:
  default:
    name: roomote_backup_ci_default
EOF
  printf 'fixture caddy configuration\n' >"$root/caddy/Caddyfile"
}

write_fixture "$source_root" 'source-encryption-key-that-must-survive'
printf 'correct horse battery staple\n' >"$passphrase_file"
chmod 600 "$passphrase_file"

compose_at "$source_root" up -d --wait --wait-timeout 120
compose_at "$source_root" exec -T postgres \
  psql -U postgres -d roomote -v ON_ERROR_STOP=1 \
  -c "CREATE TABLE recovery_probe (value text NOT NULL); INSERT INTO recovery_probe VALUES ('database-survived');"
compose_at "$source_root" exec -T redis redis-cli SET recovery:queued redis-survived >/dev/null
compose_at "$source_root" exec -T minio sh -c \
  "mkdir -p /data/roomote-artifacts && printf 'artifact-survived' >/data/roomote-artifacts/probe.txt"

env ROOMOTE_TEST_MODE=true ROOMOTE_INSTALL_ROOT="$source_root" \
  "$roomote_cli" backup --include-redis --passphrase-file "$passphrase_file" --output "$bundle"

if grep -a -q 'source-encryption-key-that-must-survive' "$bundle"; then
  printf 'unencrypted configuration leaked into backup bundle\n' >&2
  exit 1
fi

inspection_dir="$work_dir/inspection"
mkdir -p "$inspection_dir"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
  -pass "file:$passphrase_file" -in "$bundle" |
  tar -xzf - --no-same-owner -C "$inspection_dir"
grep -q '"formatVersion": 1' "$inspection_dir/manifest.json"
grep -q '"mode": "local-minio"' "$inspection_dir/manifest.json"
grep -q '"included": true' "$inspection_dir/manifest.json"
test -s "$inspection_dir/postgres.sql"
test -s "$inspection_dir/minio-data.tar"
test -s "$inspection_dir/redis-data.tar"

compose_at "$source_root" down -v --remove-orphans
write_fixture "$fresh_root" 'different-key-that-must-be-replaced'

env ROOMOTE_TEST_MODE=true ROOMOTE_INSTALL_ROOT="$fresh_root" \
  "$roomote_cli" restore "$bundle" --yes --passphrase-file "$passphrase_file"

grep -q '^ENCRYPTION_KEY=source-encryption-key-that-must-survive$' "$fresh_root/.env"
database_value="$(docker compose --project-name "$compose_project" \
  --env-file "$fresh_root/.env" -f "$fresh_root/docker-compose.prod.yml" \
  exec -T postgres psql -U postgres -d roomote -Atqc 'SELECT value FROM recovery_probe')"
redis_value="$(docker compose --project-name "$compose_project" \
  --env-file "$fresh_root/.env" -f "$fresh_root/docker-compose.prod.yml" \
  exec -T redis redis-cli --raw GET recovery:queued)"
artifact_value="$(docker compose --project-name "$compose_project" \
  --env-file "$fresh_root/.env" -f "$fresh_root/docker-compose.prod.yml" \
  exec -T minio cat /data/roomote-artifacts/probe.txt)"

[ "$database_value" = 'database-survived' ]
[ "$redis_value" = 'redis-survived' ]
[ "$artifact_value" = 'artifact-survived' ]

printf 'Fresh-host encrypted backup restore passed.\n'
