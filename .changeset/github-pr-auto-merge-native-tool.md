---
'@roomote/web': minor
---

Sessions can now enable auto-merge on GitHub pull requests through a native `enable_pull_request_auto_merge` tool. The action requires a signed-in member, binds to the pull request's freshly read head SHA (a moved head is rejected instead of acted on), leaves permissions, branch protections, required checks, and allowed merge methods to GitHub, and only reports success after re-reading the pull request and confirming auto-merge is enabled.
