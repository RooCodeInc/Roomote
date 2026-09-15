---
"@roomote/types": patch
"@roomote/db": patch
"@roomote/sdk": patch
"@roomote/auth": patch
"@roomote/env": patch
"@roomote/compute-providers": patch
"@roomote/api": patch
"@roomote/controller": patch
"@roomote/worker": patch
"@roomote/cloud-agents": patch
"@roomote/web": patch
---

Rename Session secrets to integration keys throughout. Your integrations now live on Settings → Integrations, which every user can open; the Experimental toggle is "Integration keys" (`integration_keys_enabled`); the Fast tools are `prepare_integration_key`, `list_integration_keys`, and `request_with_integration_key`; the proxy is served at `/api/credential-egress` with `ROOMOTE_CREDENTIAL_EGRESS_*` worker variables and the optional `R_CREDENTIAL_EGRESS_PROXY_HOST`. The storage tables are recreated under `service_credential*` and `credential_egress_*` names; they held no data anywhere, so nothing is migrated.
