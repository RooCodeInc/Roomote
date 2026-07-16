#!/usr/bin/env bash
set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() {
  cat <<'EOF'
usage: deploy/scripts/upgrade.sh --customer <slug> --version <tag> [options]

Options:
  --host <host>                  SSH host or IP when Terraform state is unavailable
  --ssh-user <user>              SSH user (default: root)
  --ssh-private-key <path>       Private key for SSH
  --image-registry <host>        Registry (default: current .env value or ghcr.io)
  --image-namespace <namespace>  Registry namespace (default: current .env value or roocodeinc)
  --image-retention-releases <n> Keep this many Roomote release tags on the host after upgrade (default: 3)
EOF
}

customer=''
version=''
host=''
ssh_user='root'
ssh_private_key=''
image_registry=''
image_namespace=''
image_retention_releases="${ROOMOTE_IMAGE_RETENTION_RELEASES:-3}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --customer)
      customer="${2:-}"
      shift 2
      ;;
    --version)
      version="${2:-}"
      shift 2
      ;;
    --host)
      host="${2:-}"
      shift 2
      ;;
    --ssh-user)
      ssh_user="${2:-}"
      shift 2
      ;;
    --ssh-private-key)
      ssh_private_key="$(abs_path "${2:-}")"
      shift 2
      ;;
    --image-registry)
      image_registry="${2:-}"
      shift 2
      ;;
    --image-namespace)
      image_namespace="${2:-}"
      shift 2
      ;;
    --image-retention-releases)
      image_retention_releases="${2:-}"
      shift 2
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
done

[ -n "$customer" ] || die "--customer is required"
[ -n "$version" ] || die "--version is required"
validate_slug "$customer"
validate_tag "$version"
[ -z "$image_registry" ] || validate_image_part "$image_registry"
[ -z "$image_namespace" ] || validate_image_part "$image_namespace"
validate_positive_integer "$image_retention_releases" "--image-retention-releases"
require_cmd ssh
require_cmd scp

host="$(resolve_host "$customer" "$host")"
target="$ssh_user@$host"
configure_ssh_args "$ssh_private_key"

printf 'Upgrading %s on %s to %s\n' "$customer" "$target" "$version"
printf 'Copying updated Compose and Caddy files to %s\n' "$target"
ssh "${ssh_args[@]}" "$target" 'install -d -m 0700 /opt/roomote /opt/roomote/caddy'
scp "${scp_args[@]}" "$deploy_root/compose/docker-compose.prod.yml" "$target:/opt/roomote/docker-compose.prod.yml"
scp "${scp_args[@]}" "$deploy_root/caddy/Caddyfile" "$target:/opt/roomote/caddy/Caddyfile"

ssh "${ssh_args[@]}" "$target" \
  "ROOMOTE_VERSION=$(shell_quote "$version") ROOMOTE_IMAGE_REGISTRY_ARG=$(shell_quote "$image_registry") ROOMOTE_IMAGE_NAMESPACE_ARG=$(shell_quote "$image_namespace") bash -s" <<'REMOTE'
set -euo pipefail
cd /opt/roomote

if [ -f /etc/systemd/system/roomote-compose.service ]; then
  sed -i '/^EnvironmentFile=-\/opt\/roomote\/deployment.env$/d' /etc/systemd/system/roomote-compose.service
  systemctl daemon-reload
fi
docker compose --env-file .env -f docker-compose.prod.yml config >/dev/null
echo "Stopping controller before deployment metadata changes so new tasks remain queued during deploy"
docker compose --env-file .env -f docker-compose.prod.yml stop controller || true

read_env_value() {
  local key="$1"
  awk -v key="$key" '
    BEGIN { pattern = "^[[:space:]]*(export[[:space:]]+)?" key "=" }
    $0 ~ pattern {
      sub(/^[^=]*=/, "")
      print
      exit
    }
  ' .env
}

image_registry="${ROOMOTE_IMAGE_REGISTRY_ARG:-$(read_env_value IMAGE_REGISTRY)}"
image_namespace="${ROOMOTE_IMAGE_NAMESPACE_ARG:-$(read_env_value IMAGE_NAMESPACE)}"
image_registry="${image_registry:-ghcr.io}"
image_namespace="${image_namespace:-roocodeinc}"
previous_worker_image="$(read_env_value DOCKER_WORKER_IMAGE)"
worker_image="$image_registry/$image_namespace/roomote-worker:$ROOMOTE_VERSION"
# worker-current.tar.gz always matches the running image (see install.sh).
worker_release_path="/roomote/releases/worker-current.tar.gz"
# Keep the installer/deployer-managed Modal base image ref in sync with the
# new worker image. The wizard stores the selected sandbox provider in the
# database, not in the env file, so this must not gate on
# DEFAULT_COMPUTE_PROVIDER. A different non-empty value is an operator
# override and is left untouched.
modal_base_image_ref="$(read_env_value MODAL_BASE_IMAGE_REF)"
sync_modal_base_image_ref=false
if [ -z "$modal_base_image_ref" ] || [ "$modal_base_image_ref" = "$previous_worker_image" ]; then
  modal_base_image_ref="$worker_image"
  sync_modal_base_image_ref=true
fi
app_domain="$(read_env_value ROOMOTE_APP_DOMAIN)"
[ -n "$app_domain" ] || {
  echo "Unable to read ROOMOTE_APP_DOMAIN from /opt/roomote/.env" >&2
  exit 1
}
trpc_url="https://$app_domain/_roomote-api"

