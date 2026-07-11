---
'@roomote/worker': patch
---

Worker sandboxes no longer inject the hosting deployment's app env (`APP_ENV`/`R_APP_ENV`) into user-facing task processes and the sandbox shell env. That value describes the Roomote deployment's own deploy context and was clobbering per-command `R_APP_ENV=development` overrides via the unconditional exports in `~/.roomote/env.sh`, which disabled dev login in Roomote-on-Roomote sandboxes. The worker keeps the value internally for keepalive and monitoring, also scrubs the legacy `ROOMOTE_APP_ENV` alias from its process env, and the in-repo sandbox environment definition drops its now-unnecessary `sed` export-guard workaround.
