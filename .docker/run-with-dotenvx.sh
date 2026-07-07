#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
local_env_file="$repo_root/.env.local"
load_env_file="${ROOMOTE_DOCKER_LOAD_ENV_FILE:-true}"

if [ "$load_env_file" != "false" ] && [ -f "$local_env_file" ]; then
  exec "$repo_root/node_modules/.bin/dotenvx" run -o -f "$local_env_file" -- "$@"
fi

exec "$@"
