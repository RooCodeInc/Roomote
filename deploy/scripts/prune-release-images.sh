#!/usr/bin/env bash
set -euo pipefail

install_root="${ROOMOTE_INSTALL_ROOT:-/opt/roomote}"
env_file="${ROOMOTE_ENV_FILE:-$install_root/.env}"
retention="${ROOMOTE_IMAGE_RETENTION_RELEASES:-3}"

if ! [[ "$retention" =~ ^[1-9][0-9]*$ ]]; then
  echo "ROOMOTE_IMAGE_RETENTION_RELEASES must be a positive integer" >&2
  exit 1
fi

[ -f "$env_file" ] || {
  echo "$env_file not found" >&2
  exit 1
}

read_env_value() {
  local key="$1"
  awk -v key="$key" '
    BEGIN { pattern = "^[[:space:]]*(export[[:space:]]+)?" key "=" }
    $0 ~ pattern {
      sub(/^[^=]*=/, "")
      print
      exit
    }
  ' "$env_file"
}

image_registry="$(read_env_value IMAGE_REGISTRY)"
image_namespace="$(read_env_value IMAGE_NAMESPACE)"
current_version="$(read_env_value ROOMOTE_VERSION)"
image_registry="${image_registry:-ghcr.io}"
image_namespace="${image_namespace:-roocodeinc}"
repo_prefix="$image_registry/$image_namespace/roomote-"

tags_file=''
keep_file=''
images_file=''
cleanup() {
  [ -z "$tags_file" ] || rm -f "$tags_file"
  if [ -n "$keep_file" ]; then
    rm -f "$keep_file" "${keep_file}.dedup"
  fi
  [ -z "$images_file" ] || rm -f "$images_file"
}
trap cleanup EXIT

tags_file="$(mktemp)"
keep_file="$(mktemp)"
images_file="$(mktemp)"

docker image ls --format '{{.CreatedAt}}|{{.Repository}}|{{.Tag}}' |
  awk -F'|' -v prefix="$repo_prefix" 'index($2, prefix) == 1 && $3 != "<none>" { print $1 "|" $3 }' |
  sort -t'|' -k1,1r |
  awk -F'|' '!seen[$2]++ { print $2 }' >"$tags_file"

if [ -n "$current_version" ]; then
  printf '%s\n' "$current_version" >"$keep_file"
  remaining=$((retention - 1))
else
  : >"$keep_file"
  remaining="$retention"
fi

if [ "$remaining" -gt 0 ]; then
  awk -v current="$current_version" -v limit="$remaining" '
    $0 != current {
      print
      count++
      if (count >= limit) {
        exit
      }
    }
  ' "$tags_file" >>"$keep_file"
fi

awk 'NF && !seen[$0]++ { print }' "$keep_file" >"${keep_file}.dedup"
cat "${keep_file}.dedup" >"$keep_file"
rm -f "${keep_file}.dedup"

docker image ls --format '{{.Repository}}:{{.Tag}}|{{.Repository}}|{{.Tag}}' |
  awk -F'|' -v prefix="$repo_prefix" 'index($2, prefix) == 1 && $3 != "<none>" { print }' >"$images_file"

removed=0
skipped=0
while IFS='|' read -r image repo tag; do
  [ -n "$image" ] || continue
  if grep -Fxq "$tag" "$keep_file"; then
    continue
  fi

  if docker image rm "$image" >/dev/null 2>&1; then
    removed=$((removed + 1))
    printf 'Removed old Roomote image %s\n' "$image"
  else
    skipped=$((skipped + 1))
    printf 'Skipped Roomote image still in use: %s\n' "$image" >&2
  fi
done <"$images_file"

docker image prune -f >/dev/null 2>&1 || true

kept_count="$(awk 'NF { count++ } END { print count + 0 }' "$keep_file")"
kept_tags="$(tr '\n' ' ' <"$keep_file" | sed 's/[[:space:]]*$//')"
printf 'Roomote image retention complete: kept %s release tag(s): %s; removed %s image reference(s); skipped %s in-use image reference(s).\n' \
  "$kept_count" "${kept_tags:-none}" "$removed" "$skipped"
