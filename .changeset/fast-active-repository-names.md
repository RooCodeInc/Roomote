---
'@roomote/web': patch
---

Fast Sessions now see the deployment's active connected repositories even when no environments are configured, so a request that names a repository (or "my fork of X") launches an All repositories task instead of asking for a repository URL. The list is capped for large deployments, and the agent only asks when several repositories plausibly match.
