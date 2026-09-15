---
"@roomote/types": patch
"@roomote/db": patch
"@roomote/api": patch
"@roomote/cloud-agents": patch
---

Session secret grants can name any credential header, not only `authorization`, `x-api-key`, and `api-key`, so services that authenticate with their own header such as `private-token` or `x-shopify-access-token` can be approved. Request-shaping headers remain refused, and a scheme is still only accepted on `authorization`.
