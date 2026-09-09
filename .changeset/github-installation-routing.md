---
'@roomote/web': patch
---

GitHub tools select the matching installation when multiple installations of the configured GitHub App are connected, instead of failing or using an arbitrary installation. Reads require an active connected repository, and searches require exactly one explicit repo:owner/name scope; unscoped and multi-repository searches are no longer accepted, including on single-installation deployments.
