#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

IMAGE_REF="${1:-${MODAL_BASE_IMAGE_REF:?MODAL_BASE_IMAGE_REF must be set}}"

REGISTRY="${IMAGE_REF%%/*}"
if [[ "$REGISTRY" == *.dkr.ecr.*.amazonaws.com ]]; then
  REGION="${MODAL_ECR_REGION:-${S3_REGION:-}}"

  if [ -z "$REGION" ]; then
    echo "Unable to resolve ECR region. Set MODAL_ECR_REGION or S3_REGION." >&2
    exit 1
  fi

  export AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-${AWS_ACCESS_KEY_ID:-}}"
  export AWS_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-${AWS_SECRET_ACCESS_KEY:-}}"

  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
fi

docker buildx build \
  --platform linux/amd64 \
  -f apps/worker/Dockerfile \
  -t "${IMAGE_REF}" \
  --push \
  .

echo "Built and pushed ${IMAGE_REF}"
