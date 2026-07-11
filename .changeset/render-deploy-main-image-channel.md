---
'@roomote/web': patch
---

The one-click Deploy to Render Blueprint now pulls `ghcr.io/roocodeinc/roomote-app:main` for app services instead of `:develop`, so new Render installs track the stable main image channel (aligned with Railway’s primary deploy button).
