---
'@roomote/web': minor
'@roomote/worker': minor
'@roomote/api': minor
---

Add a per-task model switcher: a model chip in the web task composer switches the coding model and reasoning level (with per-role overrides for planning, code review, explore, helper, and vision behind "All roles"), changes apply from the next message and persist across snapshot resumes, and agents can switch their own task's models on request via the new `manage_tasks` `update_models` action.
