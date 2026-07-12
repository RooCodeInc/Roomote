---
'@roomote/web': patch
---

Blaxel sandbox lifecycle is more resilient: deterministic external IDs with idempotent create, bounded retries on readiness-sensitive calls, reuse of preview resources across standby/resume instead of delete-and-recreate, and immediate failure on non-retryable 4xx errors.
