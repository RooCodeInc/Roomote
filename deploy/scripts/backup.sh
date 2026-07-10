#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=lib.sh
# shellcheck disable=SC2154 # ssh_args and scp_args are initialized by configure_ssh_args.
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() {
  cat <<'EOF'
usage: deploy/scripts/backup.sh --customer <slug> [options]

Options:
  --host <host>             SSH host or IP when Terraform state is unavailable
  --ssh-user <user>         SSH user (default: root)
  --ssh-private-key <path>  Private key for SSH
  --output-dir <dir>        Local backup directory (default: deploy/state/<customer>/backups)
  --passphrase-file <path>  File containing the bundle encryption passphrase
  --include-redis           Preserve queues, schedules, and transient state

ROOMOTE_BACKUP_PASSPHRASE may be used instead of --passphrase-file.
EOF
}

customer=''
host=''
ssh_user='root'
ssh_private_key=''
output_dir=''
passphrase_file=''
include_redis='false'
generated_passphrase='false'

while [ "$#" -gt 0 ]; do
  case "$1" in
    --customer)
      customer="${2:-}"
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
    --output-dir)
      output_dir="$(abs_path "${2:-}")"
      shift 2
      ;;
    --passphrase-file)
      passphrase_file="$(abs_path "${2:-}")"
      shift 2
      ;;
    --include-redis)
      include_redis='true'
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
validate_slug "$customer"
require_cmd ssh
require_cmd scp
[ -z "$passphrase_file" ] || [ -s "$passphrase_file" ] || die "passphrase file not found or empty: $passphrase_file"

if [ -z "$passphrase_file" ]; then
  [ -n "${ROOMOTE_BACKUP_PASSPHRASE:-}" ] || die "--passphrase-file or ROOMOTE_BACKUP_PASSPHRASE is required"
  [ ${#ROOMOTE_BACKUP_PASSPHRASE} -ge 12 ] || die "ROOMOTE_BACKUP_PASSPHRASE must be at least 12 characters"
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

host="$(resolve_host "$customer" "$host")"
target="$ssh_user@$host"
configure_ssh_args "$ssh_private_key"

if [ -z "$output_dir" ]; then
  output_dir="$(customer_state_dir "$customer")/backups"
fi
mkdir -p "$output_dir"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
remote_backup="/opt/roomote/backups/backup-$timestamp.roomote"
remote_passphrase="/opt/roomote/backups/.backup-passphrase-$timestamp"
remote_redis_arg=''
[ "$include_redis" = 'false' ] || remote_redis_arg=' --include-redis'

printf 'Copying the encryption passphrase to %s for this operation\n' "$target"
ssh "${ssh_args[@]}" "$target" 'install -d -m 0700 /opt/roomote/backups'
scp "${scp_args[@]}" "$passphrase_file" "$target:$remote_passphrase"
ssh "${ssh_args[@]}" "$target" "chmod 600 $(shell_quote "$remote_passphrase")"

printf 'Creating encrypted deployment backup on %s\n' "$target"
if ! ssh "${ssh_args[@]}" "$target" \
  "trap \"rm -f $remote_passphrase\" EXIT; roomote backup --passphrase-file $(shell_quote "$remote_passphrase") --output $(shell_quote "$remote_backup")$remote_redis_arg"; then
  die "remote backup failed"
fi

scp "${scp_args[@]}" "$target:$remote_backup" "$output_dir/"
printf 'Backup complete: %s/%s\n' "$output_dir" "$(basename "$remote_backup")"
