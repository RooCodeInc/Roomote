---
'@roomote/web': patch
'@roomote/env': patch
---

The `/auth/dev-login` development login route now requires an explicit `WEB_DEV_LOGIN_ENABLED=true` opt-in on top of the existing development-app-env and loopback-bind guards, so a deployment that implicitly resolves to a development app env never exposes the unauthenticated admin backdoor by accident. `pnpm dev` and the in-repo Roomote sandbox environment definition set the flag automatically, so local development and dogfood sandboxes keep working unchanged.
