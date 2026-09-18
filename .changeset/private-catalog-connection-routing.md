---
'@roomote/cloud-agents': patch
---

Tell Roomote what to do when someone asks to connect a built-in integration privately. Most built-ins connect once for the whole deployment, so a request to keep a connection to oneself cannot be answered by connecting one silently. Roomote now says that the integration connects for everyone, offers the routes that can be private instead, and connects the built-in only when the person accepts the shared connection.
