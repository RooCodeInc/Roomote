#!/usr/bin/env bash
set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() {
  cat <<'EOF'
usage: deploy/scripts/deploy.sh --customer <slug> --domain <host> --env <file> [options]

Required:
  --customer <slug>              Stable deployment slug
  --domain <host>                Public Roomote app hostname
  --env <file>                   Operator dotenv file copied to /opt/roomote/.env

Options:
  --provider digitalocean        Only supported provider for V1
  --region <slug>                DigitalOcean region (default: nyc3)
  --droplet-size <slug>          DigitalOcean size (default: s-2vcpu-4gb)
  --version <tag>                Immutable Roomote image tag (default: ROOMOTE_VERSION or v0.1.0)
  --preview-domain <host>        Dedicated preview hostname (default: flat
                                 <task>-<port>-preview.<domain> hostnames)
  --image-registry <host>        Registry (default: ghcr.io)
  --image-namespace <namespace>  Registry namespace (default: roocodeinc)
  --database local|external      local starts Compose Postgres; external requires DATABASE_URL (default: local)
  --ssh-public-key <path|key>    Public key or file (default: ~/.ssh/id_ed25519.pub or id_rsa.pub)
  --ssh-key-fingerprint <fp>     Existing DigitalOcean SSH key fingerprint
  --ssh-private-key <path>       Private key for bootstrap SSH
  --ssh-allowed-cidr <cidr>      Repeatable SSH allowlist CIDR (default: 0.0.0.0/0 and ::/0)
  --manage-dns                  Create app and wildcard preview A records
  --dns-zone <zone>              DigitalOcean DNS zone used with --manage-dns
  --image-retention-releases <n> Keep this many Roomote release tags on the host after deploy (default: 3)
EOF
}

customer=''
provider='digitalocean'
region='nyc3'
droplet_size='s-2vcpu-4gb'
domain=''
preview_domain=''
preview_subdomain_suffix=''
env_file=''
roomote_version="${ROOMOTE_VERSION:-v0.1.0}"
image_registry='ghcr.io'
image_namespace='roocodeinc'
database_mode='local'
ssh_public_key=''
ssh_key_fingerprint=''
ssh_private_key=''
ssh_allowed_cidrs=()
manage_dns='false'
dns_zone=''
image_retention_releases="${ROOMOTE_IMAGE_RETENTION_RELEASES:-3}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --customer)
      customer="${2:-}"
      shift 2
      ;;
    --provider)
      provider="${2:-}"
      shift 2
      ;;
    --region)
      region="${2:-}"
      shift 2
      ;;
    --droplet-size)
      droplet_size="${2:-}"
      shift 2
      ;;
    --domain)
      domain="${2:-}"
      shift 2
      ;;
    --preview-domain)
      preview_domain="${2:-}"
      shift 2
      ;;
    --env)
      env_file="${2:-}"
      shift 2
      ;;
    --version)
      roomote_version="${2:-}"
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
    --database)
      database_mode="${2:-}"
      shift 2
      ;;
    --ssh-public-key)
      ssh_public_key="${2:-}"
      shift 2
      ;;
    --ssh-key-fingerprint)
      ssh_key_fingerprint="${2:-}"
      shift 2
      ;;
    --ssh-private-key)
      ssh_private_key="$(abs_path "${2:-}")"
      shift 2
      ;;
    --ssh-allowed-cidr)
      ssh_allowed_cidrs+=("${2:-}")
      shift 2
      ;;
    --manage-dns)
      manage_dns='true'
      shift
      ;;
    --dns-zone)
      dns_zone="${2:-}"
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

[ "$provider" = "digitalocean" ] || die "only --provider digitalocean is supported"
[ -n "$customer" ] || die "--customer is required"
[ -n "$domain" ] || die "--domain is required"
[ -n "$env_file" ] || die "--env is required"
[ -f "$env_file" ] || die "env file not found: $env_file"
validate_slug "$customer"
validate_domain "$domain"
validate_tag "$roomote_version"
validate_image_part "$image_registry"
validate_image_part "$image_namespace"
validate_positive_integer "$image_retention_releases" "--image-retention-releases"

