#!/usr/bin/env bash
#
# Roomote one-command installer for a single self-managed host.
#
#   curl -fsSL https://get.roomote.dev | bash
#
# get.roomote.dev serves this file and mirrors the release lookup and
# deployment-file fetches (see deploy/get-roomote/README.md); GitHub is the
# direct fallback:
#
#   curl -fsSL https://raw.githubusercontent.com/RooCodeInc/Roomote/develop/deploy/install.sh | bash
#
# With no arguments this installs Docker if needed, generates every secret,
# derives a zero-DNS sslip.io domain from the host's public IP, starts the
# production Compose stack from published GHCR images, and prints a /setup
# link. Everything else is configured in the browser.
#
# Bring your own domain (recommended for production):
#
#   curl -fsSL https://get.roomote.dev | bash -s -- --domain roomote.example.com
#
# Re-running is safe: an existing /opt/roomote/.env keeps its secrets and only
# deployment-owned metadata (image tags, URLs) is refreshed.
set -euo pipefail

# The whole script is a function called on the last line, so bash parses the
# entire file before executing anything and a download truncated mid-transfer
# cannot run a partial install. The body is deliberately not re-indented.
main() {

usage() {
  cat <<'EOF'
usage: install.sh [options]

Options:
  --domain <host>            Public app hostname (default: roomote.<ip>.sslip.io)
  --preview-domain <host>    Dedicated preview hostname (default: flat
                             <task>-<port>-preview.<domain> hostnames)
  --tls-mode <acme|internal> TLS certificate mode (default: acme)
  --skip-dns-check           Skip public-DNS verification for --domain
  --version <tag>            Roomote image tag (default: latest GitHub release)
  --repo <owner/name>        GitHub repo for compose/Caddyfile fetch
                             (default: RooCodeInc/Roomote)
  --image-registry <host>    Image registry (default: ghcr.io)
  --image-namespace <ns>     Image namespace (default: roocodeinc)
  --help                     Show this help

Environment overrides:
  ROOMOTE_VERSION
  ROOMOTE_TLS_MODE            Certificate mode: acme or internal
  ROOMOTE_FETCH_BASE           Mirror for the release lookup and deployment
                               file fetches (default https://get.roomote.dev
                               for the official repo; GitHub is the fallback)
  GITHUB_TOKEN                 Token for GitHub API + raw file fetches while
                               the source repo is private
  ROOMOTE_INSTALL_SOURCE_DIR   Copy compose/Caddyfile/CLI from a local checkout
                               instead of fetching from GitHub (for testing)
  ROOMOTE_INSTALL_SKIP_ARCH_CHECK=1   Allow architectures other than x86_64/arm64
EOF
}

github_curl() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "$@"
  else
    curl -fsSL "$@"
  fi
}

log() {
  printf '\033[1;32m==>\033[0m %s\n' "$*"
}

warn() {
  printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2
}

die() {
  printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

domain=''
preview_domain=''
preview_subdomain_suffix=''
tls_mode="${ROOMOTE_TLS_MODE:-}"
skip_dns_check='false'
roomote_version="${ROOMOTE_VERSION:-}"
repo='RooCodeInc/Roomote'
image_registry='ghcr.io'
image_namespace='roocodeinc'
source_dir="${ROOMOTE_INSTALL_SOURCE_DIR:-}"
install_root='/opt/roomote'

while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain)
      domain="${2:-}"
      shift 2
      ;;
    --preview-domain)
      preview_domain="${2:-}"
      shift 2
      ;;
    --tls-mode)
      tls_mode="${2:-}"
      shift 2
      ;;
    --skip-dns-check)
      skip_dns_check='true'
      shift
      ;;
    --version)
      roomote_version="${2:-}"
      shift 2
      ;;
    --repo)
      repo="${2:-}"
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

# get.roomote.dev mirrors the release lookup and the deployment-file fetches
# so installs work while the source repo is private (deploy/get-roomote/).
# It only serves the official repo, so a --repo fork goes straight to GitHub;
# direct GitHub is always the fallback when the mirror is unreachable.
fetch_base="${ROOMOTE_FETCH_BASE:-}"
if [ -z "$fetch_base" ] && [ "$repo" = 'RooCodeInc/Roomote' ]; then
  fetch_base='https://get.roomote.dev'
