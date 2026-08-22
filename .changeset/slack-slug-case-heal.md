---
"@roomote/bullmq": patch
---

Fix Brain Slack day-page retirement finding nothing to heal: gbrain stores slugs lowercased, but the collector tracked its raw mixed-case emissions, so the healing replay's reconciliation never matched the census inventory. Day-page slugs are now emitted in gbrain's canonical lowercase form, mixed-case inventory rows are rewritten and merged once on startup, deployments that ran the replay with the mismatch live get it re-armed automatically, and sync-state rows left behind by superseded collector versions are cleaned up.