state_dir="$(customer_state_dir "$customer")"
tfvars_file="$(terraform_tfvars_file "$customer")"
configured_preview_subdomain_suffix="$(read_env_value "$env_file" PREVIEW_PROXY_SUBDOMAIN_SUFFIX)"

if [ -z "$preview_domain" ] && [ -f "$tfvars_file" ]; then
  previous_domain="$(read_tfvars_value "$tfvars_file" domain)"
  previous_preview_domain="$(read_tfvars_value "$tfvars_file" preview_domain)"
  if [ -n "$previous_preview_domain" ] && [ "$previous_preview_domain" = "$previous_domain" ]; then
    # Flat layout: previews follow the app domain, including across a rerun
    # that changes --domain.
    preview_domain="$domain"
  else
    preview_domain="$previous_preview_domain"
    if [ -n "$preview_domain" ] && [ "$previous_domain" != "$domain" ]; then
      printf 'warning: keeping the dedicated preview domain %s from %s; pass --preview-domain if previews should follow the new app domain %s\n' \
        "$preview_domain" "$tfvars_file" "$domain" >&2
    fi
  fi
fi

if [ -z "$preview_domain" ]; then
  preview_domain="$domain"
fi
# Operator-configured suffixes always pass through; flat layouts (preview
# domain == app domain) additionally require one so preview hostnames stay
# inside the reserved "-<suffix>" namespace.
preview_subdomain_suffix="$configured_preview_subdomain_suffix"
if [ "$preview_domain" = "$domain" ] && [ -z "$preview_subdomain_suffix" ]; then
  preview_subdomain_suffix='preview'
fi
validate_domain "$preview_domain"

case "$database_mode" in
  local | external) ;;
  *) die "--database must be local or external" ;;
esac

if [ "$database_mode" = "external" ] && ! env_has_key "$env_file" DATABASE_URL; then
  die "--database external requires DATABASE_URL in $env_file"
fi

if [ "$manage_dns" = "true" ] && [ -z "$dns_zone" ]; then
  die "--dns-zone is required with --manage-dns"
fi

if [ "${#ssh_allowed_cidrs[@]}" -eq 0 ]; then
  ssh_allowed_cidrs=("0.0.0.0/0" "::/0")
fi

if [ -z "$ssh_key_fingerprint" ] && [ -z "$ssh_public_key" ]; then
  ssh_public_key="$(default_ssh_public_key_file)" || die "no SSH public key found; pass --ssh-public-key or --ssh-key-fingerprint"
fi

if [ -z "${DIGITALOCEAN_TOKEN:-}" ] && [ -z "${DIGITALOCEAN_ACCESS_TOKEN:-}" ]; then
  die "set DIGITALOCEAN_TOKEN before running Terraform"
fi

require_cmd terraform
require_cmd ssh
require_cmd scp

mkdir -p "$state_dir"

public_key_value=''
if [ -n "$ssh_public_key" ]; then
  public_key_value="$(read_public_key "$ssh_public_key")"
fi

{
  printf 'customer_slug = '
  hcl_string "$customer"
  printf '\nregion = '
  hcl_string "$region"
  printf '\ndroplet_size = '
  hcl_string "$droplet_size"
  printf '\ndomain = '
  hcl_string "$domain"
  printf '\npreview_domain = '
  hcl_string "$preview_domain"
  printf '\nroomote_version = '
  hcl_string "$roomote_version"
  printf '\nimage_registry = '
  hcl_string "$image_registry"
  printf '\nimage_namespace = '
  hcl_string "$image_namespace"
  printf '\nssh_public_key = <<EOT\n%s\nEOT\n' "$public_key_value"
  printf 'ssh_key_fingerprint = '
  hcl_string "$ssh_key_fingerprint"
  printf '\nssh_allowed_cidrs = '
  hcl_list "${ssh_allowed_cidrs[@]}"
  printf '\nmanage_dns = %s\n' "$manage_dns"
  printf 'dns_zone = '
  hcl_string "$dns_zone"
  printf '\n'
} >"$tfvars_file"
chmod 600 "$tfvars_file"

