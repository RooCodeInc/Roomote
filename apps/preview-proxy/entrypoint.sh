#!/bin/sh
set -e

cd /roomote/apps/preview-proxy

if [ -f /roomote/.env.local ]; then
  set -a

  eval "$(npx dotenvx get --all --format eval -f /roomote/.env.local)"

  set +a
fi

exec node --enable-source-maps dist/index.js "$@"
