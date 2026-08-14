#!/usr/bin/env bash
set -euo pipefail

# Deployments without outer preview routing omit named-port host variables.
# Keep the Roomote development stack usable there; only nested preview URLs
# are unavailable.
if [[ -z "${ROOMOTE_PREVIEW_HOST:-}" ]]; then
  exec "$@"
fi

preview_url="$ROOMOTE_PREVIEW_HOST"
preview_scheme="${preview_url%%://*}"
preview_host="${preview_url#*://}"
preview_host="${preview_host%%/*}"
preview_suffix="${preview_host%%.*}"
preview_base_host="${preview_host#*.}"

if [[ "$preview_scheme" != "http" && "$preview_scheme" != "https" ]]; then
  echo "Unsupported preview URL scheme: $preview_scheme" >&2
  exit 1
fi

if [[ "$preview_base_host" == "$preview_host" ]]; then
  echo "ROOMOTE_PREVIEW_HOST must contain a task-specific subdomain" >&2
  exit 1
fi

export PREVIEW_PROXY_BASE_URL="${preview_scheme}://${preview_base_host}"
export PREVIEW_PROXY_SUBDOMAIN_SUFFIX="$preview_suffix"
export PREVIEW_DOMAINS="${preview_base_host%%:*}"
export NEXT_PUBLIC_PREVIEW_PROXY_BASE_URL="$PREVIEW_PROXY_BASE_URL"
export NEXT_PUBLIC_PREVIEW_PROXY_SUBDOMAIN_SUFFIX="$preview_suffix"

exec "$@"
