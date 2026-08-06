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

# V8 sizes its default heap ceiling from the memory it can see, which in a
# container is the host's total, not the container's limit. With that much
# perceived headroom it defers full GCs for hours, so the long-running
# services drift multiple GB above their ~300-400 MB working sets — billed
# directly on usage-priced hosts — and a container memory cap OOM-kills the
# process before V8 ever feels pressure. Cap old space explicitly instead:
# an operator --max-old-space-size in NODE_OPTIONS always wins, and a
# readable cgroup memory limit lowers (never raises) the service default
# to ~75% of the container's memory.
apply_node_heap_cap() {
  case "${NODE_OPTIONS:-}" in
    *--max-old-space-size*) return 0 ;;
  esac

  cap_mb="$1"

  # Container runtimes usually mount the container's own cgroup at
  # /sys/fs/cgroup, but some expose the host's whole hierarchy; there the
  # mount-root files read unlimited and the real limit lives under the
  # process's own path from /proc/self/cgroup, so try that path first.
  # cgroup v1 reports "unlimited" as a page-rounded near-int64 number; the
  # derived_mb < cap_mb comparison below already treats it as no limit.
  self_v2="$(sed -n 's/^0:://p' /proc/self/cgroup 2>/dev/null | head -n 1)"

  limit_bytes=""
  if [ -n "$self_v2" ] && [ -r "/sys/fs/cgroup${self_v2}/memory.max" ]; then
    limit_bytes="$(cat "/sys/fs/cgroup${self_v2}/memory.max")"
  elif [ -r /sys/fs/cgroup/memory.max ]; then
    limit_bytes="$(cat /sys/fs/cgroup/memory.max)"
  else
    self_v1="$(grep -E '^[0-9]+:([^:]*,)?memory(,[^:]*)?:' /proc/self/cgroup 2>/dev/null | head -n 1 | cut -d: -f3)"
    # The v1 memory hierarchy can be co-mounted with other controllers at a
    # combined path, so resolve its mount point from /proc/self/mountinfo
    # (mountpoint is the 5th field before the " - " separator; filesystem
    # type and super options are the 1st and 3rd after it).
    v1_mount="$(awk -F' - ' '{
      split($1, l, " "); split($2, r, " ");
      if (r[1] == "cgroup" && ("," r[3] ",") ~ /,memory,/) { print l[5]; exit }
    }' /proc/self/mountinfo 2>/dev/null || :)"
    [ -n "$v1_mount" ] || v1_mount=/sys/fs/cgroup/memory

    if [ -n "$self_v1" ] && [ -r "${v1_mount}${self_v1}/memory.limit_in_bytes" ]; then
      limit_bytes="$(cat "${v1_mount}${self_v1}/memory.limit_in_bytes")"
    elif [ -r "${v1_mount}/memory.limit_in_bytes" ]; then
      limit_bytes="$(cat "${v1_mount}/memory.limit_in_bytes")"
    fi
  fi
  case "$limit_bytes" in
    '' | *[!0-9]*) ;; # v2 "max" means unlimited; keep the service default
    *)
      derived_mb=$((limit_bytes / 1048576 * 3 / 4))
      if [ "$derived_mb" -gt 0 ] && [ "$derived_mb" -lt "$cap_mb" ]; then
        cap_mb="$derived_mb"
      fi
      ;;
  esac

  export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--max-old-space-size=${cap_mb}"
}

case "$service" in
  web)
    # The Next.js standalone server binds to HOSTNAME; Docker's default
    # HOSTNAME env is the container id, so pin it to all interfaces.
    export HOSTNAME=0.0.0.0
    export PORT="${PORT:-3000}"
    apply_node_heap_cap 768
    cd /roomote/apps/web
    exec /roomote/.docker/run-with-dotenvx.sh node server.js "$@"
    ;;
  api)
    apply_node_heap_cap 768
    cd /roomote/apps/api
    exec /roomote/.docker/run-with-dotenvx.sh node dist/index.js "$@"
    ;;
  controller)
    apply_node_heap_cap 512
    cd /roomote/apps/controller
    exec /roomote/.docker/run-with-dotenvx.sh node --import ./dist/instrument.js ./dist/index.js "$@"
    ;;
  bullmq)
    apply_node_heap_cap 512
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
