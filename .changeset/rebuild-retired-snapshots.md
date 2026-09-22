---
'@roomote/web': patch
---

Editing an environment (its setup commands, services, or skills) retires its snapshot, and tasks then set the environment up from scratch until the daily snapshot refresh. The snapshot is now rebuilt within a few minutes of the last edit, so launches are fast again without waiting for the next day.
