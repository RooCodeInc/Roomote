#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"

for command in deploy upgrade; do
  args=(--customer registry-test --version v1.2.3 --image-retention-releases 0)
  if [ "$command" = deploy ]; then
    args+=(--domain example.invalid --env "$repo_root/.env.production.example")
  else
    args+=(--host example.invalid)
  fi

  assert_validation() {
    local expected="$1" output status=0
    shift
    # Invalid retention stops accepted inputs before state writes, SSH, or Terraform.
    output="$(bash "$repo_root/deploy/scripts/$command.sh" "${args[@]}" "$@" 2>&1)" || status=$?
    if [ "$status" -ne 1 ] || [ "$output" != "error: $expected" ]; then
      printf 'FAIL %s %s: status=%s output=%s\n' "$command" "$*" "$status" "$output" >&2
      exit 1
    fi
  }

  for registry in ghcr.io registry.example:5000 localhost:5000 registry.example:5000/team/images; do
    assert_validation '--image-retention-releases must be a positive integer' --image-registry "$registry"
  done

  for registry in 'registry.example:abc' 'registry.example:' 'registry.example:5000:6000' \
    'https://registry.example:5000' 'registry.example/team:5000' \
    'registry.example:5000/bad path' 'registry.example;true' '$(true)' \
    'registry.example`true`' $'registry.example\nOTHER=value'; do
    assert_validation "invalid image registry or namespace value: $registry" --image-registry "$registry"
  done

  assert_validation '--image-retention-releases must be a positive integer' \
    --image-registry localhost:5000 --image-namespace team/nested-images
  for namespace in 'team:5000' 'team/images:tag' 'team/bad path' 'team;true' '$(true)'; do
    assert_validation "invalid image registry or namespace value: $namespace" --image-namespace "$namespace"
  done
done

printf 'Image registry CLI validation passed for deploy and upgrade\n'
