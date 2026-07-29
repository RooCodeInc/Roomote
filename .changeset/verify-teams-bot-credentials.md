---
'@roomote/web': patch
---

Verify Microsoft Teams bot credentials with Microsoft before saving them, so a wrong app id, client secret, or tenant id fails the save with a message naming the field instead of reporting a configured bot that cannot authenticate. Teams settings now also reports when the saved credentials stop authenticating, and explains why the Teams app package cannot be pre-filled from a malformed App (Client) ID.
