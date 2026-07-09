#!/usr/bin/env bash
# Onboard one Railway deployment of Roomote: attach its custom domains,
# write the matching DNS records, optionally wire up live previews, and
# print the /setup link.
#
# Expected flow for a fleet operator hosting deployments under one zone:
#
#   1. Deploy the main-channel template into the fleet workspace from the
#      Railway dashboard, setting ROOMOTE_APP_URL to
#      https://<customer>.<base-domain> at the deploy prompt.
#   2. Run this script. It is idempotent — re-run it after fixing anything.
#   3. Open the printed /setup URL and finish onboarding in the wizard.
#
# What the script does:
#
#   - Finds the project in the workspace by name (--project, default
#     matches the customer slug) using the Railway public GraphQL API.
#   - Adds the app custom domain to the web service, and (with --previews)
#     the previews.<...> and *.previews.<...> domains to the preview-proxy
#     service, then reads back the DNS records Railway requires.
#   - Creates any missing DNS records in the Vercel DNS zone for
#     --base-domain (CNAMEs, the _acme-challenge delegation for the
#     wildcard, and TXT ownership verification).
#   - With --previews, upserts PREVIEW_PROXY_BASE_URL,
#     NEXT_PUBLIC_PREVIEW_PROXY_BASE_URL, and PREVIEW_DOMAINS on the api
#     service plus ${{api.*}} references on web/controller/bullmq/
#     preview-proxy, and redeploys those services.
#   - Prints the app URL, the /setup URL, and where to read SETUP_TOKEN.
#
# Usage:
#   RAILWAY_WORKSPACE_TOKEN=... VERCEL_TOKEN=... \
#   deploy/railway/scripts/onboard-deployment.sh \
#     --customer acme --base-domain roomote.example [--previews] \
#     [--project <railway project name>] [--vercel-team <teamId>] [--dry-run]
#
# Requirements: bash, curl, jq. DNS support is Vercel-only for now; for
# other providers, run with --dry-run and create the printed records by
# hand.
#
# The Railway workspace token can touch everything in its workspace — mint
# it in the dedicated fleet workspace only. The Vercel token needs DNS
# write access to the zone.

set -euo pipefail

customer=""
base_domain=""
project=""
previews=false
dry_run=false
vercel_team="${VERCEL_TEAM_ID:-}"

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --customer) customer="$2"; shift 2 ;;
    --base-domain) base_domain="$2"; shift 2 ;;
    --project) project="$2"; shift 2 ;;
    --vercel-team) vercel_team="$2"; shift 2 ;;
    --previews) previews=true; shift ;;
    --dry-run) dry_run=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

: "${customer:?--customer is required}"
: "${base_domain:?--base-domain is required}"
: "${RAILWAY_WORKSPACE_TOKEN:?RAILWAY_WORKSPACE_TOKEN is required}"
if ! $dry_run; then
  : "${VERCEL_TOKEN:?VERCEL_TOKEN is required (or use --dry-run and create DNS records by hand)}"
fi
project="${project:-$customer}"

app_domain="${customer}.${base_domain}"
previews_domain="previews.${app_domain}"

railway_api=https://backboard.railway.com/graphql/v2
vercel_api=https://api.vercel.com

# ---------------------------------------------------------------- helpers

gql() {
  local query="$1" variables="${2:-null}" response
  response="$(jq -n --arg query "$query" --argjson variables "$variables" \
    '{query: $query, variables: $variables}' \
    | curl -sS --fail-with-body --retry 3 --retry-all-errors \
        -X POST "$railway_api" \
        -H 'Content-Type: application/json' \
        -H "Authorization: Bearer ${RAILWAY_WORKSPACE_TOKEN}" \
        --data-binary @-)"
  if [ "$(jq 'has("errors")' <<< "$response")" = "true" ]; then
    jq -r '.errors[].message' <<< "$response" >&2
    return 1
  fi
  jq '.data' <<< "$response"
}

vercel() {
  local method="$1" path="$2" body="${3:-}" url
  url="${vercel_api}${path}"
  if [ -n "$vercel_team" ]; then
    case "$url" in
      *\?*) url="${url}&teamId=${vercel_team}" ;;
      *) url="${url}?teamId=${vercel_team}" ;;
    esac
  fi
  if [ -n "$body" ]; then
    curl -sS --fail-with-body -X "$method" "$url" \
      -H "Authorization: Bearer ${VERCEL_TOKEN}" \
      -H 'Content-Type: application/json' \
      --data-binary "$body"
  else
    curl -sS --fail-with-body -X "$method" "$url" \
      -H "Authorization: Bearer ${VERCEL_TOKEN}"
  fi
}

