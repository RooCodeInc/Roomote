---
"@roomote/db": patch
"@roomote/sdk": patch
"@roomote/bullmq": patch
---

Pull-request facts are now enriched with the files each PR touched (paths, count, line totals) and who reviewed it, for GitHub, GitLab, Gitea, Bitbucket, and Azure DevOps, through a budgeted pass on the hourly analytics sync. The Brain's pull-request pages gain Changes and Reviews sections and an areas field, so questions about a part of the codebase find the PRs that touched it.
