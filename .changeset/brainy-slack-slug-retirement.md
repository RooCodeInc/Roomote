---
"@roomote/bullmq": minor
---

Heal Brain Slack day pages from the incremental era: the Slack collector now tracks every page slug it emits, a one-time census inventories pages that predate tracking, and a replay retires (soft-deletes) superseded pages whose message range it fully re-read. Merging triggers a one-time re-read of the last 90 days of Slack history per deployment, paced by the existing collector budgets; pages older than that window are deliberately kept.
