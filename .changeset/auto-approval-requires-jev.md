---
'@roomote/web': patch
---

<!-- audience: internal-nightly -->

Auto mode for tool approvals only uses Jev for now. On a deployment whose judgment model is the Roomote-run model, or that has no judgment model, Auto is unavailable and every tool call that needs approval asks, as before. When Jev answers, the call is still shadowed to the Roomote-run model and captured where those are turned on.
