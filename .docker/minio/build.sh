#!/bin/sh
# Build one MinIO Go module from the public proxy with every pin verified.
#
# Usage: build-minio-module <name> <module> <release> <module-version>
#          <module-sum> <go.mod-sum> <sha256-amd64> <sha256-arm64>
#
# `go mod download` fetches the tagged release through the checksum database;
# the returned version and h1: sums must equal the pinned ones before anything
# is compiled, and the compiled binary must match the pinned SHA-256 for the
# target architecture. Any mismatch fails the build.
#
# `-ldflags="-buildid= -s -w"` drops the toolchain-derived build ID and the
# debug info, as upstream's release builds did. That makes mc reproducible from
# any host, but MinIO's compiled code still differs when the Go compiler runs
# on a different host architecture than it targets, so the pinned checksums
# are for NATIVE builds: the per-arch CI runners, or a Docker build for the
# stated --platform (emulated is fine, a host cross-compile is not).
#
# VERIFY_SHA256=0 (build arg) reports the checksums instead of enforcing them;
# use it once when bumping pins, never in a published build.
set -eu

name="$1"
module="$2"
release="$3"
expected_version="$4"
expected_sum="$5"
expected_gomod_sum="$6"
sha256_amd64="$7"
sha256_arm64="$8"

case "${TARGETARCH:?TARGETARCH is required}" in
  amd64) expected_sha256="$sha256_amd64" ;;
  arm64) expected_sha256="$sha256_arm64" ;;
  *)
    echo "Unsupported TARGETARCH: $TARGETARCH" >&2
    exit 1
    ;;
esac
export GOARCH="$TARGETARCH"

json="$(go mod download -json "${module}@${release}")"
field() {
  printf '%s\n' "$json" | sed -n "s/^[[:space:]]*\"$1\": \"\\(.*\\)\",\\{0,1\\}\$/\\1/p" | head -n 1
}
actual_version="$(field Version)"
actual_sum="$(field Sum)"
actual_gomod_sum="$(field GoModSum)"
source_dir="$(field Dir)"

check() {
  if [ "$2" != "$3" ]; then
    echo "$name: $1 mismatch: expected $3, got $2" >&2
    exit 1
  fi
}
check "module version" "$actual_version" "$expected_version"
check "module checksum" "$actual_sum" "$expected_sum"
check "go.mod checksum" "$actual_gomod_sum" "$expected_gomod_sum"
[ -d "$source_dir" ] || { echo "$name: module directory missing: $source_dir" >&2; exit 1; }

mkdir -p /out /licenses
cd "$source_dir"
go build -trimpath -ldflags="-buildid= -s -w" -o "/out/$name" .
cp LICENSE "/licenses/$name.LICENSE"

actual_sha256="$(sha256sum "/out/$name" | cut -d' ' -f1)"
if [ "${VERIFY_SHA256:-1}" = 1 ]; then
  check "binary sha256 ($TARGETARCH)" "$actual_sha256" "$expected_sha256"
fi
echo "$name $release ($TARGETARCH) sha256=$actual_sha256"
