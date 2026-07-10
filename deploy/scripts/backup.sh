#!/usr/bin/env bash
set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() {
  cat <<'EOF'
usage: deploy/scripts/backup.sh --customer <slug> [options]

Options:
  --host <host>             SSH host or IP when Terraform state is unavailable
  --ssh-user <user>         SSH user (default: root)
  --ssh-private-key <path>  Private key for SSH
  --output-dir <dir>        Local backup directory (default: deploy/state/<customer>/backups)
EOF
}

customer=''
host=''
ssh_user='root'
ssh_private_key=''
output_dir=''

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

host="$(resolve_host "$customer" "$host")"
target="$ssh_user@$host"
configure_ssh_args "$ssh_private_key"

if [ -z "$output_dir" ]; then
  output_dir="$(customer_state_dir "$customer")/backups"
fi
mkdir -p "$output_dir"

printf 'Creating Postgres backup on %s\n' "$target"
remote_backup="$(
  ssh "${ssh_args[@]}" "$target" <<'REMOTE'
set -euo pipefail
cd /opt/roomote
mkdir -p backups
backup="backups/backup-$(date +%F-%H%M%S).sql"
docker run --rm --network roomote_default --env-file /opt/roomote/.env postgres:17.5@sha256:aadf2c0696f5ef357aa7a68da995137f0cf17bad0bf6e1f17de06ae5c769b302 sh -c 'pg_dump --clean --if-exists --no-owner --no-privileges "$DATABASE_URL"' > "$backup"
chmod 600 "$backup"
printf '/opt/roomote/%s\n' "$backup"
REMOTE
)"

scp "${scp_args[@]}" "$target:$remote_backup" "$output_dir/"
printf 'Backup complete: %s/%s\n' "$output_dir" "$(basename "$remote_backup")"
