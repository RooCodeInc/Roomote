---
'@roomote/api': patch
---

Slack-started tasks can now create and update environments. Environment writes previously required the run token's mint-time user claim, but chat-started runs are dequeued as the deployment service principal before an acting user is attached, so they always got 403 "User context required". The handlers now resolve the live task actor (`task_runs.actingUserId`, written only by trusted server-side writers) the same way MCP credential resolution does, falling back to the mint-time claim. Runs with no resolvable human actor are still rejected.
