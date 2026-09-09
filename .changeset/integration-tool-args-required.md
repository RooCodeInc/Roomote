---
'roomote': patch
---

Fix on-demand integration calls from sandbox tasks: `call_integration_tool` now declares `args` as a required, non-recursive object on both the member MCP server and Fast, so gpt-5.x models stop sending `args: null` and Sentry, Linear, and Notion lookups run again.