say() { printf '%s\n' "$*"; }
act() { # print in dry-run mode, execute otherwise
  if $dry_run; then
    say "[dry-run] $1"
    return 0
  fi
  return 1
}

# ------------------------------------------------- phase 1: locate project

say "Locating project '$project' in the Railway workspace..."
projects="$(gql 'query {
  projects {
    edges {
      node {
        id
        name
        environments { edges { node { id name } } }
        services { edges { node { id name } } }
      }
    }
  }
}' | jq -c '[.projects.edges[].node]')"

project_node="$(jq -c --arg name "$project" '[.[] | select(.name == $name)] | first // empty' <<< "$projects")"
if [ -z "$project_node" ]; then
  say "Project '$project' not found in the workspace." >&2
  say "Deploy the main-channel template into the fleet workspace first" >&2
  say "(set ROOMOTE_APP_URL=https://${app_domain} at the deploy prompt)," >&2
  say "then re-run. Projects present: $(jq -r '[.[].name] | join(", ")' <<< "$projects")" >&2
  exit 1
fi

project_id="$(jq -r '.id' <<< "$project_node")"
environment_id="$(jq -r '.environments.edges[0].node.id' <<< "$project_node")"
service_id() {
  jq -r --arg name "$1" '.services.edges[].node | select(.name == $name) | .id' <<< "$project_node"
}
web_service="$(service_id web)"
api_service="$(service_id api)"
preview_proxy_service="$(service_id preview-proxy)"

[ -n "$web_service" ] || { say "No 'web' service in project '$project' — is this a Roomote template deploy?" >&2; exit 1; }
[ -n "$api_service" ] || { say "No 'api' service in project '$project' — is this a Roomote template deploy?" >&2; exit 1; }
if $previews && [ -z "$preview_proxy_service" ]; then
  say "--previews requires a 'preview-proxy' service; add it per template.yaml first" >&2
  say "(same app image, start command '/roomote/.docker/app/entrypoint.sh preview-proxy'," >&2
  say "healthcheck /health, HTTP proxy port 8080), then re-run." >&2
  exit 1
fi

# --------------------------------------------- phase 2: railway domains

# Ensure a custom domain exists on a service; echo the domain's required
# DNS records as JSON [{recordType, hostlabel, requiredValue}].
ensure_domain() {
  local service="$1" domain="$2" existing created domain_id
  existing="$(gql 'query ($projectId: String!, $environmentId: String!, $serviceId: String!) {
    domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
      customDomains { id domain status { dnsRecords { recordType hostlabel requiredValue } } }
    }
  }' "$(jq -n --arg projectId "$project_id" --arg environmentId "$environment_id" --arg serviceId "$service" \
        '{projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId}')")"

  domain_id="$(jq -r --arg d "$domain" '.domains.customDomains[] | select(.domain == $d) | .id' <<< "$existing")"
  if [ -n "$domain_id" ]; then
    say "  Domain $domain already attached" >&2
    jq -c --arg d "$domain" '[.domains.customDomains[] | select(.domain == $d) | .status.dnsRecords[]]' <<< "$existing"
    return 0
  fi

  if act "railway: attach custom domain $domain"; then
    echo '[]'
    return 0
  fi

  say "  Attaching $domain" >&2
  created="$(gql 'mutation ($input: CustomDomainCreateInput!) {
    customDomainCreate(input: $input) {
      id
      status { dnsRecords { recordType hostlabel requiredValue } }
    }
  }' "$(jq -n --arg projectId "$project_id" --arg environmentId "$environment_id" \
        --arg serviceId "$service" --arg domain "$domain" \
        '{input: {projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, domain: $domain}}')")"
  jq -c '[.customDomainCreate.status.dnsRecords[]]' <<< "$created"
}

say "Ensuring Railway custom domains..."
dns_records="$(ensure_domain "$web_service" "$app_domain")"
if $previews; then
  dns_records="$(jq -c --argjson a "$dns_records" '$a + .' <<< "$(ensure_domain "$preview_proxy_service" "$previews_domain")")"
  dns_records="$(jq -c --argjson a "$dns_records" '$a + .' <<< "$(ensure_domain "$preview_proxy_service" "*.${previews_domain}")")"
fi

# ------------------------------------------------- phase 3: vercel dns

