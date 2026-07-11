---
'@roomote/web': patch
---

Tasks no longer hang forever or drop follow-ups when a model stream stalls mid-turn. OpenCode harness watchdogs bound stalled streams and recover so subsequent messages are processed instead of waiting for the multi-hour sandbox deadline.
