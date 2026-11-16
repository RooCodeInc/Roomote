#!/usr/bin/env bash
set -euo pipefail

repo_root="${ROOMOTE_REPO_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)}"
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/bin"

# Execute the actual SSH payload with only host paths redirected into a fixture.
# No SSH connection, Docker daemon, deployment or provider credentials are used.
cat >"$work_dir/bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
command="${@: -1}"
if [[ "$command" == *'bash -s'* ]]; then
  payload=$(cat)
  payload="${payload//\/opt\/roomote/$MOCK_INSTALL_ROOT}"
  payload="${payload//\/etc\/systemd/$MOCK_INSTALL_ROOT/systemd}"
  eval "$command" <<<"$payload"
else
  command="${command//\/opt\/roomote/$MOCK_INSTALL_ROOT}"
  eval "$command"
fi
EOF
cat >"$work_dir/bin/scp" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source="${@: -2:1}"
destination="${@: -1}"
cp "$source" "$MOCK_INSTALL_ROOT/${destination#*:/opt/roomote/}"
EOF
cat >"$work_dir/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$work_dir/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$MOCK_INSTALL_ROOT/docker.log"
case "$*" in
  'pull '*)
    cp "$MOCK_INSTALL_ROOT/.env" "$MOCK_INSTALL_ROOT/env-at-worker-pull"
    printf '%s\n' "$2" >"$MOCK_INSTALL_ROOT/worker-image"
    [[ "$MOCK_FAILURE" != worker-pull ]] || exit 41
    ;;
  'compose '*' pull')
    cp "$MOCK_INSTALL_ROOT/.env" "$MOCK_INSTALL_ROOT/env-at-compose-pull"
    printf '%s/%s/roomote-app:%s\n' \
      "${IMAGE_REGISTRY:-file-registry.invalid}" \
      "${IMAGE_NAMESPACE:-file-namespace}" "$ROOMOTE_VERSION" \
      >"$MOCK_INSTALL_ROOT/app-image"
    [[ "$MOCK_FAILURE" != compose-pull ]] || exit 42
    ;;
  'compose '*' stop controller') printf 'stopped\n' >"$MOCK_INSTALL_ROOT/controller" ;;
  'compose '*' start controller') printf 'running\n' >"$MOCK_INSTALL_ROOT/controller" ;;
  'compose '*' run --rm db-migrate')
    [[ "$(<"$MOCK_INSTALL_ROOT/controller")" == stopped ]]
    grep -q '^ROOMOTE_VERSION=vnext$' "$MOCK_INSTALL_ROOT/.env"
    [[ "$MOCK_FAILURE" != migrate ]] || exit 43
    ;;
  'compose '*' up -d --wait --wait-timeout 600') printf 'running\n' >"$MOCK_INSTALL_ROOT/controller" ;;
esac
EOF
chmod +x "$work_dir/bin/ssh" "$work_dir/bin/scp" "$work_dir/bin/docker" "$work_dir/bin/systemctl"

run_upgrade() {
  local failure="$1"
  shift
  env PATH="$work_dir/bin:$PATH" \
    MOCK_INSTALL_ROOT="$install_root" MOCK_FAILURE="$failure" \
    bash "$repo_root/deploy/scripts/upgrade.sh" \
      --customer fixture --host fixture.invalid --version vnext "$@"
}

for failure in worker-pull compose-pull none migrate defaults; do
  install_root="$work_dir/$failure"
  mkdir -p "$install_root/caddy"
  cat >"$install_root/.env" <<'EOF'
ROOMOTE_VERSION=vprevious
ROOMOTE_APP_DOMAIN=fixture.invalid
IMAGE_REGISTRY=file-registry.invalid
IMAGE_NAMESPACE=file-namespace
DOCKER_WORKER_IMAGE=file-registry.invalid/file-namespace/roomote-worker:vprevious
MODAL_BASE_IMAGE_REF=file-registry.invalid/file-namespace/roomote-worker:vprevious
R_DISCORD_GATEWAY_SECRET=disposable-fixture-value
EOF
  cp "$install_root/.env" "$install_root/original.env"
  printf 'running\n' >"$install_root/controller"
  image_args=(--image-registry override-registry.invalid --image-namespace override-namespace)
  image_prefix=override-registry.invalid/override-namespace
  if [[ "$failure" == defaults ]]; then
    image_args=()
    image_prefix=file-registry.invalid/file-namespace
  fi
  set +e
  run_upgrade "$failure" "${image_args[@]}" >"$install_root/output.log" 2>&1
  status=$?
  set -e
  printf '%s: exit=%s controller=%s\n' "$failure" "$status" "$(<"$install_root/controller")"
  if [[ "$failure" == *pull ]]; then
    [[ "$status" -ne 0 ]]
    [[ "$(<"$install_root/controller")" == running ]]
    cmp "$install_root/original.env" "$install_root/.env"
    ! grep -q ' stop controller$\| run --rm db-migrate\| up -d' "$install_root/docker.log"
  elif [[ "$failure" == migrate ]]; then
    [[ "$status" -ne 0 ]]
    [[ "$(<"$install_root/controller")" == running ]]
    grep -q ' start controller$' "$install_root/docker.log"
    ! grep -q ' up -d' "$install_root/docker.log"
  else
    [[ "$status" -eq 0 ]]
    [[ "$(<"$install_root/controller")" == running ]]
    grep -q '^ROOMOTE_VERSION=vnext$' "$install_root/.env"
    grep -q ' run --rm db-migrate$' "$install_root/docker.log"
    grep -q ' up -d --wait --wait-timeout 600$' "$install_root/docker.log"
  fi
  cmp "$install_root/original.env" "$install_root/env-at-worker-pull"
  if [[ "$failure" != worker-pull ]]; then
    cmp "$install_root/original.env" "$install_root/env-at-compose-pull"
    [[ "$(<"$install_root/app-image")" == "$image_prefix/roomote-app:vnext" ]]
  fi
  [[ "$(<"$install_root/worker-image")" == "$image_prefix/roomote-worker:vnext" ]]
  if [[ "$failure" == *pull ]]; then
    run_upgrade none "${image_args[@]}" >"$install_root/retry.log" 2>&1
    [[ "$(<"$install_root/controller")" == running ]]
    grep -q '^ROOMOTE_VERSION=vnext$' "$install_root/.env"
    printf '%s: retry succeeded\n' "$failure"
  fi
done
