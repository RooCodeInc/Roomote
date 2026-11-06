---
'@roomote/worker': patch
'@roomote/cloud-agents': patch
---

Long tasks are no longer stopped after 200 tool calls or 100 model steps, and replying to a task stopped for repeated activity resumes it from its retained work. The 1,000-request lifetime ceiling and repetition detection still apply.
