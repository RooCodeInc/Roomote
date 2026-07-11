---
'@roomote/web': minor
---

Zero is available as a deployment-scoped workspace wallet integration. Admins connect one Zero account under Settings/Integrations; agents use the official Zero MCP connector for auth and funding and the packaged `zero` skill for search → get → fetch → review. The Zero CLI installs on demand when the integration is enabled rather than being baked into every worker image.