fi

# --- Preflight ---------------------------------------------------------------

# Before anything else (including the root check, so nobody sudo-pipes a
# script for nothing): this installer manages Docker, systemd, and /opt on
# the host, so it only runs on a Linux server. The non-Linux message is
# OS-specific so macOS/Windows users get the Docker Compose local-evaluation
# path instead of trying to adapt this dedicated-server installer.
host_kernel="$(uname -s)"
if [ "$host_kernel" != 'Linux' ]; then
  case "$host_kernel" in
    Darwin)
      die "$(cat <<'EOF'
this installer sets up a Linux server (Ubuntu/Debian, x86_64 or arm64) and
cannot run on macOS.

For local evaluation on this Mac, use Docker Desktop and Roomote's checked-in
Docker Compose files instead:

  https://docs.roomote.dev/self-hosting/agent-installation

For production, SSH into the Ubuntu/Debian server you want to run Roomote on
and run the installer there (or look for alternatives in https://docs.roomote.dev).
For local development on this machine, clone
the repo and use 'pnpm dev' instead (see README.md).
EOF
)"
      ;;
    MINGW* | MSYS* | CYGWIN*)
      die "$(cat <<'EOF'
this installer sets up a Linux server (Ubuntu/Debian, x86_64 or arm64) and
cannot run on Windows.

For local evaluation on this Windows machine, use Docker Desktop with Linux
containers and Roomote's checked-in Docker Compose files instead:

  https://docs.roomote.dev/self-hosting/agent-installation

For production, SSH into the Ubuntu/Debian server you want to run Roomote on
and run the installer there.
EOF
)"
      ;;
    *)
      die "$(cat <<EOF
this installer sets up a Linux server (Ubuntu/Debian, x86_64 or arm64) and
cannot run on ${host_kernel}.

SSH into the Ubuntu/Debian server you want to run Roomote on and run the
installer there:

  curl -fsSL https://get.roomote.dev | sudo bash

For local development on this machine, clone the repo and use 'pnpm dev'
instead (see README.md).
EOF
)"
      ;;
  esac
fi

if [ "$(id -u)" -ne 0 ]; then
  die "run as root, e.g.: curl -fsSL https://get.roomote.dev | sudo bash -s -- [options]"
fi

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v openssl >/dev/null 2>&1 || die "openssl is required"

arch="$(uname -m)"
case "$arch" in
  x86_64) worker_platform='linux/amd64' ;;
  aarch64 | arm64) worker_platform='linux/arm64' ;;
  *)
    worker_platform='linux/amd64'
    if [ "${ROOMOTE_INSTALL_SKIP_ARCH_CHECK:-}" != "1" ]; then
      die "Roomote images are published for linux/amd64 and linux/arm64 and this host is $arch. Set ROOMOTE_INSTALL_SKIP_ARCH_CHECK=1 to continue anyway (expect emulation or failures)."
    fi
    ;;
esac

if [ -r /proc/meminfo ]; then
  mem_kb="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
  if [ -n "$mem_kb" ] && [ "$mem_kb" -lt 3500000 ]; then
    warn "This host has less than 4 GB of RAM. Task workers run on this host; expect memory pressure."
  fi
fi

os_supported='false'
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-} ${ID_LIKE:-}" in
    *debian* | *ubuntu*) os_supported='true' ;;
  esac
fi

if [ "$os_supported" != "true" ] && ! command -v docker >/dev/null 2>&1; then
  die "unsupported OS for automatic Docker install (Ubuntu/Debian only). Install Docker Engine with Compose manually and re-run."
fi

# --- Version resolution ------------------------------------------------------

