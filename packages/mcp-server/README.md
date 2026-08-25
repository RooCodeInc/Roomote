# Roomote MCP server

This package exposes a small Roomote task-management API as a local stdio MCP
server. It delegates to the existing authenticated Roomote MCP endpoint, so it
does not require additional backend routes or broader permissions.

The server provides four tools:

- `list_environments`
- `launch_task`
- `get_task_status`
- `send_follow_up`

## Build

From a Roomote checkout:

```bash
pnpm --filter @roomote/mcp-server build
```

The executable is written to `packages/mcp-server/dist/index.js`.

## Configuration

Set both environment variables before starting the MCP client:

```bash
export ROOMOTE_URL="https://roomote.example"
export ROOMOTE_ACCESS_TOKEN="<user-scoped-bearer-token>"
```

`ROOMOTE_URL` may be the deployment URL or the full `/mcp` endpoint.
`ROOMOTE_ACCESS_TOKEN` must be a user-scoped Roomote auth token or an MCP access
token accepted by that endpoint. The stdio bridge does not currently run the
browser OAuth flow or refresh expired access tokens.

Do not commit the token to a project-level MCP configuration file.

## Claude Code

With the environment variables exported, add the built command at user scope:

```bash
claude mcp add --transport stdio --scope user roomote -- \
  node /absolute/path/to/Roomote/packages/mcp-server/dist/index.js
```

## Cursor

Add this to `~/.cursor/mcp.json`, replacing the absolute path and environment
variable placeholders:

```json
{
  "mcpServers": {
    "roomote": {
      "command": "node",
      "args": [
        "/absolute/path/to/Roomote/packages/mcp-server/dist/index.js"
      ],
      "env": {
        "ROOMOTE_URL": "https://roomote.example",
        "ROOMOTE_ACCESS_TOKEN": "<user-scoped-bearer-token>"
      }
    }
  }
}
```

Prefer the hosted streamable HTTP endpoint described in the
[Roomote MCP guide](https://docs.roomote.dev/integrations/roomote-mcp) when the
client supports remote MCP OAuth. The stdio bridge is intended for clients or
workflows that require a local command transport.
