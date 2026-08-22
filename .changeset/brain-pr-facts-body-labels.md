---
"@roomote/db": patch
"@roomote/github": patch
"@roomote/sdk": patch
"@roomote/bullmq": patch
---

Pull-request facts now keep the PR description and labels from the provider list payloads the sync already receives (GitHub, GitLab, Gitea, Bitbucket, Azure DevOps), and the Brain's pull-request pages carry them: a capped Description section and a labels line, so the Brain holds the "why" behind a change and not only its title.
