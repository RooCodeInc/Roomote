---
'@roomote/web': minor
'@roomote/api': minor
'@roomote/sdk': minor
'@roomote/cloud-agents': minor
'@roomote/db': minor
'@roomote/types': minor
---

Any member can now add a remote MCP server, the way they add an integration key: shared with everyone in the deployment, or private to them. Private servers live under Personal Settings → Personal MCP servers, reach only their owner's Sessions and tasks, and stay invisible to everyone else, administrators included. Shared servers are managed by the member who added them and by administrators, and other members see them read-only. A server can be moved between private and shared without authorizing again. Asking Roomote in a Session to connect a service's MCP server now works for every member, shared by default and private on request. Local (stdio) servers remain administrator-only.
