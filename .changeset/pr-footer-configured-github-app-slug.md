---
'@roomote/web': patch
---

GitHub pull request provenance footers (“Follow up by mentioning @…”) now use the deployment’s configured GitHub App slug at write time when one is set, instead of hardcoding `@roomote` whenever prompt-time resolution fell through to the schema default.