printf 'Initializing Terraform in %s\n' "$tf_dir"
terraform -chdir="$tf_dir" init

state_file="$(terraform_state_file "$customer")"
printf 'Applying DigitalOcean deployment for %s\n' "$customer"
terraform -chdir="$tf_dir" apply -state="$state_file" -var-file="$tfvars_file" -auto-approve

ip_address="$(terraform_output_raw "$customer" ipv4_address)"
target="root@$ip_address"
configure_ssh_args "$ssh_private_key"

printf 'Waiting for SSH and cloud-init on %s\n' "$target"
for attempt in $(seq 1 60); do
  if ssh "${ssh_args[@]}" -o BatchMode=yes -o ConnectTimeout=5 "$target" 'true' >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    die "timed out waiting for SSH on $target"
  fi
  sleep 5
done

ssh "${ssh_args[@]}" "$target" 'cloud-init status --wait >/dev/null 2>&1 || true'

tmp_env="$(mktemp)"
trap 'rm -f "$tmp_env" "${tmp_token:-}"' EXIT
cp "$env_file" "$tmp_env"
printf '\n' >>"$tmp_env"
worker_image="$image_registry/$image_namespace/roomote-worker:$roomote_version"
# worker-current.tar.gz always matches the running image (see install.sh).
worker_release_path="/roomote/releases/worker-current.tar.gz"
previous_worker_image="$(read_env_value "$tmp_env" DOCKER_WORKER_IMAGE)"

set_env_value "$tmp_env" ROOMOTE_VERSION "$roomote_version"
set_env_value "$tmp_env" ROOMOTE_APP_DOMAIN "$domain"
set_env_value "$tmp_env" ROOMOTE_PREVIEW_DOMAIN "$preview_domain"
set_env_value "$tmp_env" PREVIEW_PROXY_SUBDOMAIN_SUFFIX "$preview_subdomain_suffix"
set_env_value "$tmp_env" TRPC_URL "https://$domain/_roomote-api"
remove_env_key "$tmp_env" ROOMOTE_API_DOMAIN
set_env_value "$tmp_env" IMAGE_REGISTRY "$image_registry"
set_env_value "$tmp_env" IMAGE_NAMESPACE "$image_namespace"
set_env_value "$tmp_env" DOCKER_WORKER_IMAGE "$worker_image"
# The V1 deployer provisions amd64 DigitalOcean droplets only.
set_env_value "$tmp_env" DOCKER_WORKER_PLATFORM "linux/amd64"
set_env_value "$tmp_env" DOCKER_WORKER_NETWORK "roomote_worker"
set_env_value "$tmp_env" DOCKER_WORKER_RELEASE_PATH "$worker_release_path"
set_env_value "$tmp_env" ROOMOTE_DATABASE_MODE "$database_mode"

# Keep the deployer-managed Modal base image ref in sync with the worker
# image. The wizard stores the selected sandbox provider in the database, not
# in the env file, so this must not gate on DEFAULT_COMPUTE_PROVIDER. A
# different non-empty value is an operator override and is left untouched.
modal_base_image_ref="$(read_env_value "$tmp_env" MODAL_BASE_IMAGE_REF)"
if [ -z "$modal_base_image_ref" ] || [ "$modal_base_image_ref" = "$previous_worker_image" ]; then
  set_env_value "$tmp_env" MODAL_BASE_IMAGE_REF "$worker_image"
fi

# Compose profiles are derived, not hand-managed: the Brain runs exactly
# when the deployment has a Brain key, mirroring the app's own activation
# signal so the two can never disagree.
compose_profiles=""
if [ "$database_mode" = "local" ]; then
  compose_profiles="local-postgres"
fi

