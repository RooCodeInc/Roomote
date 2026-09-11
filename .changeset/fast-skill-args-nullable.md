---
'@roomote/cloud-agents': patch
---

Fast `list_skills` and `load_skill` now accept null and filler optional arguments, prefer the environment scope when a model fills both scope IDs, report invalid arguments instead of "skill catalog is unavailable", and degrade a failing Settings or repository source to a warning so packaged and instance skills still load.
