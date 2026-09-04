---
'@roomote/web': minor
---

Fast Sessions can schedule a message to themselves with the new `manage_wakeups` tool. Ask Fast to "remind me in twenty minutes" or "check every ten minutes whether CI is green" and it creates a wakeup for that Session; when it fires, Fast picks the conversation back up with its history in context, does what was asked, and replies on the surface the Session lives on. One-shot wakeups always reply, recurring ones stay quiet unless there is news and cancel themselves when the monitored condition resolves. Wakeups are scoped to the conversation, need no administrator, are capped at ten per Session, and are cancelled when the Session is archived. Firing is durable: each occurrence is claimed on the row, a delayed queue job is only a hint, and a recovery sweep re-adds lost hints.