resolve_latest_version() {
  local api="https://api.github.com/repos/$repo"
  local latest=''

  if [ -n "$fetch_base" ]; then
    latest="$(curl -fsSL --max-time 15 "$fetch_base/latest-version" 2>/dev/null |
      tr -d '[:space:]')" || true
    case "$latest" in
      v[0-9]*) ;;
      *) latest='' ;;
    esac
  fi

  if [ -z "$latest" ]; then
    latest="$(github_curl "$api/releases/latest" 2>/dev/null |
      awk -F'"' '/"tag_name":/ { print $4; exit }')" || true
  fi

  if [ -z "$latest" ]; then
    # GitHub's tag listing is not guaranteed newest-first; version-sort it.
    latest="$(github_curl "$api/tags?per_page=100" 2>/dev/null |
      awk -F'"' '/"name":/ { print $4 }' |
      grep -E '^v[0-9]' | sort -rV | head -n 1)" || true
  fi

  printf '%s' "$latest"
}

if [ -z "$roomote_version" ]; then
  log "Resolving the latest Roomote release"
  roomote_version="$(resolve_latest_version)"
  [ -n "$roomote_version" ] || die "could not resolve a release tag from github.com/$repo; pass --version explicitly"
fi
log "Installing Roomote $roomote_version"

# --- Domains -----------------------------------------------------------------

read_saved_env_value() {
  # Accepts the same line shapes set_env_value writes and rewrites:
  # optional leading whitespace, an optional "export " prefix, and values
  # containing '='.
  local file="$1"
  local key="$2"
  awk -v key="$key" '
    BEGIN { pattern = "^[[:space:]]*(export[[:space:]]+)?" key "=" }
    $0 ~ pattern {
      sub(/^[^=]*=/, "")
      print
      exit
    }
  ' "$file"
}

detect_public_ip() {
  local ip
  for endpoint in 'https://api.ipify.org' 'https://ifconfig.me/ip' 'https://ipinfo.io/ip'; do
    ip="$(curl -fsS --max-time 10 "$endpoint" 2>/dev/null | tr -d '[:space:]')" || true
    if printf '%s' "$ip" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
      printf '%s' "$ip"
      return 0
    fi
  done
  return 1
}

saved_app_domain=''
saved_preview_domain=''
saved_preview_subdomain_suffix=''
if [ -f "$install_root/.env" ]; then
  saved_app_domain="$(read_saved_env_value "$install_root/.env" ROOMOTE_APP_DOMAIN)"
  saved_preview_domain="$(read_saved_env_value "$install_root/.env" ROOMOTE_PREVIEW_DOMAIN)"
  saved_preview_subdomain_suffix="$(read_saved_env_value "$install_root/.env" PREVIEW_PROXY_SUBDOMAIN_SUFFIX)"
fi

if [ -z "$domain" ] && [ -n "$saved_app_domain" ]; then
  domain="$saved_app_domain"
  log "Reusing the existing domain $domain from $install_root/.env"
fi

if [ -z "$tls_mode" ] && [ -f "$install_root/.env" ]; then
  tls_mode="$(read_saved_env_value "$install_root/.env" ROOMOTE_TLS_MODE)"
fi
tls_mode="${tls_mode:-acme}"
case "$tls_mode" in
  acme | internal) ;;
  *) die "--tls-mode must be acme or internal" ;;
esac

public_ip=''
if [ -z "$domain" ]; then
  if [ "$tls_mode" = 'internal' ]; then
    die "--tls-mode internal requires --domain <host>"
  fi
  public_ip="$(detect_public_ip)" || public_ip=''
  [ -n "$public_ip" ] || die "could not detect this host's public IPv4 address; pass --domain instead"
  domain="roomote.$(printf '%s' "$public_ip" | tr '.' '-').sslip.io"
  log "No --domain given; using the zero-DNS default $domain"
  warn "sslip.io domains share Let's Encrypt rate limits and are tied to this IP. Use --domain for production."
