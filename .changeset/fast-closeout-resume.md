---
'@roomote/web': patch
---

A Fast turn interrupted while posting its final reply no longer fails closed. The closeout stays inside the turn's replay: a run that resumes the turn settles on the recorded reply when it was delivered, posts the same text once more when the process died inside the call before recording it, and only asks the model to continue when the transcript leaves the outcome open. Restarts during the closeout therefore finish silently instead of asking the user to send the request again.
