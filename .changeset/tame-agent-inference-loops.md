---
'@roomote/api': patch
'@roomote/worker': patch
'@roomote/web': patch
'@roomote/cloud-agents': patch
'@roomote/db': patch
'@roomote/sdk': patch
'@roomote/types': patch
---

Stop repeated identical tool-call loops and bound subagent passes. Enforce a durable task-wide inference request ceiling before dispatch, retain partial work, and save a visible safety notice without requiring another model response.
