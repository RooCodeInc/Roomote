---
'@roomote/api': patch
'@roomote/slack': patch
---

Slack-started tasks can use external integration MCPs again. Auto-routed launches (channel auto-start, automated app mentions, Slack workflow functions, `!eval`) now seed the mapped human initiator as the acting user when available, and deployment-scoped integrations (for example Supermemory, Linear, Sentry) no longer require a human actor at connect time. User-scoped integrations still need a human actor for that user's credentials.