else
  if [ "$skip_dns_check" = 'true' ] || [ "$tls_mode" = 'internal' ]; then
    log "Skipping public DNS verification for $domain"
  else
    public_ip="$(detect_public_ip)" || public_ip=''
  fi
  if [ -n "$public_ip" ]; then
    log "Checking that $domain resolves to $public_ip"
    resolved=''
    for _attempt in $(seq 1 12); do
      resolved="$(getent hosts "$domain" 2>/dev/null | awk '{ print $1; exit }')" || true
      [ "$resolved" = "$public_ip" ] && break
      printf '  waiting for DNS (%s -> %s, want %s)...\n' "$domain" "${resolved:-unresolved}" "$public_ip"
      sleep 15
    done
    if [ "$resolved" != "$public_ip" ]; then
      warn "$domain does not resolve to $public_ip yet. Continuing; Caddy will retry certificates once DNS is in place."
    fi
  fi
fi

if [ -z "$preview_domain" ] && [ -n "$saved_preview_domain" ]; then
  if [ "$saved_preview_domain" = "$saved_app_domain" ]; then
    # Flat layout: previews follow the app domain, including across a rerun
    # that changes --domain.
    preview_domain="$domain"
  else
    preview_domain="$saved_preview_domain"
    if [ -n "$saved_app_domain" ] && [ "$saved_app_domain" != "$domain" ]; then
      warn "Keeping the dedicated preview domain $preview_domain from $install_root/.env; pass --preview-domain if previews should follow the new app domain $domain."
    fi
  fi
fi

if [ -z "$preview_domain" ]; then
  # Fresh installs (and reruns whose .env predates preview settings) default
  # to flat preview hostnames.
  preview_domain="$domain"
fi

if [ "$preview_domain" = "$domain" ]; then
  # Flat layouts always carry a subdomain suffix so preview hostnames stay
  # inside the reserved "-<suffix>" namespace, even when --preview-domain
  # restates the app domain explicitly.
  preview_subdomain_suffix="${saved_preview_subdomain_suffix:-preview}"
else
  preview_subdomain_suffix="$saved_preview_subdomain_suffix"
fi

# --- Docker ------------------------------------------------------------------

if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker Engine"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi

docker compose version >/dev/null 2>&1 || die "docker compose plugin is required"

if [ ! -f "$install_root/.env" ]; then
  for port in 80 443; do
    if command -v ss >/dev/null 2>&1 && ss -ltn "( sport = :$port )" 2>/dev/null | grep -q LISTEN; then
      die "port $port is already in use on this host; Roomote's Caddy needs 80 and 443"
    fi
  done
fi

# --- Deployment files --------------------------------------------------------

log "Writing deployment files to $install_root"
install -d -m 0700 "$install_root" "$install_root/caddy" "$install_root/backups"

# v* versions are git tags, so deployment files are fetched at the matching
# tag. develop-<sha> versions are image-only tags; fall back to the develop
# branch for those.
fetch_ref="$roomote_version"
case "$roomote_version" in
  v[0-9]*) ;;
  *) fetch_ref='develop' ;;
esac

fetch_file() {
  local source_path="$1"
  local target_path="$2"

  if [ -n "$source_dir" ]; then
    cp "$source_dir/$source_path" "$target_path"
    return
  fi

  if [ -n "$fetch_base" ] &&
    curl -fsSL "$fetch_base/raw/$fetch_ref/$source_path" -o "$target_path" 2>/dev/null; then
    return
  fi

  github_curl "https://raw.githubusercontent.com/$repo/$fetch_ref/$source_path" -o "$target_path"
}

fetch_file deploy/compose/docker-compose.prod.yml "$install_root/docker-compose.prod.yml"
fetch_file deploy/caddy/Caddyfile "$install_root/caddy/Caddyfile"
fetch_file deploy/host/roomote /usr/local/bin/roomote
chmod 0755 /usr/local/bin/roomote

# --- Env assembly ------------------------------------------------------------

env_file="$install_root/.env"

set_env_value() {
  local key="$1"
  local value="$2"
  local tmp_file

  tmp_file="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN {
      seen = 0
      pattern = "^[[:space:]]*(export[[:space:]]+)?" key "="
    }
    $0 ~ pattern {
      if (!seen) {
        print key "=" value
        seen = 1
      }
      next
    }
    { print }
    END {
      if (!seen) {
        print key "=" value
      }
    }
  ' "$env_file" >"$tmp_file"
  cat "$tmp_file" >"$env_file"
  rm -f "$tmp_file"
}

