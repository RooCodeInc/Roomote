---
'@roomote/web': patch
---

The bullmq service now drains and aborts the Fast turns it is executing before it shuts down, the same way the API does for the turns it admits. Interrupted turns are resumed by the parent-event queue inside the bullmq process, so a deploy that restarted both services could kill a resumed turn a second time with its durable claim and conversation lock still held, leaving the row to wait out both leases (up to 15 minutes) before it ran again. Shutdown now closes admissions, stops fetching queue wakeups, gives in-flight turns the drain window to finish, and aborts the stragglers so each hands its row back to the queue immediately. The window is `R_BULLMQ_SHUTDOWN_DRAIN_MS`, falling back to `R_API_SHUTDOWN_DRAIN_MS` and then 20 seconds; the shutdown sequence itself is shared between the two services.
