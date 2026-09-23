---
'@roomote/web': patch
---

Messages sent to a task while it was starting, including Session steers and web follow-ups, are delivered again. Previously the first one was queued, and every later message to that task queued behind it and was never delivered.
