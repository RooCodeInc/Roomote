#!/usr/bin/env bash
#
# PR-time upgrade-compatibility lane. Boots the previous published release
# from GHCR, applies the candidate checkout's database migrations to it, and
# requires the previous release to stay healthy — including a cold restart —
# on the candidate schema. This enforces the expand/contract policy in
# deploy/README.md before merge without building candidate images; the
# publish-time deployment-acceptance gate (deploy/ci/deployment-smoke.sh)
# covers the full upgrade -> rollback -> re-upgrade lifecycle with them.
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
baseline_channel="${BASELINE_CHANNEL-develop}"

# An explicitly empty baseline means there is no usable previous release to
# validate against (bootstrap: nothing published yet). Skip instead of
# booting a known-incompatible or nonexistent image.
if [ -z "$baseline_channel" ]; then
  printf 'No usable previous release baseline; skipping upgrade compatibility.\n'
  exit 0
fi

baseline_registry="${BASELINE_IMAGE_REGISTRY:-ghcr.io}"
baseline_namespace="${BASELINE_IMAGE_NAMESPACE:-roocodeinc}"
project_name="${COMPOSE_PROJECT_NAME:-roomote-upgrade-ci}"
postgres_port="${DEPLOYMENT_CI_POSTGRES_PORT:-57432}"
redis_port="${DEPLOYMENT_CI_REDIS_PORT:-58379}"
default_network="${ROOMOTE_DEFAULT_NETWORK:-${project_name}_default}"
worker_network="${DOCKER_WORKER_NETWORK:-${project_name}_worker}"
temporary_directory="$(mktemp -d)"
env_file="$temporary_directory/deployment.env"

# Published channel aliases and v* release tags have a defined previous
# release. Anything else (workflow_dispatch from a feature branch) validates
# against develop.
case "$baseline_channel" in
  develop | main | v[0-9]*) ;;
  *)
    printf 'No published channel for %s; using develop as the baseline\n' "$baseline_channel"
    baseline_channel='develop'
    ;;
esac

app_image="$baseline_registry/$baseline_namespace/roomote-app:$baseline_channel"
worker_image="$baseline_registry/$baseline_namespace/roomote-worker:$baseline_channel"

compose() {
  docker compose \
    --project-name "$project_name" \
    --env-file "$env_file" \
    -f "$repo_root/deploy/compose/docker-compose.prod.yml" \
    -f "$repo_root/deploy/ci/docker-compose.ci.yml" \
    "$@"
}

cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$temporary_directory"
}
trap cleanup EXIT

report_failure() {
  local exit_code="$?"
  printf 'Upgrade compatibility test failed; final Compose state follows.\n' >&2
  compose ps --all >&2 || true
  compose logs --no-color --tail 200 >&2 || true
  return "$exit_code"
}
trap report_failure ERR

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'required command not found: %s\n' "$1" >&2
    exit 1
  }
}

for command in docker openssl pnpm; do
  require_command "$command"
done

docker_arch="$(docker info --format '{{.Architecture}}')"
case "$docker_arch" in
  amd64 | x86_64) platform='linux/amd64' ;;
  arm64 | aarch64) platform='linux/arm64' ;;
  *)
    printf 'unsupported Docker architecture: %s\n' "$docker_arch" >&2
    exit 1
    ;;
esac

generate_keypair() {
  local name="$1"
  openssl ecparam -name prime256v1 -genkey -noout -out "$temporary_directory/$name-raw.pem" 2>/dev/null
  openssl pkcs8 -topk8 -nocrypt \
    -in "$temporary_directory/$name-raw.pem" \
    -out "$temporary_directory/$name-private.pem" 2>/dev/null
  openssl ec -in "$temporary_directory/$name-raw.pem" \
    -pubout -out "$temporary_directory/$name-public.pem" 2>/dev/null
}

single_line_base64() {
  base64 <"$1" | tr -d '\n'
}

generate_keypair job
generate_keypair preview

job_private="$(single_line_base64 "$temporary_directory/job-private.pem")"
job_public="$(single_line_base64 "$temporary_directory/job-public.pem")"
preview_private="$(single_line_base64 "$temporary_directory/preview-private.pem")"
preview_public="$(single_line_base64 "$temporary_directory/preview-public.pem")"
encryption_key="$(openssl rand -base64 32 | tr -d '\n')"
artifact_signing_key="$(openssl rand -base64 32 | tr -d '\n')"
dashboard_password="$(openssl rand -base64 24 | tr -d '\n')"
s3_password="$(openssl rand -base64 32 | tr -d '\n')"
setup_token="$(openssl rand -hex 24)"

