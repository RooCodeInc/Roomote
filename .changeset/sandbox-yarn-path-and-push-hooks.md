---
'@roomote/worker': patch
---

Put yarn on the sandbox PATH during worker setup, so repositories whose git hooks shell out to yarn no longer fail with `yarn: not found` (which agents were reporting as a missing Git credential). Corepack is enabled for yarn only, leaving the mise-managed pnpm and npm untouched.
