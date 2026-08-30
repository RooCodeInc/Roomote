---
"@roomote/cloud-agents": patch
---

Keep Fast sessions quiet through short transient provider recoveries: retries stay silent unless the wait grows past 30 seconds, all retryable provider errors share a six-retry budget with bounded jittered backoff, and warm-session progress refreshes the recovery budget the way completed coding-task turns do.