cat >"$env_file" <<EOF
APP_ENV=production
ARTIFACT_SIGNING_KEY=$artifact_signing_key
CADDY_HTTP_PORT=19080
CADDY_HTTPS_PORT=19443
COMPOSE_PROFILES=local-postgres
DASHBOARD_PASSWORD=$dashboard_password
DATABASE_URL=postgres://postgres:roomote-postgres-password@postgres:5432/roomote
DEFAULT_COMPUTE_PROVIDER=docker
DEPLOYMENT_CI_POSTGRES_PORT=$postgres_port
DEPLOYMENT_CI_REDIS_PORT=$redis_port
DOCKER_WORKER_IMAGE=$worker_image
DOCKER_WORKER_NETWORK=$worker_network
DOCKER_WORKER_PLATFORM=$platform
DOCKER_WORKER_RELEASE_PATH=/roomote/releases/worker-current.tar.gz
ENCRYPTION_KEY=$encryption_key
IMAGE_NAMESPACE=$baseline_namespace
IMAGE_REGISTRY=$baseline_registry
JOB_AUTH_PRIVATE_KEY=$job_private
JOB_AUTH_PUBLIC_KEY=$job_public
NEXT_PUBLIC_GITHUB_APP_SLUG=upgrade-ci
POSTGRES_DB=roomote
POSTGRES_PASSWORD=roomote-postgres-password
POSTGRES_USER=postgres
PREVIEW_AUTH_PRIVATE_KEY=$preview_private
PREVIEW_AUTH_PUBLIC_KEY=$preview_public
REDIS_URL=redis://redis:6379
ROOMOTE_APP_DOMAIN=roomote.localhost
ROOMOTE_APP_URL=http://roomote.localhost
ROOMOTE_DEFAULT_NETWORK=$default_network
ROOMOTE_PREVIEW_DOMAIN=preview.roomote.localhost
ROOMOTE_VERSION=$baseline_channel
S3_ACCESS_KEY_ID=roomote
S3_BUCKET_ARTIFACTS=roomote-artifacts
S3_ENDPOINT=http://minio:9000
S3_PRESIGN_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_SECRET_ACCESS_KEY=$s3_password
SETUP_TOKEN=$setup_token
TRPC_URL=http://api:3001
EOF

verify_endpoints() {
  compose exec -T api curl -fsS --max-time 5 http://127.0.0.1:3001/health/liveness >/dev/null
  compose exec -T web curl -fsS --max-time 5 http://127.0.0.1:3000/health >/dev/null
  compose exec -T web curl -fsS --max-time 10 "http://127.0.0.1:3000/setup?token=$setup_token" >/dev/null
  compose exec -T controller curl -fsS --max-time 5 http://api:3001/health/controller >/dev/null
  compose exec -T bullmq curl -fsS --max-time 5 http://127.0.0.1:3002/admin/health >/dev/null
}

applied_migration_count() {
  compose exec -T postgres psql -Atq -U postgres -d roomote \
    -c 'SELECT count(*) FROM drizzle.__drizzle_migrations'
}

write_marker() {
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d roomote <<'SQL'
CREATE TABLE IF NOT EXISTS upgrade_ci_marker (
  id integer PRIMARY KEY,
  value text NOT NULL
);
INSERT INTO upgrade_ci_marker (id, value)
VALUES (1, 'preserved')
ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value;
SQL
}

verify_marker() {
  local value
  value="$(compose exec -T postgres psql -At -U postgres -d roomote -c 'SELECT value FROM upgrade_ci_marker WHERE id = 1')"
  [ "$value" = 'preserved' ] || {
    printf 'upgrade marker was not preserved (got %s)\n' "$value" >&2
    return 1
  }
}

cd "$repo_root"

printf 'Pulling previous release images (%s)\n' "$baseline_channel"
docker pull --platform "$platform" "$app_image"
docker pull --platform "$platform" "$worker_image"
docker image inspect --format 'baseline app image: {{index .RepoDigests 0}}' "$app_image" || true

printf 'Booting the previous release\n'
compose up \
  --detach \
  --wait \
  --wait-timeout 600 \
  postgres redis minio minio-init db-migrate api web controller bullmq preview-proxy

migration_container="$(compose ps --all --quiet db-migrate)"
[ -n "$migration_container" ] || {
  printf 'db-migrate container was not created\n' >&2
  exit 1
}
migration_exit="$(docker inspect --format '{{.State.ExitCode}}' "$migration_container")"
[ "$migration_exit" = '0' ] || {
  printf 'baseline db-migrate exited with %s\n' "$migration_exit" >&2
  exit 1
}
verify_endpoints
write_marker
baseline_migrations="$(applied_migration_count)"

printf 'Applying candidate migrations to the previous release database\n'
DATABASE_URL="postgres://postgres:roomote-postgres-password@127.0.0.1:$postgres_port/roomote" \
  pnpm --filter @roomote/db db:migrate:standalone

candidate_migrations="$(applied_migration_count)"
[ "$candidate_migrations" -ge "$baseline_migrations" ] || {
  printf 'migration journal shrank from %s to %s\n' "$baseline_migrations" "$candidate_migrations" >&2
  exit 1
}
printf 'Applied migrations: %s baseline -> %s candidate\n' "$baseline_migrations" "$candidate_migrations"

printf 'Verifying the previous release on the candidate schema\n'
verify_endpoints
verify_marker

# A rollback is a cold start of the previous release against the candidate
# schema, so restart the application services and require health again.
printf 'Cold-restarting the previous release on the candidate schema\n'
compose restart api web controller bullmq preview-proxy
compose up \
  --detach \
  --wait \
  --wait-timeout 300 \
  api web controller bullmq preview-proxy
verify_endpoints
verify_marker

printf 'Upgrade compatibility passed: %s stays healthy on the candidate schema\n' "$baseline_channel"
