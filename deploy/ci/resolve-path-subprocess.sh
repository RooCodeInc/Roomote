#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/../scripts/lib.sh"

case "$1" in
  path)
    resolved="$(abs_path "$2")"
    printf '%s\n' "$resolved"
    ;;
  state)
    customer_state_dir "$2"
    terraform_state_file "$2"
    terraform_tfvars_file "$2"
    ;;
  *) exit 1 ;;
esac
