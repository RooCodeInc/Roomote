---
'@roomote/web': patch
---

A Fast turn interrupted while posting its final reply no longer fails closed. The closeout stays inside the turn's replay: a run that resumes the turn settles on the recorded reply when it was delivered, posts the same text once more when the process died inside the call before recording it, and only asks the model to continue when the transcript leaves the outcome open. Restarts during the closeout therefore finish silently instead of asking the user to send the request again.

Emoji-reaction turns in Slack and web setup kickoffs and input responses are now admitted durably too, with their reaction or platform-event framing recorded on the row, so a restart resumes them the same way instead of posting a restart notice. Admission also reports when it finds a turn's row still pending from an interrupted earlier attempt (a setup kickoff re-scheduled after a restart, a redelivered webhook), and the caller then runs the turn as a resumption of that attempt instead of a fresh start.

With every turn resumable, the restart notice and the `R_FAST_DURABLE_ADMISSION_DISABLED` kill switch are removed. Durable admission is always on; `R_FAST_DURABLE_RETRY_DISABLED` is unchanged.
