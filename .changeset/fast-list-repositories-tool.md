---
'@roomote/web': minor
---

Fast Sessions have a read-only `list_repositories` tool that searches the deployment's active connected repositories live, by name or description, with paging. The agent uses it to resolve a loosely named repository ("my fork of X") on deployments with more repositories than the prompt lists, and to look up a repository's ID, default branch, provider, host, URL, and mapped environments, instead of asking for a repository URL.
