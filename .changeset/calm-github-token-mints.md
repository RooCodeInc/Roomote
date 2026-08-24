---
"@roomote/auth": patch
---

Reduce GitHub App rate-limit pressure by caching and coalescing installation-token requests, reusing bootstrap credentials until their scheduled refresh, and stopping immediate retries when GitHub asks clients to back off.
