#!/bin/sh
# Service dispatcher for the shared Roomote app image (.docker/app/Dockerfile).
# The first argument selects which bundled service to run:
#
#   docker run ghcr.io/roocodeinc/roomote-app:<version> api
set -eu

service="${1:-}"
if [ "$#" -gt 0 ]; then
  shift
fi

# Some PaaS blueprints (Render) can wire another service's hostname into an
# env var but cannot compose "https://<hostname>" strings, and Render's
# dockerCommand parser passes quote characters through literally, so a
# `sh -c '...'` prelude cannot do it either. Derive the URL-shaped variables
# from host-only references here instead; explicitly set values always win.
#
# A service's very first container can snapshot its environment before its
# own hostname propagates into the blueprint's cross-service reference,
# leaving the self-referencing host variable empty. Render injects the
# service's own hostname directly as RENDER_EXTERNAL_HOSTNAME (never via a
# reference), so fall back to it for the self-referencing case.
case "$service" in
  web) : "${ROOMOTE_WEB_HOST:=${RENDER_EXTERNAL_HOSTNAME:-}}" ;;
  api) : "${ROOMOTE_API_HOST:=${RENDER_EXTERNAL_HOSTNAME:-}}" ;;
esac
if [ -z "${R_APP_URL:-}" ] && [ -n "${ROOMOTE_WEB_HOST:-}" ]; then
  export R_APP_URL="https://${ROOMOTE_WEB_HOST}"
fi
if [ -z "${TRPC_URL:-}" ] && [ -n "${ROOMOTE_API_HOST:-}" ]; then
  export TRPC_URL="https://${ROOMOTE_API_HOST}"
fi
if [ -z "${S3_ENDPOINT:-}" ] && [ -n "${ROOMOTE_MINIO_HOSTPORT:-}" ]; then
  export S3_ENDPOINT="http://${ROOMOTE_MINIO_HOSTPORT}"
fi
if [ -z "${S3_PRESIGN_ENDPOINT:-}" ] && [ -n "${ROOMOTE_MINIO_HOST:-}" ]; then
  export S3_PRESIGN_ENDPOINT="https://${ROOMOTE_MINIO_HOST}"
fi

case "$service" in
  web)
    # The Next.js standalone server binds to HOSTNAME; Docker's default
    # HOSTNAME env is the container id, so pin it to all interfaces.
    export HOSTNAME=0.0.0.0
    export PORT="${PORT:-3000}"
    cd /roomote/apps/web
    exec /roomote/.docker/run-with-dotenvx.sh node server.js "$@"
    ;;
  api)
    cd /roomote/apps/api
    exec /roomote/.docker/run-with-dotenvx.sh node dist/index.js "$@"
    ;;
  controller)
    cd /roomote/apps/controller
    exec /roomote/.docker/run-with-dotenvx.sh node --import ./dist/instrument.js ./dist/index.js "$@"
    ;;
  bullmq)
    cd /roomote/apps/bullmq
    exec /roomote/.docker/run-with-dotenvx.sh node dist/index.js "$@"
    ;;
  preview-proxy)
    exec /entrypoint.sh "$@"
    ;;
  db-migrate)
    exec /roomote/.docker/run-with-dotenvx.sh node /roomote/migrate/migrate.mjs "$@"
    ;;
  *)
    echo "roomote-app: unknown service '${service}'." >&2
    echo "Usage: <web|api|controller|bullmq|preview-proxy|db-migrate> [args...]" >&2
    exit 64
    ;;
esac
