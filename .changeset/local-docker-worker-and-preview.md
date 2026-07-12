---
'@roomote/web': patch
---

Local Docker development rebuilds worker images that lack current networking tools before launching tasks, routes sandbox HTTP/WebSocket traffic through the public app edge so tunneled clients get a usable live session, and marks preview auth cookies Secure when using SameSite=None and Partitioned so iframe previews authenticate reliably.
