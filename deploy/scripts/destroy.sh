#!/usr/bin/env bash
set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() {
  cat <<'EOF'
usage: deploy/scripts/destroy.sh --customer <slug> --yes

Options:
  --provider digitalocean        Only supported provider for V1
  --yes                          Required to skip the confirmation prompt
EOF
}

customer=''
provider='digitalocean'
assume_yes='false'

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
    --yes | -y)
      assume_yes='true'
      shift
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
validate_slug "$customer"
[ -f "$(terraform_state_file "$customer")" ] || die "no Terraform state found for $customer"
[ -f "$(terraform_tfvars_file "$customer")" ] || die "no Terraform tfvars found for $customer"

if [ -z "${DIGITALOCEAN_TOKEN:-}" ] && [ -z "${DIGITALOCEAN_ACCESS_TOKEN:-}" ]; then
  die "set DIGITALOCEAN_TOKEN before running Terraform"
fi

if [ "$assume_yes" != "true" ]; then
  printf 'This will destroy the Roomote deployment for %s. Type the customer slug to continue: ' "$customer" >&2
  read -r confirmation
  [ "$confirmation" = "$customer" ] || die "confirmation did not match"
fi

require_cmd terraform

printf 'Destroying DigitalOcean deployment for %s\n' "$customer"
terraform -chdir="$tf_dir" init
terraform -chdir="$tf_dir" destroy \
  -state="$(terraform_state_file "$customer")" \
  -var-file="$(terraform_tfvars_file "$customer")" \
  -auto-approve

printf 'Destroy complete. Local state remains in %s for audit purposes.\n' "$(customer_state_dir "$customer")"
