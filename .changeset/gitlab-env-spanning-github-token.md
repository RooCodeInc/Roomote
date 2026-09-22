---
'@roomote/web': patch
---

Environment tasks no longer fail at start when the deployment's GitHub catalog spans multiple GitHub App installations. GitLab-only environments mint GitLab and skip the impossible GitHub token. GitHub environments mint the environment's installation instead of the full catalog.
