#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repo_root/deploy/compose/docker-compose.prod.yml"
rendered_config="$(mktemp)"
trap 'rm -f "$rendered_config"' EXIT

export ROOMOTE_VERSION=security-contract-test
export ROOMOTE_APP_DOMAIN=app.example.test
export ROOMOTE_PREVIEW_DOMAIN=preview.example.test
export S3_SECRET_ACCESS_KEY=test-s3-secret
export JOB_AUTH_PRIVATE_KEY=test-job-private
export JOB_AUTH_PUBLIC_KEY=test-job-public
export PREVIEW_AUTH_PRIVATE_KEY=test-preview-private
export PREVIEW_AUTH_PUBLIC_KEY=test-preview-public
export ENCRYPTION_KEY=12345678901234567890123456789012
export ARTIFACT_SIGNING_KEY=12345678901234567890123456789012
export DASHBOARD_PASSWORD=test-dashboard-password

docker compose -f "$compose_file" config --format json >"$rendered_config"

jq -e '
  def hardened:
    .read_only == true and
    ((.cap_drop // []) | index("ALL") != null) and
    ((.security_opt // []) | index("no-new-privileges:true") != null);

  . as $root |
  ["web", "api", "controller", "bullmq", "preview-proxy", "db-migrate"] as $apps |

  ([$apps[] | . as $name | $root.services[$name] | hardened] | all) and
  ([$apps[] | . as $name | $root.services[$name].image |
    endswith("/roomote-app:security-contract-test")] | all) and
  # ROOMOTE_SERVICE selects the per-service env contract (packages/env) now
  # that every service shares one image.
  (.services.web.environment.ROOMOTE_SERVICE == "web") and
  (.services.api.environment.ROOMOTE_SERVICE == "api") and
  (.services.controller.environment.ROOMOTE_SERVICE == "controller") and
  (.services.bullmq.environment.ROOMOTE_SERVICE == "bullmq") and
  (.services["preview-proxy"].environment.ROOMOTE_SERVICE == "preview-proxy") and
  (.services["db-migrate"].environment.ROOMOTE_SERVICE == "db-migrate") and
  (.services["docker-proxy"].image == "ghcr.io/tecnativa/docker-socket-proxy:v0.4.2@sha256:1f3a6f303320723d199d2316a3e82b2e2685d86c275d5e3deeaf182573b47476") and

  ([.services | to_entries[] |
    select(any(.value.volumes[]?; .target == "/var/run/docker.sock")) |
    .key] == ["docker-proxy"]) and
  (.services.controller.environment.DOCKER_HOST == "tcp://docker-proxy:2375") and
  (.services.controller.networks | has("docker-api")) and
  (.services["docker-proxy"].networks | has("docker-api")) and
  (.networks["docker-api"].internal == true) and

  (.services["docker-proxy"].environment == {
    "ALLOW_START": "1",
    "CONTAINERS": "1",
    "EVENTS": "0",
    "EXEC": "1",
    "IMAGES": "1",
    "NETWORKS": "1",
    "POST": "1"
  }) and

  ([[
    "S3_SECRET_ACCESS_KEY", "R_GITHUB_APP_PRIVATE_KEY", "R_SLACK_CLIENT_SECRET",
    "OPENAI_API_KEY"
  ][] | . as $key | $root.services.controller.environment[$key] == null] | all) and
  ([[
    "JOB_AUTH_PRIVATE_KEY", "PREVIEW_AUTH_PRIVATE_KEY", "ENCRYPTION_KEY",
    "S3_SECRET_ACCESS_KEY", "OPENAI_API_KEY"
  ][] | . as $key | $root.services["preview-proxy"].environment[$key] == null] | all) and
  ([[
    "JOB_AUTH_PRIVATE_KEY", "JOB_AUTH_PUBLIC_KEY", "PREVIEW_AUTH_PRIVATE_KEY",
    "PREVIEW_AUTH_PUBLIC_KEY", "S3_SECRET_ACCESS_KEY", "OPENAI_API_KEY",
    "R_GITHUB_CLIENT_SECRET", "R_SLACK_CLIENT_SECRET"
  ][] | . as $key | $root.services.bullmq.environment[$key] == null] | all) and
  ([[
    "MODAL_TOKEN_SECRET", "PREVIEW_AUTH_PRIVATE_KEY"
  ][] | . as $key | $root.services.api.environment[$key] == null] | all) and
  (.services.api.environment.OPENAI_API_KEY != null) and
  (.services.api.environment.ANTHROPIC_API_KEY != null) and
  (.services.bullmq.environment.OPENAI_API_KEY != null) and
  ((.services["db-migrate"].environment | keys | sort) == [
    "DATABASE_URL", "NODE_ENV", "ROOMOTE_DOCKER_LOAD_ENV_FILE", "ROOMOTE_SERVICE",
    "R_APP_ENV"
  ])
' "$rendered_config" >/dev/null

echo 'Production Compose security contract is valid.'
