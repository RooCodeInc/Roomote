---
"@roomote/api": patch
"@roomote/db": patch
"@roomote/sdk": patch
"@roomote/types": patch
---

Add the API-side session egress substitution proxy at `/api/session-egress/<grant>/<path>`, so attached coding runs on compute providers without a per-workload connector can call an owner-approved origin with an ordinary HTTP client and a substitute token while the real credential stays in the API.
