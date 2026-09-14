#!/usr/bin/env bash

# Test-only harness: sources the deployment lib and validates the domain
# passed as $1. Invoked as an explicit positional argument to `bash` (no
# `-c` shell string), so the caller never interpolates a path into shell
# command text.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/../scripts/lib.sh"

validate_domain "$1"
