---
"@roomote/auth": patch
---

Reduce GitHub App rate-limit pressure by coalescing installation-token requests, briefly caching the PR-notification hot path with one fresh-token retry, reusing bootstrap credentials until their scheduled refresh, and honoring provider backoff signals.
