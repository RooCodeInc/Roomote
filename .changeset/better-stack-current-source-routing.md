---
'@roomote/web': patch
---

Better Stack operational scans resolve collection and cluster routing from current source metadata instead of reusing stale or guessed identifiers that cause queries to fail. Scans remain read-only and stop rather than guess when metadata is unavailable.
