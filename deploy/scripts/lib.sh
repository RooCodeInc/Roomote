#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
deploy_root="$(cd -- "$script_dir/.." && pwd)"
repo_root="$(cd -- "$deploy_root/.." && pwd)"
tf_dir="$deploy_root/providers/digitalocean"
default_state_root="$deploy_root/state"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

abs_path() {
  local path="$1"
  if [ -d "$path" ]; then
    (cd "$path" && pwd)
    return
  fi

  local dir
  dir="$(cd -- "$(dirname -- "$path")" && pwd)"
  printf '%s/%s\n' "$dir" "$(basename -- "$path")"
}

state_root() {
  abs_path "${ROOMOTE_DEPLOY_STATE_DIR:-$default_state_root}"
}

customer_state_dir() {
  local customer="$1"
  printf '%s/%s\n' "$(state_root)" "$customer"
}

validate_slug() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || die "customer slug must be 3-63 lower-case letters, numbers, or hyphens"
}

validate_domain() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$ ]] || die "invalid domain: $1"
}

validate_image_part() {
  [[ "$1" =~ ^[A-Za-z0-9._/-]+$ ]] || die "invalid image registry or namespace value: $1"
}

validate_tag() {
  [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid image tag: $1"
}

validate_positive_integer() {
  local value="$1"
  local label="$2"

  [[ "$value" =~ ^[1-9][0-9]*$ ]] || die "$label must be a positive integer"
}

env_has_key() {
  local env_file="$1"
  local key="$2"
  grep -Eq "^[[:space:]]*(export[[:space:]]+)?${key}=" "$env_file"
}

read_env_value() {
  local env_file="$1"
  local key="$2"

  awk -v key="$key" '
    BEGIN { pattern = "^[[:space:]]*(export[[:space:]]+)?" key "=" }
    $0 ~ pattern {
      sub(/^[^=]*=/, "")
      print
      exit
    }
  ' "$env_file"
}

append_env_if_missing() {
  local env_file="$1"
  local key="$2"
  local value="$3"

  if ! env_has_key "$env_file" "$key"; then
    printf '%s=%s\n' "$key" "$value" >>"$env_file"
  fi
}

set_env_value() {
  local env_file="$1"
  local key="$2"
  local value="$3"
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

remove_env_key() {
  local env_file="$1"
  local key="$2"
  local tmp_file

  tmp_file="$(mktemp)"
  awk -v key="$key" '
    BEGIN {
      pattern = "^[[:space:]]*(export[[:space:]]+)?" key "="
    }
    $0 ~ pattern { next }
    { print }
  ' "$env_file" >"$tmp_file"
  cat "$tmp_file" >"$env_file"
  rm -f "$tmp_file"
}

default_ssh_public_key_file() {
  if [ -f "$HOME/.ssh/id_ed25519.pub" ]; then
    printf '%s/.ssh/id_ed25519.pub\n' "$HOME"
    return
  fi

  if [ -f "$HOME/.ssh/id_rsa.pub" ]; then
    printf '%s/.ssh/id_rsa.pub\n' "$HOME"
    return
  fi

  return 1
}

read_public_key() {
  local value="$1"
  if [ -f "$value" ]; then
    cat "$value"
  else
    printf '%s\n' "$value"
  fi
}

hcl_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

hcl_list() {
  local first=1
  printf '['
  for value in "$@"; do
    if [ "$first" -eq 0 ]; then
      printf ', '
    fi
    hcl_string "$value"
    first=0
  done
  printf ']'
}

terraform_state_file() {
  local customer="$1"
  printf '%s/terraform.tfstate\n' "$(customer_state_dir "$customer")"
}

terraform_tfvars_file() {
  local customer="$1"
  printf '%s/terraform.tfvars\n' "$(customer_state_dir "$customer")"
}

read_tfvars_value() {
  # Reads a top-level string value from a tfvars file this tooling generated
  # (one "key = \"value\"" per line, tolerating extra alignment whitespace).
  local tfvars_file="$1"
  local key="$2"
  awk -v key="$key" '
    $1 == key && $2 == "=" {
      value = $3
      gsub(/^"|"$/, "", value)
      print value
      exit
    }
  ' "$tfvars_file"
}

terraform_output_raw() {
  local customer="$1"
  local output_name="$2"
  local state_file
  state_file="$(terraform_state_file "$customer")"
  terraform -chdir="$tf_dir" output -state="$state_file" -raw "$output_name"
}

ssh_args=()
scp_args=()

configure_ssh_args() {
  local ssh_private_key="$1"
  ssh_args=(-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=20)
  scp_args=(-o StrictHostKeyChecking=accept-new)

  if [ -n "$ssh_private_key" ]; then
    ssh_args+=(-i "$ssh_private_key")
    scp_args+=(-i "$ssh_private_key")
  fi
}

shell_quote() {
  local value="$1"
  printf "'%s'" "${value//\'/\'\\\'\'}"
}

resolve_host() {
  local customer="$1"
  local explicit_host="$2"

  if [ -n "$explicit_host" ]; then
    printf '%s\n' "$explicit_host"
    return
  fi

  [ -f "$(terraform_state_file "$customer")" ] || die "no Terraform state for $customer; pass --host"
  terraform_output_raw "$customer" ipv4_address
}

write_metadata_json() {
  local customer="$1"
  local domain="$2"
  local preview_domain="$3"
  local version="$4"
  local ip="$5"
  local provider="$6"
  local region="$7"
  local state_dir="$8"

  cat >"$state_dir/deployment.json" <<JSON
{
  "customer": "$customer",
  "provider": "$provider",
  "region": "$region",
  "domain": "$domain",
  "previewDomain": "$preview_domain",
  "version": "$version",
  "url": "https://$domain",
  "apiUrl": "https://$domain/_roomote-api",
  "previewUrl": "https://$preview_domain",
  "ipv4Address": "$ip",
  "sshCommand": "ssh root@$ip"
}
JSON
}
