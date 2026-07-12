---
'@roomote/web': minor
---

Local Docker tasks now retain idle containers and resume them in place with bounded cleanup (default 10 retained containers, 24-hour max age; max count `0` disables retention). Blaxel standby retention is likewise bounded (defaults 25 / 168 hours), with env knobs `DOCKER_STANDBY_MAX_*` and `BLAXEL_STANDBY_MAX_*` documented for operators.
