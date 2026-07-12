---
'@roomote/web': patch
---

The worker common env file (`~/.roomote/env.sh`, which holds deployment secrets such as cloud tokens) is written owner-only (`0o600`) with `~/.roomote` locked to `0o700`, so other sandbox users cannot read those secrets.
