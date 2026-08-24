---
"@roomote/cloud-agents": patch
---

Fast conversations no longer expose filesystem subagents that cannot access local tools. Oversized native results now give actionable inline truncation guidance instead of pointing those subagents at OpenCode spill files, and current-channel history is returned in bounded, cursor-paginated pages.
