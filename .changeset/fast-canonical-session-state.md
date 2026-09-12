---
'@roomote/cloud-agents': patch
'@roomote/sdk': patch
'@roomote/types': patch
'@roomote/db': patch
'@roomote/web': patch
---

Sessions no longer announce an outdated status as current. Every model-relevant input, including events the transcript hides, is recorded in one ordered per-Session log with the time it was observed and the order it was admitted. Before each turn, a deterministic reducer decides which state facts are still current, which stay as history, and which are obsolete, using authoritative versions where a source provides them; a queued update that a newer version has already replaced no longer runs. Conversations also rebuild from that same log after a restart, so a resumed Session and a continuing one describe the same state.
