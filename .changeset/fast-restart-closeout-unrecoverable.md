---
'@roomote/web': patch
---

A Fast turn that a restart cuts off with no way to resume it tells the user so again. Every admitted turn resumes on the next process, so the restart notice was removed; but a turn whose durable admission write failed has no row to resume from, and it was ending in silence with the Session left showing "responding". That turn now posts the recorded closeout "Roomote restarted while working on this request. Please send it again." Turns the queue delivers stay quiet, since the queue re-runs them itself, and platform events keep their existing silent handling.
