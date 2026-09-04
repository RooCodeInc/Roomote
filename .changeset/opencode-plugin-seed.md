---
'@roomote/web': patch
'@roomote/api': patch
'@roomote/bullmq': patch
---

The first Fast message after a deploy no longer stalls for minutes. OpenCode installs `@opencode-ai/plugin` from the npm registry into every config directory it loads and blocks its first request on that install, so a fresh container paid a cold install on its first Fast turn (two to five minutes, and a hard failure once it outran the 300s response timeout). The app image now bakes that install, and the OpenCode SDK server copies it into the global config directory and the shared Fast tools directory before starting, so OpenCode's own install check is a no-op. Non-task inference (routing, summaries, work-kind classification) gets the same head start.
