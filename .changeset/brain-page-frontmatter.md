---
"@roomote/bullmq": patch
"@roomote/types": patch
---

Every page Roomote writes into the Brain now carries the frontmatter gbrain expects: a real `type` (task-memory, pull-request, github-issue, slack, meeting, notion-page, person) instead of defaulting to a generic concept, a quoted `title`, and a stable `created` date. This clears the nightly lint warning on every page and lets gbrain's type-aware features see Roomote's pages for what they are.
