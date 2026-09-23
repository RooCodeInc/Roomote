---
'@roomote/web': patch
---

When the judgment model decides who an unmentioned thread reply is for, mentions in the thread and the reply now show as the same role labels as their authors (`@Roomote`, `@participant 1`, `@reply author`) instead of raw Slack, Discord, or Teams mention syntax. The model can now tell a reply aimed at a teammate from one aimed at Roomote. The reply also reports whether it mentions Roomote or someone else, as earlier thread messages already did.
