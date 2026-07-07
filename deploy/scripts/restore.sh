#!/usr/bin/env bash
set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() {
  cat <<'EOF'
usage: deploy/scripts/restore.sh --customer <slug> --backup <file> --yes [options]

Options:
  --host <host>             SSH host or IP when Terraform state is unavailable
  --ssh-user <user>         SSH user (default: root)
  --ssh-private-key <path>  Private key for SSH
  --yes                     Required to skip the confirmation prompt
EOF
}

customer=''
backup_file=''
host=''
ssh_user='root'
ssh_private_key=''
assume_yes='false'

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

if [ "$assume_yes" != "true" ]; then
  printf 'This will restore %s into %s. Type the customer slug to continue: ' "$backup_file" "$customer" >&2
  read -r confirmation
  [ "$confirmation" = "$customer" ] || die "confirmation did not match"
fi

host="$(resolve_host "$customer" "$host")"
target="$ssh_user@$host"
remote_backup="/opt/roomote/backups/restore-$(date +%F-%H%M%S).sql"
configure_ssh_args "$ssh_private_key"

printf 'Copying backup to %s\n' "$target"
ssh "${ssh_args[@]}" "$target" 'mkdir -p /opt/roomote/backups && chmod 700 /opt/roomote/backups'
scp "${scp_args[@]}" "$backup_file" "$target:$remote_backup"
ssh "${ssh_args[@]}" "$target" "chmod 600 $(shell_quote "$remote_backup")"

printf 'Restoring backup into deployment database\n'
ssh "${ssh_args[@]}" "$target" "ROOMOTE_RESTORE_BACKUP=$(shell_quote "$remote_backup") bash -s" <<'REMOTE'
set -euo pipefail
cd /opt/roomote
# Quiesce the app services so live connections are not killed mid-restore and
# nothing writes to the database while the dump loads.
docker compose --env-file .env -f docker-compose.prod.yml stop web api controller bullmq preview-proxy
docker run --rm --network roomote_default --env-file /opt/roomote/.env postgres:17.5 sh -c 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"'
docker run --rm --network roomote_default --env-file /opt/roomote/.env -i postgres:17.5 sh -c 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1' < "$ROOMOTE_RESTORE_BACKUP"
docker compose --env-file .env -f docker-compose.prod.yml up -d --wait --wait-timeout 600
REMOTE

printf 'Restore complete for %s\n' "$customer"
