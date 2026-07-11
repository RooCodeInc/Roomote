---
'@roomote/web': minor
---

Plan mode is now always on: the `PlanMode` feature flag has been removed entirely, so planning turns run read-only for every deployment with no opt-out. The model role that powers it is now called "Advisor" in the settings UI and docs — it keeps backing the planning workflow, and it also backs a new `advisor` subagent that the coding agent consults when it is stuck or needs a second opinion. The advisor uses the configured Advisor model when one is set and otherwise falls back to the active coding model at the advisor reasoning level, which defaults to high.
