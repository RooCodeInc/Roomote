---
'@roomote/feature-flags': minor
'@roomote/web': minor
'@roomote/worker': minor
---

Plan mode is now enabled by default for every deployment (an explicit `plan_mode: false` deployment setting still opts out). The model role that powers it is now called "Advisor" in the settings UI and docs — it keeps backing the planning workflow, and it also backs a new hidden `advisor` subagent that the coding agent consults when it is stuck or needs a second opinion. The advisor uses the configured Advisor model when one is set and otherwise falls back to the active coding model at the advisor reasoning level, which defaults to high.
