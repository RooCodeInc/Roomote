---
'@roomote/web': patch
---

Setup no longer skips communication or source-control provider steps just because runtime env vars already satisfy a provider: the picker still appears with the matched option preselected so operators can confirm or change the choice.
