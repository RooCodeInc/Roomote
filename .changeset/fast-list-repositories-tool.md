---
'@roomote/web': minor
---

Agents have a read-only `list_repositories` tool that searches connected repositories live, by name or description, with paging. In Fast Sessions it covers every active repository and returns each one's ID, default branch, provider, host, URL, and mapped environments, so a loosely named repository ("my fork of X") is resolved without asking for a URL even on deployments with more repositories than the prompt lists. In task sandboxes it covers the repositories the task is authorized to check out, with their checkout state, alongside the existing `REPOSITORIES.md` index and `clone_repository` tool; it appears in sandboxes once the worker image from this release is in use.
