---
'@roomote/web': patch
---

Fixes Fast Sessions rejecting every message from anyone other than the Session owner. A coworker replying in a bound Slack thread, or a second person writing in a shared Session, was dropped before their message reached the transcript: silently on chat surfaces, and with a generic error on the web. Only callers that assert an explicit owner are now checked against the conversation's owner; a plain sender is treated as a participant.
