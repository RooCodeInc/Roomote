---
'@roomote/web': patch
---

Fixed the setup session failing to offer starter-work choices when the orchestration model passes the trusted `setup_starter_tasks` preset together with placeholder questions. The preset now wins and model-supplied questions are discarded instead of rejecting the call, so onboarding no longer stalls at "choose your first work" on models that fill every optional tool parameter.
