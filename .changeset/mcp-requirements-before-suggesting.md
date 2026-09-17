---
'@roomote/cloud-agents': patch
'@roomote/sdk': patch
'@roomote/web': patch
---

Fast Sessions find out what connecting to a service's remote MCP server requires before suggesting it. Roomote now registers the deployment with the provider when the server is added, so an authorization link is only shared when it can succeed; a provider that only accepts approved clients is reported in its own words and Roomote continues with your integration key. When an authorization link does fail, the Session is told why instead of landing on a silent page.
