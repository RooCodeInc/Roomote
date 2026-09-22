---
'@roomote/github': patch
'@roomote/sdk': patch
'@roomote/web': patch
---

Tasks no longer fail at start when the deployment's GitHub catalog spans multiple GitHub App installations. GitLab-only environments and Blank slates mint the providers they can and skip the impossible GitHub token, GitHub environments mint the environment's installation instead of the full catalog, and the excluded repositories are named in the dequeue log. Only this configuration failure is skippable: a transient provider outage still fails the mint, so a token refresh never strips credentials a running sandbox already holds.
