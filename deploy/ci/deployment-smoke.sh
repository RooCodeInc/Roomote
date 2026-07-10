#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
candidate_version="${CANDIDATE_VERSION:-deployment-ci}"
baseline_version="${BASELINE_VERSION:-}"
project_name="${COMPOSE_PROJECT_NAME:-roomote-deployment-ci}"
postgres_port="${DEPLOYMENT_CI_POSTGRES_PORT:-55432}"
redis_port="${DEPLOYMENT_CI_REDIS_PORT:-56379}"
default_network="${ROOMOTE_DEFAULT_NETWORK:-${project_name}_default}"
worker_network="${DOCKER_WORKER_NETWORK:-${project_name}_worker}"
temporary_directory="$(mktemp -d)"
env_file="$temporary_directory/deployment.env"
backup_file="$temporary_directory/roomote.sql"
launched_worker_container=''

case "$candidate_version" in
  '' | *[!A-Za-z0-9._-]*)
    printf 'invalid candidate image tag: %s\n' "$candidate_version" >&2
    exit 1
    ;;
esac

compose() {
  docker compose \
    --project-name "$project_name" \
    --env-file "$env_file" \
    -f "$repo_root/deploy/compose/docker-compose.prod.yml" \
    -f "$repo_root/deploy/ci/docker-compose.ci.yml" \
    "$@"
}

cleanup() {
  if [ -n "$launched_worker_container" ]; then
    docker rm --force "$launched_worker_container" >/dev/null 2>&1 || true
  fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$temporary_directory"
}
trap cleanup EXIT

