---
"@roomote/types": patch
"@roomote/db": patch
"@roomote/sdk": patch
"@roomote/env": patch
"@roomote/compute-providers": patch
"@roomote/api": patch
"@roomote/controller": patch
"@roomote/worker": patch
---

Remove the external Session egress gateway and its Docker connector sidecar. Every sandbox provider, Docker included, now delivers Session service tokens through the API-side proxy, so no gateway image, connector certificates, host firewall rules, or `SESSION_EGRESS_*` / `R_SESSION_EGRESS_GATEWAY_TOKEN` settings are needed; those variables are no longer read. Docker runs keep their ordinary network policy and no longer require a dedicated gateway network; task networks created under the old connector path still have their host firewall chains removed at teardown.
