---
'@roomote/web': patch
---

Peer conversations in established Slack and Discord threads are now standard behavior instead of an experiment, and the **Peer conversations** toggle under Settings > Experimental is gone. When a judgment model is configured, every eligible unmentioned thread reply on Slack, Discord, and Teams is judged before it can start a turn: it routes only when it is addressed to Roomote and expects a response, so messages meant for a colleague and simple acknowledgements stay silent. Unlinked senders never reach the judgment model. Without a judgment model, the existing routing heuristics apply unchanged.
