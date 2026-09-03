---
'@roomote/web': patch
---

Fixed Fast Sessions asking the user to resend a request after a restart interrupted a turn that had already started a task. Resending would have started a second task. The closeout now says the started task is still running and will report back in the thread, and the next message no longer treats that request as unfinished.
