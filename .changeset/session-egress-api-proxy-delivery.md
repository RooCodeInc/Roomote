---
"@roomote/types": patch
"@roomote/db": patch
"@roomote/sdk": patch
"@roomote/api": patch
"@roomote/controller": patch
"@roomote/worker": patch
---

Deliver owner-approved Session service tokens to coding runs on Modal and Roomote Cloud. When the Session owner has Session secret tools enabled, the controller registers the run after bootstrap and the worker receives substitute tokens, the service manifest, and the API proxy base URL; the model calls approved services through the proxy with ordinary HTTP clients while the real key stays in the API. No deployment configuration is required.