env_has_value() {
  local key="$1"
  grep -Eq "^[[:space:]]*(export[[:space:]]+)?${key}=." "$env_file"
}

read_env_value() {
  read_saved_env_value "$env_file" "$1"
}

generate_p256_keypair() {
  # Prints "<private-base64> <public-base64>" for one P-256 keypair.
  local workdir
  workdir="$(mktemp -d)"
  openssl ecparam -name prime256v1 -genkey -noout -out "$workdir/private.pem"
  openssl pkcs8 -topk8 -nocrypt -in "$workdir/private.pem" -out "$workdir/private-pkcs8.pem"
  openssl ec -in "$workdir/private.pem" -pubout -out "$workdir/public.pem" 2>/dev/null
  printf '%s %s' \
    "$(base64 <"$workdir/private-pkcs8.pem" | tr -d '\n')" \
    "$(base64 <"$workdir/public.pem" | tr -d '\n')"
  rm -rf "$workdir"
}

if [ -f "$env_file" ]; then
  log "Existing $env_file found; keeping secrets and refreshing deployment metadata"
else
  log "Generating secrets"
  umask 077
  touch "$env_file"

  read -r job_auth_private job_auth_public <<<"$(generate_p256_keypair)"
  read -r preview_auth_private preview_auth_public <<<"$(generate_p256_keypair)"
  # hex keeps the password safe to interpolate into the DATABASE_URL.
  postgres_password="$(openssl rand -hex 24)"

  set_env_value R_APP_ENV production
  set_env_value POSTGRES_PASSWORD "$postgres_password"
  set_env_value DATABASE_URL "postgres://postgres:$postgres_password@postgres:5432/roomote"
  set_env_value REDIS_URL 'redis://redis:6379'
  set_env_value S3_ENDPOINT 'http://minio:9000'
  set_env_value S3_PRESIGN_ENDPOINT 'http://minio:9000'
  set_env_value S3_REGION 'us-east-1'
  set_env_value S3_ACCESS_KEY_ID 'roomote'
  set_env_value S3_SECRET_ACCESS_KEY "$(openssl rand -base64 32 | tr -d '\n')"
  set_env_value S3_BUCKET_ARTIFACTS 'roomote-artifacts'
  set_env_value JOB_AUTH_PRIVATE_KEY "$job_auth_private"
  set_env_value JOB_AUTH_PUBLIC_KEY "$job_auth_public"
  set_env_value PREVIEW_AUTH_PRIVATE_KEY "$preview_auth_private"
  set_env_value PREVIEW_AUTH_PUBLIC_KEY "$preview_auth_public"
  set_env_value ENCRYPTION_KEY "$(openssl rand -base64 32 | tr -d '\n')"
  set_env_value ARTIFACT_SIGNING_KEY "$(openssl rand -base64 32 | tr -d '\n')"
  set_env_value DASHBOARD_PASSWORD "$(openssl rand -base64 24 | tr -d '\n')"
  set_env_value DEFAULT_COMPUTE_PROVIDER docker
  set_env_value COMPOSE_PROFILES local-postgres
fi

# The setup token gates the pre-auth /setup wizard. Generate it even for
# pre-existing env files that don't have one yet.
if ! env_has_value SETUP_TOKEN; then
  set_env_value SETUP_TOKEN "$(openssl rand -hex 16)"
fi

# Dedicated Discord gateway↔API transport secret. Always generate one so
# enabling Discord later is ready without a separate operator step.
if ! env_has_value R_DISCORD_GATEWAY_SECRET; then
  set_env_value R_DISCORD_GATEWAY_SECRET "$(openssl rand -base64 32 | tr -d '\n')"
fi

worker_image="$image_registry/$image_namespace/roomote-worker:$roomote_version"