# Railway hostlabels are absolute; Vercel record names are relative to the
# zone. Strip ".<base_domain>" (an empty result means the zone apex).
to_zone_name() {
  local host="$1"
  host="${host%.}"
  if [ "$host" = "$base_domain" ]; then
    printf '%s' ''
  else
    printf '%s' "${host%."$base_domain"}"
  fi
}

say "Ensuring DNS records in the Vercel zone ${base_domain}..."
if $dry_run; then
  say "[dry-run] required records:"
  jq -r '.[] | "  \(.recordType)  \(.hostlabel)  ->  \(.requiredValue)"' <<< "$dns_records"
else
  existing_records="$(vercel GET "/v4/domains/${base_domain}/records?limit=100" | jq -c '.records')"
  count="$(jq 'length' <<< "$dns_records")"
  for i in $(seq 0 $((count - 1))); do
    record="$(jq -c ".[$i]" <<< "$dns_records")"
    r_type="$(jq -r '.recordType' <<< "$record")"
    r_host="$(jq -r '.hostlabel' <<< "$record")"
    r_value="$(jq -r '.requiredValue' <<< "$record")"
    r_name="$(to_zone_name "$r_host")"

    match="$(jq -r --arg name "$r_name" --arg type "$r_type" --arg value "$r_value" \
      '[.[] | select(.name == $name and .type == $type and .value == $value)] | length' <<< "$existing_records")"
    if [ "$match" -gt 0 ]; then
      say "  $r_type $r_host already set"
      continue
    fi
    say "  Creating $r_type $r_host -> $r_value"
    vercel POST "/v2/domains/${base_domain}/records" \
      "$(jq -n --arg name "$r_name" --arg type "$r_type" --arg value "$r_value" \
          '{name: $name, type: $type, value: $value, ttl: 300}')" > /dev/null
  done
fi

# -------------------------------------------- phase 4: preview variables

if $previews; then
  say "Ensuring preview environment variables..."
  upsert_var() {
    local service="$1" name="$2" value="$3"
    if act "railway: set $name on service $service"; then return 0; fi
    gql 'mutation ($input: VariableUpsertInput!) { variableUpsert(input: $input) }' \
      "$(jq -n --arg projectId "$project_id" --arg environmentId "$environment_id" \
          --arg serviceId "$service" --arg name "$name" --arg value "$value" \
          '{input: {projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, name: $name, value: $value}}')" \
      > /dev/null
  }

  upsert_var "$api_service" PREVIEW_PROXY_BASE_URL "https://${previews_domain}"
  upsert_var "$api_service" NEXT_PUBLIC_PREVIEW_PROXY_BASE_URL "https://${previews_domain}"
  upsert_var "$api_service" PREVIEW_DOMAINS "$previews_domain"

  for svc_name in web controller bullmq preview-proxy; do
    svc="$(service_id "$svc_name")"
    [ -n "$svc" ] || continue
    for var in PREVIEW_PROXY_BASE_URL NEXT_PUBLIC_PREVIEW_PROXY_BASE_URL PREVIEW_DOMAINS; do
      upsert_var "$svc" "$var" "\${{api.${var}}}"
    done
  done

  say "Redeploying app services to pick up the preview variables..."
  for svc_name in api web controller bullmq preview-proxy; do
    svc="$(service_id "$svc_name")"
    [ -n "$svc" ] || continue
    if act "railway: redeploy $svc_name"; then continue; fi
    gql 'mutation ($environmentId: String!, $serviceId: String!) {
      serviceInstanceDeploy(environmentId: $environmentId, serviceId: $serviceId, latestCommit: false)
    }' "$(jq -n --arg environmentId "$environment_id" --arg serviceId "$svc" \
          '{environmentId: $environmentId, serviceId: $serviceId}')" > /dev/null
  done
fi

# ------------------------------------------------------- phase 5: summary

say ""
say "Onboarding staged for ${customer}:"
say "  App URL:    https://${app_domain}"
if $previews; then
  say "  Previews:   https://${previews_domain} (wildcard *.${previews_domain})"
fi
say "  Setup URL:  https://${app_domain}/setup"
say ""
say "Next steps:"
say "  - Railway verifies DNS and issues certificates in the background;"
say "    domains typically go active within minutes of DNS propagation."
say "  - Read SETUP_TOKEN from the api service's Variables tab and open the"
say "    setup URL with it (/setup?token=<value>)."
if $previews; then
  say "  - After first login, opt in at Settings -> Live Previews."
fi
say "  - The deploy-railway-fleet job will keep this deployment pinned to"
say "    each main build automatically (no CI change needed)."
