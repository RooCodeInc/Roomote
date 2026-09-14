# syntax=docker/dockerfile:1
#
# MinIO (object storage) and mc (its client), built from the last community
# source releases and published as ghcr.io/roocodeinc/roomote-minio.
#
# MinIO Community Edition went source-only on 2025-10-23 and the upstream
# repositories are archived; the prebuilt images were removed from Docker Hub
# in September 2026 and only linger on quay.io. Building from the pinned,
# checksum-verified source is the only distribution nobody else can delete
# out from under a deployment. Hosted (Railway) and self-hosted (compose,
# Coolify, Render) deployments run this same image.
#
# The build is byte-for-byte the one apps/api/scripts/setup-sandbox-minio.ts
# performs for sandboxes: same Go toolchain, same module version and Go
# checksum-database sums, same flags, and the resulting binaries are asserted
# against the same SHA-256 values. deploy/ci/validate-deployment-artifacts.mjs
# keeps the two pin sets identical.
#
# Upgrading: bump the *_RELEASE / *_MODULE_VERSION / *_SUM args together with
# the sandbox script (there will be no newer upstream releases; a bump only
# happens if we ever fork), then let the publish-minio workflow produce the
# digest to pin in deploy/deployment-catalog.json.

ARG GO_IMAGE=golang:1.24.8-bookworm@sha256:4ed690d6649d63c312b99a6120025ec79ce3b542968a37da53d6236c7c61a848
ARG RUNTIME_IMAGE=debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171

# Upstream release names, declared before the first stage so both stages (and
# the publish workflow, which reads MINIO_RELEASE from this file) share them.
ARG MINIO_RELEASE=RELEASE.2025-10-15T17-29-55Z
ARG MC_RELEASE=RELEASE.2025-08-13T08-35-41Z

FROM ${GO_IMAGE} AS build

ARG TARGETARCH

# MinIO server: github.com/minio/minio at its final community release.
ARG MINIO_RELEASE
ARG MINIO_MODULE_VERSION=v0.0.0-20251015172955-9e49d5e7a648
ARG MINIO_MODULE_SUM=h1:6TdolSCLSs2nwm8i0PpWDqf9iX2Ty9WQK8wmr7dCnUM=
ARG MINIO_GOMOD_SUM=h1:yCWDkwWO9IWpGsT4mreDDN/B/QVmK2zC666uInRAcqE=
ARG MINIO_SHA256_AMD64=6456634c06fa937dfeb708e37db80c8a02ffc50874d211ee3fc5cc0f71f95b96
ARG MINIO_SHA256_ARM64=3f9e2d92ca9fe43ebac8f069349a3fefb91500ed06b22697e9d9f3dba6e1db17

# MinIO client: github.com/minio/mc at its final community release. Bundled
# because deployments create the artifact bucket with it (compose minio-init)
# and Coolify's documented container healthcheck is `mc ready local`.
ARG MC_RELEASE
ARG MC_MODULE_VERSION=v0.0.0-20250813083541-7394ce0dd2a8
ARG MC_MODULE_SUM=h1:9tuRE4iEaDkuxatxe7pddYYh1SX5mT0/D0haofZFeTY=
ARG MC_GOMOD_SUM=h1:agCKg3UT5wU3auhPL2lZbOWlqqT2RokeAT7Xc+HK3cU=
ARG MC_SHA256_AMD64=38b9aa4ae9eb7eda22c4010199dc3f85099266f063efca793aed29b5a95612ae
ARG MC_SHA256_ARM64=d0c72d33cf6a30a1f0b69a327c6f5dea065fa5b3d0c5dc7cf87f8de102384a98

# Mirrors the sandbox script's Go environment: the public proxy and checksum
# database authenticate the module, and the pinned toolchain plus -trimpath
# make the build reproducible so the SHA-256 assertions hold on any builder.
ENV CGO_ENABLED=0 \
    GOOS=linux \
    GOENV=off \
    GOFLAGS=-mod=readonly \
    GONOSUMDB= \
    GOPRIVATE= \
    GOPROXY=https://proxy.golang.org \
    GOSUMDB=sum.golang.org \
    GOTOOLCHAIN=local

# Set to 0 only when computing new pins (see build.sh); published builds
# always verify.
ARG VERIFY_SHA256=1

COPY build.sh /usr/local/bin/build-minio-module

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    build-minio-module minio github.com/minio/minio \
      "$MINIO_RELEASE" "$MINIO_MODULE_VERSION" "$MINIO_MODULE_SUM" "$MINIO_GOMOD_SUM" \
      "$MINIO_SHA256_AMD64" "$MINIO_SHA256_ARM64"

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    build-minio-module mc github.com/minio/mc \
      "$MC_RELEASE" "$MC_MODULE_VERSION" "$MC_MODULE_SUM" "$MC_GOMOD_SUM" \
      "$MC_SHA256_AMD64" "$MC_SHA256_ARM64"


FROM ${RUNTIME_IMAGE}

ARG MINIO_RELEASE
ARG MC_RELEASE

# ca-certificates so MinIO can reach TLS endpoints (KMS, replication targets);
# curl for operators and healthchecks. A shell stays available on purpose:
# compose runs `sh -c` bucket bootstrap against this image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/minio /out/mc /usr/local/bin/
COPY --from=build /licenses /licenses
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# MC_CONFIG_DIR: mc must be usable by whatever user runs the container; its
# default config lives under $HOME, which need not be writable.
# MINIO_UPDATE=off: there will never be another upstream release to check for.
ENV MC_CONFIG_DIR=/tmp/.mc \
    MINIO_UPDATE=off

# Runs as root like the upstream image so existing /data volumes provisioned
# under it keep their ownership. Drop privileges with MINIO_UID/MINIO_GID if a
# deployment needs to.

LABEL org.opencontainers.image.title="Roomote MinIO" \
      org.opencontainers.image.description="MinIO server and mc client built from the final community source releases" \
      org.opencontainers.image.source="https://github.com/RooCodeInc/Roomote" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${MINIO_RELEASE}" \
      io.roomote.minio.release="${MINIO_RELEASE}" \
      io.roomote.mc.release="${MC_RELEASE}"

EXPOSE 9000 9001

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["minio"]
