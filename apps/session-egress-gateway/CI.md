# Gateway Validation

Run from this directory, with Node, curl, tar, sha256sum and mise available:

```sh
bash build.sh test
bash build.sh vet
bash build.sh build
bin/session-egress-gateway version
```

Each command verifies the archive before preparing the original Iron module and
overlay. Tests include actual Iron proxy, transform and certcache packages plus
Roomote local HTTPS fixtures. Never run upstream `integration_test/...` against
external backends for this gateway validation. No provider credentials are needed.

Only `.build/` and `bin/` are generated. Keep them out of source control. Both
hashes in `iron.lock` and the exact-match hooks must be reviewed together on an
upstream upgrade. Upstream Go module checksums remain authoritative for modules.

The Dockerfile uses Go 1.26.1 and the same verified archive/overlay path. Image
build/runtime checks and product deployment verification are separate from the
local Go regression suite.
