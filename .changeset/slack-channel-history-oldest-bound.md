---
"@roomote/web": patch
---

Fix Slack channel history reads failing in busy channels. Time-bounded reads now pass the bound to Slack instead of paging through the whole channel, and the error returned to the agent names the underlying Slack failure.
