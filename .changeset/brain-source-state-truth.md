---
"@roomote/web": patch
"@roomote/bullmq": patch
---

Make the Brain settings page's per-source ingestion states truthful. Sources whose cursor is a rolling checkpoint or mode-state (pull requests, deployment members, Notion's incremental scan) no longer show "Backfilling" forever; the open-ended Slack and GitHub deep backfills now record honest completion and automatically re-arm when a new channel or repository appears; stream counts exclude version-bump orphans, censuses, and inventories; replay progress comes from the walk's own completed set instead of a number that could never move; GitHub's per-repository stream rows are migrated under the current collector id; and the corpus panel no longer claims a mature Brain "started ingestion today" after a burst of writes fills the recency sample.
