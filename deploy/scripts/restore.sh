#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=lib.sh
# shellcheck disable=SC2154 # ssh_args and scp_args are initialized by configure_ssh_args.
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() {
  cat <<'EOF'
usage: deploy/scripts/restore.sh --customer <slug> --backup <file> --yes [options]

Options:
  --host <host>             SSH host or IP when Terraform state is unavailable
  --ssh-user <user>         SSH user (default: root)
  --ssh-private-key <path>  Private key for SSH
  --passphrase-file <path>  File containing the bundle encryption passphrase
  --yes                     Required to skip the confirmation prompt

ROOMOTE_BACKUP_PASSPHRASE may be used instead of --passphrase-file.
EOF
}

customer=''
backup_file=''
host=''
ssh_user='root'
ssh_private_key=''
assume_yes='false'
passphrase_file=''
generated_passphrase='false'

while [ "$#" -gt 0 ]; do
  case "$1" in
    --customer)
      customer="${2:-}"
      shift 2
      ;;
    --backup)
      backup_file="$(abs_path "${2:-}")"
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
    --passphrase-file)
      passphrase_file="$(abs_path "${2:-}")"
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

[ -n "$customer" ] || die "--customer is required"
[ -n "$backup_file" ] || die "--backup is required"
[ -f "$backup_file" ] || die "backup file not found: $backup_file"
validate_slug "$customer"
require_cmd ssh
require_cmd scp
[ -z "$passphrase_file" ] || [ -s "$passphrase_file" ] || die "passphrase file not found or empty: $passphrase_file"

if [ -z "$passphrase_file" ]; then
  [ -n "${ROOMOTE_BACKUP_PASSPHRASE:-}" ] || die "--passphrase-file or ROOMOTE_BACKUP_PASSPHRASE is required"
  passphrase_file="$(mktemp)"
  chmod 600 "$passphrase_file"
  printf '%s' "$ROOMOTE_BACKUP_PASSPHRASE" >"$passphrase_file"
  generated_passphrase='true'
fi

cleanup() {
  if [ "$generated_passphrase" = 'true' ]; then
    rm -f "$passphrase_file"
  fi
}
trap cleanup EXIT

if [ "$assume_yes" != "true" ]; then
  printf 'This will restore %s into %s. Type the customer slug to continue: ' "$backup_file" "$customer" >&2
  read -r confirmation
  [ "$confirmation" = "$customer" ] || die "confirmation did not match"
fi

host="$(resolve_host "$customer" "$host")"
target="$ssh_user@$host"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
remote_backup="/opt/roomote/backups/restore-$timestamp.roomote"
remote_passphrase="/opt/roomote/backups/.restore-passphrase-$timestamp"
configure_ssh_args "$ssh_private_key"

printf 'Copying backup bundle and one-time passphrase to %s\n' "$target"
ssh "${ssh_args[@]}" "$target" 'mkdir -p /opt/roomote/backups && chmod 700 /opt/roomote/backups'
scp "${scp_args[@]}" "$backup_file" "$target:$remote_backup"
scp "${scp_args[@]}" "$passphrase_file" "$target:$remote_passphrase"
ssh "${ssh_args[@]}" "$target" "chmod 600 $(shell_quote "$remote_backup") $(shell_quote "$remote_passphrase")"

printf 'Restoring deployment bundle\n'
if ! ssh "${ssh_args[@]}" "$target" \
  "trap \"rm -f $remote_passphrase\" EXIT; roomote restore $(shell_quote "$remote_backup") --yes --passphrase-file $(shell_quote "$remote_passphrase")"; then
  die "remote restore failed; the deployment may remain stopped for inspection"
fi

printf 'Restore complete for %s\n' "$customer"
