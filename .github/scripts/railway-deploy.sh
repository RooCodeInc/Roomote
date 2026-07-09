#!/usr/bin/env bash
# Pin Railway services running the roomote-app image to an immutable tag and
# redeploy them, via Railway's public GraphQL API.
#
# Two token modes:
#   RAILWAY_TOKEN_TYPE=project    An environment-scoped project token. The
#                                 single target environment is resolved from
#                                 the token itself. Used by the develop
#                                 preview deployment.
#   RAILWAY_TOKEN_TYPE=workspace  A workspace (team) token. Every environment
#                                 in the workspace with services running the
#                                 image prefix is discovered and deployed —
#                                 the fleet is whatever lives in the
#                                 workspace, so onboarding a deployment needs
#                                 no CI change. Used by the main-channel
#                                 fleet. When RAILWAY_CANARY_PROJECT is set,
#                                 that project deploys first and a failure
#                                 there aborts the rest of the fleet.
#
# Inputs (env):
#   RAILWAY_TOKEN           required  project or workspace token
#   RAILWAY_TOKEN_TYPE      required  "project" | "workspace"
#   RAILWAY_IMAGE           required  full image ref to pin, e.g.
#                                     ghcr.io/roocodeinc/roomote-app:main-abcd1234
#   RAILWAY_IMAGE_PREFIX    required  image prefix that selects app services
#   RAILWAY_CANARY_PROJECT  optional  project name deployed first (workspace)
#
# Per-environment failures in workspace mode are tolerated: the run continues
# to the remaining environments and the script exits non-zero at the end so
# the job still reports failure. Both mutations are idempotent (set the
# image, then deploy), so a retried or partially failed run is safe to
# re-run. A markdown result table is appended to GITHUB_STEP_SUMMARY when it
# is set.

set -euo pipefail

: "${RAILWAY_TOKEN:?RAILWAY_TOKEN is required}"
: "${RAILWAY_TOKEN_TYPE:?RAILWAY_TOKEN_TYPE is required (project|workspace)}"
: "${RAILWAY_IMAGE:?RAILWAY_IMAGE is required}"
: "${RAILWAY_IMAGE_PREFIX:?RAILWAY_IMAGE_PREFIX is required}"

api=https://backboard.railway.com/graphql/v2

case "$RAILWAY_TOKEN_TYPE" in
  project) auth_header="Project-Access-Token: ${RAILWAY_TOKEN}" ;;
  workspace) auth_header="Authorization: Bearer ${RAILWAY_TOKEN}" ;;
  *)
    echo "RAILWAY_TOKEN_TYPE must be 'project' or 'workspace', got '$RAILWAY_TOKEN_TYPE'" >&2
    exit 1
    ;;
esac

# POST one GraphQL operation. Fails on transport errors and on GraphQL-level
# errors, and prints only the data payload.
gql() {
  local query="$1" variables="${2:-null}" response
  response="$(jq -n --arg query "$query" --argjson variables "$variables" \
    '{query: $query, variables: $variables}' \
    | curl -sS --fail-with-body --retry 3 --retry-all-errors \
        -X POST "$api" \
        -H 'Content-Type: application/json' \
        -H "$auth_header" \
        --data-binary @-)"
  if [ "$(jq 'has("errors")' <<< "$response")" = "true" ]; then
    jq -r '.errors[].message' <<< "$response" >&2
    return 1
  fi
  jq '.data' <<< "$response"
}

# List the roomote-app service instances in one environment as a compact
# JSON array of {serviceId, serviceName}.
environment_services() {
  local environment_id="$1"
  gql 'query ($environmentId: String!) {
    environment(id: $environmentId) {
      serviceInstances {
        edges { node { serviceId serviceName source { image } } }
      }
    }
  }' "$(jq -n --arg environmentId "$environment_id" '{environmentId: $environmentId}')" \
    | jq -c --arg prefix "$RAILWAY_IMAGE_PREFIX" \
        '[.environment.serviceInstances.edges[].node
          | select(.source.image != null and (.source.image | startswith($prefix)))
          | {serviceId, serviceName}]'
}

# Pin every listed service to RAILWAY_IMAGE and redeploy it.
deploy_environment() {
  local environment_id="$1" services="$2" count service_id service_name i
  count="$(jq 'length' <<< "$services")"
  for i in $(seq 0 $((count - 1))); do
    service_id="$(jq -r ".[$i].serviceId" <<< "$services")"
    service_name="$(jq -r ".[$i].serviceName" <<< "$services")"
    echo "  Updating $service_name to $RAILWAY_IMAGE"
    gql 'mutation ($environmentId: String!, $serviceId: String!, $input: ServiceInstanceUpdateInput!) {
      serviceInstanceUpdate(environmentId: $environmentId, serviceId: $serviceId, input: $input)
    }' "$(jq -n \
          --arg environmentId "$environment_id" \
          --arg serviceId "$service_id" \
          --arg image "$RAILWAY_IMAGE" \
          '{environmentId: $environmentId, serviceId: $serviceId, input: {source: {image: $image}}}')" \
      > /dev/null
    gql 'mutation ($environmentId: String!, $serviceId: String!) {
      serviceInstanceDeploy(environmentId: $environmentId, serviceId: $serviceId, latestCommit: false)
    }' "$(jq -n \
          --arg environmentId "$environment_id" \
          --arg serviceId "$service_id" \
          '{environmentId: $environmentId, serviceId: $serviceId}')" \
      > /dev/null
  done
}