# The published worker image doubles as the Modal worker base image. Keep
# MODAL_BASE_IMAGE_REF installer-managed while it is blank or still equal to
# the previously configured worker image, so operators who pick Modal in the
# setup wizard only need their Modal token pair. A different non-empty value
# is an operator override and is left untouched.
previous_worker_image="$(read_env_value DOCKER_WORKER_IMAGE)"
modal_base_image_ref="$(read_env_value MODAL_BASE_IMAGE_REF)"
if [ -z "$modal_base_image_ref" ] || [ "$modal_base_image_ref" = "$previous_worker_image" ]; then
  set_env_value MODAL_BASE_IMAGE_REF "$worker_image"
fi

set_env_value ROOMOTE_VERSION "$roomote_version"
set_env_value ROOMOTE_REPO "$repo"
set_env_value ROOMOTE_APP_DOMAIN "$domain"
set_env_value ROOMOTE_PREVIEW_DOMAIN "$preview_domain"
set_env_value PREVIEW_PROXY_SUBDOMAIN_SUFFIX "$preview_subdomain_suffix"
set_env_value ROOMOTE_TLS_MODE "$tls_mode"
if [ "$tls_mode" = 'internal' ]; then
  set_env_value ROOMOTE_CADDY_LOCAL_CERTS 'local_certs'
  set_env_value ROOMOTE_CADDY_WILDCARD_TLS_SNIPPET ''
else
  set_env_value ROOMOTE_CADDY_LOCAL_CERTS ''
  set_env_value ROOMOTE_CADDY_WILDCARD_TLS_SNIPPET 'import roomote_on_demand_wildcard_tls'
fi
set_env_value TRPC_URL "https://$domain/_roomote-api"
set_env_value IMAGE_REGISTRY "$image_registry"
set_env_value IMAGE_NAMESPACE "$image_namespace"
set_env_value DOCKER_WORKER_IMAGE "$worker_image"
set_env_value DOCKER_WORKER_PLATFORM "$worker_platform"
set_env_value DOCKER_WORKER_NETWORK 'roomote_worker'
# worker-current.tar.gz is baked into every app image alongside the
# worker-v<version> archive and always matches the running image, including
# for mutable channel tags like develop where the env version and the image's
# baked RELEASE_VERSION differ.
set_env_value DOCKER_WORKER_RELEASE_PATH '/roomote/releases/worker-current.tar.gz'

chown root:root "$env_file"
chmod 600 "$env_file"

# --- systemd unit ------------------------------------------------------------

# systemd ExecStart needs an absolute path, and a pre-existing Docker install
# may live outside /usr/bin (snap, manual binary).
docker_bin="$(command -v docker)"

cat >/etc/systemd/system/roomote-compose.service <<EOF
[Unit]
Description=Roomote Docker Compose stack
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$install_root
RemainAfterExit=yes
ExecStart=$docker_bin compose --env-file $install_root/.env -f $install_root/docker-compose.prod.yml up -d --wait --wait-timeout 600
ExecStop=$docker_bin compose --env-file $install_root/.env -f $install_root/docker-compose.prod.yml down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable roomote-compose.service >/dev/null 2>&1

# --- Start the stack ---------------------------------------------------------

cd "$install_root"
log "Validating the Compose configuration"
docker compose --env-file .env -f docker-compose.prod.yml config >/dev/null

log "Pulling application images (this can take a few minutes)"
docker compose --env-file .env -f docker-compose.prod.yml pull

log "Starting Roomote"
docker compose --env-file .env -f docker-compose.prod.yml up -d --wait --wait-timeout 600

# The worker image is only needed once the first task runs, so it downloads
# in the background while the operator finishes setup in the browser.
log "Downloading the task worker image in the background"
nohup sh -c "docker pull $(printf '%q' "$worker_image") >>/var/log/roomote-worker-pull.log 2>&1" >/dev/null 2>&1 &

setup_token="$(awk -F= '/^SETUP_TOKEN=/ { print $2; exit }' .env)"

cat <<EOF

Roomote is up. One step left:

  ==> Open this link to create your admin account:

      https://$domain/setup?token=$setup_token

If the browser shows a TLS error in acme mode, the certificate is still being
issued -- wait a minute and reload.

Manage later with the roomote command: roomote status | logs | upgrade | backup
EOF

}

main "$@"