# Must match isBrainConfigured: the app enqueues memories whenever it
# believes a Brain exists, so the container has to run under exactly the same
# condition or those memories pile up with nothing to drain them.
if [ -n "$(read_env_value "$tmp_env" R_BRAIN_GATEWAY_TOKEN)" ] ||
  [ -n "$(read_env_value "$tmp_env" R_BRAIN_OPENROUTER_API_KEY)" ] ||
  [ -n "$(read_env_value "$tmp_env" R_BRAIN_OPENAI_API_KEY)" ]; then
  if [ -n "$compose_profiles" ]; then
    compose_profiles="$compose_profiles,brain"
  else
    compose_profiles="brain"
  fi

  # The gateway token is what the Brain authenticates with, so a deployment
  # that only set a provider key would bring the container up with nothing to
  # present and no way to embed. Generated here rather than asked for: it is
  # shared between two of our own services and never typed by anyone.
  if [ -z "$(read_env_value "$tmp_env" R_BRAIN_GATEWAY_TOKEN)" ]; then
    set_env_value "$tmp_env" R_BRAIN_GATEWAY_TOKEN "$(openssl rand -hex 24)"
  fi
fi

if [ -n "$compose_profiles" ]; then
  set_env_value "$tmp_env" COMPOSE_PROFILES "$compose_profiles"
else
  remove_env_key "$tmp_env" COMPOSE_PROFILES
fi

printf 'Copying Compose, Caddy, and env files to %s\n' "$target"
ssh "${ssh_args[@]}" "$target" 'install -d -m 0700 /opt/roomote /opt/roomote/caddy /opt/roomote/backups'
scp "${scp_args[@]}" "$deploy_root/compose/docker-compose.prod.yml" "$target:/opt/roomote/docker-compose.prod.yml"
scp "${scp_args[@]}" "$deploy_root/caddy/Caddyfile" "$target:/opt/roomote/caddy/Caddyfile"
scp "${scp_args[@]}" "$tmp_env" "$target:/tmp/roomote.env"
ssh "${ssh_args[@]}" "$target" 'mv /tmp/roomote.env /opt/roomote/.env && chown root:root /opt/roomote/.env && chmod 600 /opt/roomote/.env'

printf 'Pulling images and starting Roomote %s\n' "$roomote_version"
ssh "${ssh_args[@]}" "$target" "ROOMOTE_WORKER_IMAGE=$(shell_quote "$worker_image") bash -s" <<'REMOTE'
set -euo pipefail
: "${ROOMOTE_WORKER_IMAGE:?ROOMOTE_WORKER_IMAGE is required}"
cd /opt/roomote
if [ -f /etc/systemd/system/roomote-compose.service ]; then
  sed -i '/^EnvironmentFile=-\/opt\/roomote\/deployment.env$/d' /etc/systemd/system/roomote-compose.service
  systemctl daemon-reload
fi
docker compose --env-file .env -f docker-compose.prod.yml config >/dev/null
echo "Stopping controller before image pull so new tasks remain queued during deploy"
docker compose --env-file .env -f docker-compose.prod.yml stop controller || true
docker pull "$ROOMOTE_WORKER_IMAGE"
docker compose --env-file .env -f docker-compose.prod.yml pull
docker compose --env-file .env -f docker-compose.prod.yml up -d --wait --wait-timeout 600
systemctl enable roomote-compose.service
REMOTE

printf 'Pruning old Roomote images on %s; keeping %s release tag(s)\n' "$target" "$image_retention_releases"
if ! ssh "${ssh_args[@]}" "$target" \
  "ROOMOTE_IMAGE_RETENTION_RELEASES=$(shell_quote "$image_retention_releases") bash -s" \
  <"$script_dir/prune-release-images.sh"; then
  printf 'warning: image retention step failed on %s; deployment is still healthy\n' "$target" >&2
fi

write_metadata_json "$customer" "$domain" "$preview_domain" "$roomote_version" "$ip_address" "$provider" "$region" "$state_dir"

cat <<EOF
Roomote deployment created.

Customer: $customer
Version:  $roomote_version
URL:      https://$domain
Worker API URL: https://$domain/_roomote-api
Preview:  https://$preview_domain
IP:       $ip_address
SSH:      ssh root@$ip_address
State:    $state_dir
EOF