summary_rows=""
record_result() {
  local project="$1" environment="$2" services="$3" status="$4"
  summary_rows="${summary_rows}| ${project} | ${environment} | ${services} | ${status} |"$'\n'
}

write_summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "## Railway deploy — \`${RAILWAY_IMAGE}\`"
      echo ""
      echo "| Project | Environment | Services | Status |"
      echo "| --- | --- | --- | --- |"
      printf '%s' "$summary_rows"
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

if [ "$RAILWAY_TOKEN_TYPE" = "project" ]; then
  # A project token is scoped to a single environment; resolve it from the
  # token instead of configuring it separately.
  environment_id="$(gql 'query { projectToken { environmentId } }' \
    | jq -r '.projectToken.environmentId')"

  services="$(environment_services "$environment_id")"
  count="$(jq 'length' <<< "$services")"
  if [ "$count" -eq 0 ]; then
    echo "No Railway services run an image with prefix $RAILWAY_IMAGE_PREFIX" >&2
    exit 1
  fi

  deploy_environment "$environment_id" "$services"
  record_result "(project token)" "$environment_id" "$count" "updated"
  write_summary
  echo "Updated $count service(s) to $RAILWAY_IMAGE"
  exit 0
fi

# Workspace mode: discover every environment in the workspace that runs the
# app image. Targets are emitted as one JSON object per line:
# {project, environmentId, environmentName, services: [...]}.
projects="$(gql 'query {
  projects {
    edges {
      node {
        id
        name
        environments { edges { node { id name } } }
      }
    }
  }
}' | jq -c '[.projects.edges[].node
      | {id, name, environments: [.environments.edges[].node]}]')"

targets=""
project_count="$(jq 'length' <<< "$projects")"
for p in $(seq 0 $((project_count - 1))); do
  project_name="$(jq -r ".[$p].name" <<< "$projects")"
  env_count="$(jq ".[$p].environments | length" <<< "$projects")"
  for e in $(seq 0 $((env_count - 1))); do
    environment_id="$(jq -r ".[$p].environments[$e].id" <<< "$projects")"
    environment_name="$(jq -r ".[$p].environments[$e].name" <<< "$projects")"
    services="$(environment_services "$environment_id")"
    if [ "$(jq 'length' <<< "$services")" -gt 0 ]; then
      targets="${targets}$(jq -nc \
        --arg project "$project_name" \
        --arg environmentId "$environment_id" \
        --arg environmentName "$environment_name" \
        --argjson services "$services" \
        '{project: $project, environmentId: $environmentId, environmentName: $environmentName, services: $services}')"$'\n'
    fi
  done
done

if [ -z "$targets" ]; then
  echo "No environments in the workspace run an image with prefix $RAILWAY_IMAGE_PREFIX" >&2
  exit 1
fi

# Canary first: order the canary project's environments ahead of the rest.
if [ -n "${RAILWAY_CANARY_PROJECT:-}" ]; then
  canary_targets="$(jq -c --arg canary "$RAILWAY_CANARY_PROJECT" \
    'select(.project == $canary)' <<< "$targets" || true)"
  rest_targets="$(jq -c --arg canary "$RAILWAY_CANARY_PROJECT" \
    'select(.project != $canary)' <<< "$targets" || true)"
  if [ -z "$canary_targets" ]; then
    echo "Canary project '$RAILWAY_CANARY_PROJECT' has no matching services in the workspace" >&2
    exit 1
  fi
  targets="${canary_targets}"$'\n'"${rest_targets}"
fi

failed=0
while IFS= read -r target; do
  [ -z "$target" ] && continue
  project="$(jq -r '.project' <<< "$target")"
  environment_id="$(jq -r '.environmentId' <<< "$target")"
  environment_name="$(jq -r '.environmentName' <<< "$target")"
  services="$(jq -c '.services' <<< "$target")"
  count="$(jq 'length' <<< "$services")"

  echo "Deploying $project / $environment_name ($count service(s))"
  if deploy_environment "$environment_id" "$services"; then
    record_result "$project" "$environment_name" "$count" "updated"
  else
    record_result "$project" "$environment_name" "$count" "FAILED"
    failed=$((failed + 1))
    # A canary failure means the build is suspect: stop before the fleet.
    if [ -n "${RAILWAY_CANARY_PROJECT:-}" ] && [ "$project" = "$RAILWAY_CANARY_PROJECT" ]; then
      echo "Canary project '$project' failed; aborting the remaining fleet" >&2
      record_result "(remaining fleet)" "-" "-" "skipped after canary failure"
      break
    fi
  fi
done <<< "$targets"

write_summary

if [ "$failed" -gt 0 ]; then
  echo "$failed environment(s) failed to deploy" >&2
  exit 1
fi
echo "Fleet updated to $RAILWAY_IMAGE"
