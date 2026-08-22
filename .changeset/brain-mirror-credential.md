---
"@roomote/bullmq": patch
---

Re-harden the Brain's git mirror on every gbrain container boot when GBRAIN_GITHUB_PAT is set, so the push credential survives redeploys instead of living in the container's ephemeral home directory and silently stranding every commit after the next deploy.
