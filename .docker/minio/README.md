# roomote-minio

MinIO server and `mc` client, compiled from the final MinIO Community Edition
source releases and published as `ghcr.io/roocodeinc/roomote-minio`.

## Why this exists

MinIO stopped publishing binaries and container images for the community
edition in October 2025 and archived the source repositories. The Docker Hub
images were deleted in September 2026 and the quay.io copies have no stated
future. Roomote deployments of every shape (Railway, compose, Coolify, Render)
need an artifact store whose image nobody else can remove, so we build it
from the pinned source ourselves.

## What is pinned

Everything that could change the output is pinned in the `Dockerfile` and
verified during the build:

| Pin                                   | Verified by                                    |
| ------------------------------------- | ---------------------------------------------- |
| Go toolchain image (by digest)        | Docker                                         |
| Module version and `h1:` sums         | Go checksum database, compared to the args     |
| Compiled binary SHA-256 per arch      | `sha256sum` after `go build`, compared to args |
| Runtime base image (by digest)        | Docker                                         |

The MinIO pins are the same values `apps/api/scripts/setup-sandbox-minio.ts`
uses to build MinIO for sandboxes, and `deploy/ci/validate-deployment-artifacts.mjs`
fails if the two drift. A sandbox and a deployment therefore run the identical
binary.

Both builds pass `-trimpath -ldflags="-buildid= -s -w"`: no VCS or path
noise, no toolchain-derived build ID, no DWARF or symbol table (upstream's
release builds stripped them too; the binaries are about a quarter smaller).

The checksums are for **native** builds, meaning the Go toolchain runs on the
same architecture it targets. That is how the CI runners build (one amd64,
one arm64 runner) and how the linux/amd64 sandbox builds. `mc` reproduces
from any host with these flags, but `minio`'s code differs by a few hundred
bytes when the compiler runs on the other host architecture (same symbol
table and sizes, different instruction bytes, so it is codegen rather than
metadata). A cross-compile from an Apple Silicon laptop therefore matches the
arm64 pins but not the amd64 pins; use `docker build --platform linux/amd64`,
which runs the real linux/amd64 toolchain under emulation, to verify those.

## Bumping a pin

There will be no newer upstream releases, so this only applies if the module
or toolchain pin ever changes (a fork, a Go security release).

1. Update the `*_RELEASE`, `*_MODULE_VERSION`, `*_MODULE_SUM`, `*_GOMOD_SUM`
   or `GO_IMAGE` args. `go mod download -json <module>@<release>` prints the
   version and sums.
2. Build once in report mode to learn the new binary checksums, for each arch:
   `docker build --build-arg VERIFY_SHA256=0 --platform linux/arm64 .docker/minio`
   and the same with `linux/amd64`. The build log prints `sha256=` per binary.
   Both must be Docker builds for the stated platform (native or emulated), not
   host cross-compiles, for the reason above.
3. Put the printed values in the `*_SHA256_*` args and in
   `apps/api/scripts/setup-sandbox-minio.ts`, then build again without the
   flag; the validator checks the two files agree.

## Publishing

`.github/workflows/publish-minio.yml` builds both architectures natively,
merges them into one manifest, and prints the `image@sha256:` pin in the job
summary. It runs on pushes to `develop` and `main` that touch this directory
and on manual dispatch. Deployments do not track a tag: copy the printed pin
into `deploy/deployment-catalog.json` and the compose and template files the
validator checks against it.

## Compatibility with the upstream image

- Same invocation: `server /data --console-address :9001` works unchanged;
  the entrypoint prepends `minio` for `server` and flag arguments only.
- `mc` is on the path with `MC_CONFIG_DIR=/tmp/.mc`, so `mc ready local`
  healthchecks and the compose `minio-init` bucket bootstrap work against
  this one image. There is no separate client image.
- Runs as root like upstream so existing `/data` volumes keep working.
- `MINIO_UPDATE=off`: there are no further upstream releases to check for.
- Adds `curl` and a shell, which the upstream image lacked.

## Local build and smoke test

```bash
docker build -t roomote-minio:local .docker/minio
docker run --rm -d --name minio-smoke -p 19100:9000 \
  -e MINIO_ROOT_USER=roomote -e MINIO_ROOT_PASSWORD=roomote-local-artifacts-password \
  roomote-minio:local server /data
curl -fsS http://127.0.0.1:19100/minio/health/live
docker exec minio-smoke mc ready local
docker stop minio-smoke
```
