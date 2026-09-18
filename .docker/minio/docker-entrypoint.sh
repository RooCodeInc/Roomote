#!/bin/sh
# Mirrors the upstream image's contract: a bare server invocation such as
# `server /data --console-address :9001` (how every Roomote deployment shape
# runs it) gets the `minio` binary prepended; anything else (`mc ...`, `sh`)
# runs as given so the same image doubles as the client.
set -eu

case "${1:-}" in
  '') set -- minio ;;
  server | -*) set -- minio "$@" ;;
esac

exec "$@"
