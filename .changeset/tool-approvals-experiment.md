---
'@roomote/web': minor
'@roomote/cloud-agents': minor
'@roomote/db': minor
'@roomote/types': minor
'@roomote/feature-flags': minor
---

A new Tool approvals experiment is available under Settings → Experimental. When an administrator enables it, Fast asks the Session requester before running an on-demand integration tool call: the requester sees the integration, tool, and a redacted summary of the arguments, and can allow that exact call once or reject it. Unanswered requests expire and fail closed, and an approval runs its call exactly once. The experiment is off by default and changes nothing until enabled.
