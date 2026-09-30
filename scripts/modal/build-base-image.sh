#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

IMAGE_REF="${1:-${MODAL_BASE_IMAGE_REF:?MODAL_BASE_IMAGE_REF must be set}}"
RELEASE_PRODUCT_VERSION="${RELEASE_PRODUCT_VERSION:-$(node -p "require('./package.json').version")}"

docker buildx build \
  --platform linux/amd64 \
  -f apps/worker/Dockerfile \
  -t "${IMAGE_REF}" \
  --build-arg "RELEASE_PRODUCT_VERSION=${RELEASE_PRODUCT_VERSION}" \
  --load \
  .

echo "Built ${IMAGE_REF}"