report_failure() {
  local exit_code="$?"
  printf 'Deployment smoke test failed; final Compose state follows.\n' >&2
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

for command in docker openssl pnpm jq; do
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

write_env() {
  local version="$1"
  cat >"$env_file" <<EOF
APP_ENV=production
ARTIFACT_SIGNING_KEY=$artifact_signing_key
CADDY_HTTP_PORT=18080
CADDY_HTTPS_PORT=18443
COMPOSE_PROFILES=local-postgres
DASHBOARD_PASSWORD=$dashboard_password
DATABASE_URL=postgres://postgres:roomote-postgres-password@postgres:5432/roomote
DEFAULT_COMPUTE_PROVIDER=docker
DEPLOYMENT_CI_POSTGRES_PORT=$postgres_port
DEPLOYMENT_CI_REDIS_PORT=$redis_port
DOCKER_WORKER_IMAGE=localhost/roomote/roomote-worker:$version
DOCKER_WORKER_NETWORK=$worker_network
DOCKER_WORKER_PLATFORM=$platform
DOCKER_WORKER_RELEASE_PATH=/roomote/releases/worker-current.tar.gz
ENCRYPTION_KEY=$encryption_key
IMAGE_NAMESPACE=roomote
IMAGE_REGISTRY=localhost
JOB_AUTH_PRIVATE_KEY=$job_private
JOB_AUTH_PUBLIC_KEY=$job_public
NEXT_PUBLIC_GITHUB_APP_SLUG=deployment-ci
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
ROOMOTE_VERSION=$version
S3_ACCESS_KEY_ID=roomote
S3_BUCKET_ARTIFACTS=roomote-artifacts
S3_ENDPOINT=http://minio:9000
S3_PRESIGN_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_SECRET_ACCESS_KEY=$s3_password
SETUP_TOKEN=$setup_token
TRPC_URL=http://api:3001
EOF
}

build_candidate_images() {
  if [ "${DEPLOYMENT_CI_SKIP_BUILD:-false}" = 'true' ]; then
    return
  fi

  printf 'Building candidate app image (%s)\n' "$platform"
  docker buildx build --load \
    --platform "$platform" \
    --build-arg APP_ENV=production \
    --build-arg "RELEASE_VERSION=$candidate_version" \
    --tag "localhost/roomote/roomote-app:$candidate_version" \
    --file "$repo_root/.docker/app/Dockerfile" \
    "$repo_root"

  printf 'Building candidate worker image (%s)\n' "$platform"
  docker buildx build --load \
    --platform "$platform" \
    --tag "localhost/roomote/roomote-worker:$candidate_version" \
    --file "$repo_root/apps/worker/Dockerfile" \
    "$repo_root"
}

prepare_baseline_images() {
  if [ -z "$baseline_version" ]; then
    return 0
  fi

  printf 'Pulling previous release %s for upgrade validation\n' "$baseline_version"
  docker pull --platform "$platform" "ghcr.io/roocodeinc/roomote-app:$baseline_version"
  docker pull --platform "$platform" "ghcr.io/roocodeinc/roomote-worker:$baseline_version"
  docker tag \
    "ghcr.io/roocodeinc/roomote-app:$baseline_version" \
    'localhost/roomote/roomote-app:baseline'
  docker tag \
    "ghcr.io/roocodeinc/roomote-worker:$baseline_version" \
    'localhost/roomote/roomote-worker:baseline'
}

start_stack() {
  compose up \
    --detach \
    --wait \
    --wait-timeout 600 \
    postgres redis minio minio-init db-migrate api web controller bullmq preview-proxy
}

verify_stack() {
  local migration_container migration_exit
  migration_container="$(compose ps --all --quiet db-migrate)"
  [ -n "$migration_container" ] || {
    printf 'db-migrate container was not created\n' >&2
    return 1
  }
  migration_exit="$(docker inspect --format '{{.State.ExitCode}}' "$migration_container")"
  [ "$migration_exit" = '0' ] || {
    printf 'db-migrate exited with %s\n' "$migration_exit" >&2
    return 1
  }

  compose exec -T api curl -fsS --max-time 5 http://127.0.0.1:3001/health/liveness >/dev/null
  compose exec -T web curl -fsS --max-time 5 http://127.0.0.1:3000/health >/dev/null
  compose exec -T web curl -fsS --max-time 10 "http://127.0.0.1:3000/setup?token=$setup_token" >/dev/null
  compose exec -T controller curl -fsS --max-time 5 http://api:3001/health/controller >/dev/null
  compose exec -T bullmq curl -fsS --max-time 5 http://127.0.0.1:3002/admin/health >/dev/null
}

write_marker() {
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d roomote <<'SQL'
CREATE TABLE IF NOT EXISTS deployment_ci_marker (
  id integer PRIMARY KEY,
  value text NOT NULL
);
INSERT INTO deployment_ci_marker (id, value)
VALUES (1, 'preserved')
ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value;
SQL
}

verify_marker() {
  local value
  value="$(compose exec -T postgres psql -At -U postgres -d roomote -c 'SELECT value FROM deployment_ci_marker WHERE id = 1')"
  [ "$value" = 'preserved' ] || {
    printf 'deployment marker was not preserved (got %s)\n' "$value" >&2
    return 1
  }
}

validate_upgrade_and_rollback() {
  if [ -z "$baseline_version" ]; then
    return 0
  fi

  write_env baseline
  start_stack
  verify_stack
  write_marker

  printf 'Upgrading previous release to candidate\n'
  write_env "$candidate_version"
  start_stack
  verify_stack
  verify_marker

  printf 'Rolling back candidate to previous release\n'
  write_env baseline
  start_stack
  verify_stack
  verify_marker

  printf 'Returning stack to candidate after rollback probe\n'
  write_env "$candidate_version"
  start_stack
  verify_stack
  verify_marker
}

launch_docker_task() {
  local task_output task_json
  printf 'Launching Docker-backed task through the production controller\n'
  task_output="$(pnpm exec dotenvx run -f "$env_file" -- \
    env \
      "DATABASE_URL=postgres://postgres:roomote-postgres-password@127.0.0.1:$postgres_port/roomote" \
      "REDIS_URL=redis://127.0.0.1:$redis_port" \
      pnpm --filter @roomote/cloud-agents deployment:launch-docker-task)"
  printf '%s\n' "$task_output"

  task_json="$(printf '%s\n' "$task_output" | awk '/^\{.*\}$/ { line = $0 } END { print line }')"
  launched_worker_container="$(printf '%s' "$task_json" | jq -er '.machineId')"
  if [[ ! "$launched_worker_container" =~ ^roomote-worker-[0-9]+$ ]]; then
    printf 'unexpected worker container name: %s\n' "$launched_worker_container" >&2
    return 1
  fi

  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d roomote \
    -c "UPDATE task_runs SET status = 'canceled', canceled_at = NOW(), error = 'Deployment CI probe completed' WHERE machine_id = '$launched_worker_container'"
  docker rm --force "$launched_worker_container" >/dev/null
  launched_worker_container=''
}

backup_and_restore_fresh_stack() {
  printf 'Backing up candidate database\n'
  write_marker
  compose exec -T postgres \
    pg_dump --clean --if-exists --no-owner --no-privileges -U postgres roomote \
    >"$backup_file"
  test -s "$backup_file"

  printf 'Restoring backup onto fresh volumes\n'
  compose down --volumes --remove-orphans
  write_env "$candidate_version"
  compose up --detach --wait --wait-timeout 180 postgres redis minio minio-init
  compose exec -T postgres psql --quiet -v ON_ERROR_STOP=1 -U postgres -d roomote <"$backup_file"
  start_stack
  verify_stack
  verify_marker
}

cd "$repo_root"
write_env "$candidate_version"
build_candidate_images
prepare_baseline_images

if [ -n "$baseline_version" ]; then
  validate_upgrade_and_rollback
else
  start_stack
  verify_stack
fi

launch_docker_task
backup_and_restore_fresh_stack

printf 'Deployment smoke test passed for %s on %s\n' "$candidate_version" "$platform"