tmp_env="$(mktemp)"
awk \
  -v version="$ROOMOTE_VERSION" \
  -v trpc_url="$trpc_url" \
  -v image_registry="$image_registry" \
  -v image_namespace="$image_namespace" \
  -v worker_image="$worker_image" \
  -v worker_release_path="$worker_release_path" \
  -v modal_base_image_ref="$modal_base_image_ref" \
  -v sync_modal_base_image_ref="$sync_modal_base_image_ref" '
  BEGIN {
    seen_version = 0
    seen_registry = 0
    seen_namespace = 0
    seen_worker = 0
    seen_worker_release_path = 0
    seen_modal_base_image_ref = 0
    seen_trpc = 0
  }
  /^(export[[:space:]]+)?ROOMOTE_VERSION=/ {
    print "ROOMOTE_VERSION=" version
    seen_version = 1
    next
  }
  /^(export[[:space:]]+)?IMAGE_REGISTRY=/ {
    print "IMAGE_REGISTRY=" image_registry
    seen_registry = 1
    next
  }
  /^(export[[:space:]]+)?IMAGE_NAMESPACE=/ {
    print "IMAGE_NAMESPACE=" image_namespace
    seen_namespace = 1
    next
  }
  /^(export[[:space:]]+)?DOCKER_WORKER_IMAGE=/ {
    print "DOCKER_WORKER_IMAGE=" worker_image
    seen_worker = 1
    next
  }
  /^(export[[:space:]]+)?DOCKER_WORKER_RELEASE_PATH=/ {
    print "DOCKER_WORKER_RELEASE_PATH=" worker_release_path
    seen_worker_release_path = 1
    next
  }
  sync_modal_base_image_ref == "true" && /^(export[[:space:]]+)?MODAL_BASE_IMAGE_REF=/ {
    print "MODAL_BASE_IMAGE_REF=" modal_base_image_ref
    seen_modal_base_image_ref = 1
    next
  }
  /^(export[[:space:]]+)?ROOMOTE_API_DOMAIN=/ {
    next
  }
  /^(export[[:space:]]+)?TRPC_URL=/ {
    print "TRPC_URL=" trpc_url
    seen_trpc = 1
    next
  }
  { print }
  END {
    if (!seen_version) {
      print "ROOMOTE_VERSION=" version
    }
    if (!seen_registry) {
      print "IMAGE_REGISTRY=" image_registry
    }
    if (!seen_namespace) {
      print "IMAGE_NAMESPACE=" image_namespace
    }
    if (!seen_worker) {
      print "DOCKER_WORKER_IMAGE=" worker_image
    }
    if (!seen_worker_release_path) {
      print "DOCKER_WORKER_RELEASE_PATH=" worker_release_path
    }
    if (sync_modal_base_image_ref == "true" && !seen_modal_base_image_ref) {
      print "MODAL_BASE_IMAGE_REF=" modal_base_image_ref
    }
    if (!seen_trpc) {
      print "TRPC_URL=" trpc_url
    }
  }
' .env > "$tmp_env"
cat "$tmp_env" > .env
rm -f "$tmp_env"
chmod 600 .env

# Production no longer accepts ENCRYPTION_KEY as Discord gateway auth.
# Generate a dedicated transport secret on first upgrade when missing so
# Discord-enabled deployments keep forwarding after the rollout.
if [ -z "$(read_env_value R_DISCORD_GATEWAY_SECRET | tr -d '[:space:]')" ]; then
  secret="$(openssl rand -base64 32 | tr -d '\n')"
  tmp_env="$(mktemp)"
  awk -v secret="$secret" '
    BEGIN {
      seen = 0
      pattern = "^[[:space:]]*(export[[:space:]]+)?R_DISCORD_GATEWAY_SECRET="
    }
    $0 ~ pattern {
      if (!seen) {
        print "R_DISCORD_GATEWAY_SECRET=" secret
        seen = 1
      }
      next
    }
    { print }
    END {
      if (!seen) {
        print "R_DISCORD_GATEWAY_SECRET=" secret
      }
    }
  ' .env > "$tmp_env"
  cat "$tmp_env" > .env
  rm -f "$tmp_env"
  chmod 600 .env
  echo "Generated R_DISCORD_GATEWAY_SECRET for Discord gateway↔API auth"
fi

docker compose --env-file .env -f docker-compose.prod.yml config >/dev/null
docker pull "$worker_image"
docker compose --env-file .env -f docker-compose.prod.yml pull
# Migrations run before any running service is replaced. Drizzle applies all
# pending migrations in a single transaction, so a failure here rolls the
# schema back while the previous release keeps serving.
echo "Applying database migrations before replacing running services"
if ! docker compose --env-file .env -f docker-compose.prod.yml run --rm db-migrate; then
  echo "Database migrations failed and were rolled back; the previous release keeps serving." >&2
  echo "Restarting the previous controller. Re-run roomote-deploy upgrade with the previous tag to restore deployment metadata, or fix the migration and retry." >&2
  docker compose --env-file .env -f docker-compose.prod.yml start controller || true
  exit 1
fi
docker compose --env-file .env -f docker-compose.prod.yml up -d --wait --wait-timeout 600
systemctl enable roomote-compose.service
REMOTE

printf 'Pruning old Roomote images on %s; keeping %s release tag(s)\n' "$target" "$image_retention_releases"
if ! ssh "${ssh_args[@]}" "$target" \
  "ROOMOTE_IMAGE_RETENTION_RELEASES=$(shell_quote "$image_retention_releases") bash -s" \
  <"$script_dir/prune-release-images.sh"; then
  printf 'warning: image retention step failed on %s; upgrade is still healthy\n' "$target" >&2
fi

printf 'Upgrade complete: %s is now configured for %s\n' "$customer" "$version"
