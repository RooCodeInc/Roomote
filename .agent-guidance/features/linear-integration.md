---
title: Linear Integration
status: active
last_reviewed: 2026-07-09
owner: engineering
summary: Current Linear Agent Sessions, OAuth, MCP, webhook, and follow-up guidance for Roomote's single-deployment model.
---

# Linear Integration

Linear lets Roomote act as an agent inside Linear issues and sessions. The Linear app installation is deployment-scoped, while individual Linear users can still be mapped to Roomote users for attribution and acting-user credential refresh.

## Key Code

- [`apps/api/src/handlers/linear/index.ts`](../../apps/api/src/handlers/linear/index.ts): Linear webhook and session handlers.
- [`apps/api/src/handlers/mcp/linear.ts`](../../apps/api/src/handlers/mcp/linear.ts): Linear MCP proxy.
- [`packages/linear/src/create-linear-agent-job.ts`](../../packages/linear/src/create-linear-agent-job.ts): task launch helper.
- [`packages/linear/src/drain-linear-messages.ts`](../../packages/linear/src/drain-linear-messages.ts): active worker follow-up delivery.
- [`packages/linear/src/find-active-linear-job.ts`](../../packages/linear/src/find-active-linear-job.ts): active job lookup.
- [`packages/sdk/src/server/routers/linear-sessions.ts`](../../packages/sdk/src/server/routers/linear-sessions.ts): SDK router used by workers and API handlers.
- [`packages/sdk/src/server/lib/mcp/linear-connections.ts`](../../packages/sdk/src/server/lib/mcp/linear-connections.ts): deployment-scoped Linear MCP lookup helpers.
- [`apps/worker/src/callbacks/linear-agent.ts`](../../apps/worker/src/callbacks/linear-agent.ts): worker-to-Linear activity callbacks.

## Installation And MCP

1. A deployment operator connects Linear from Settings or setup.
2. The OAuth callback stores the Linear installation.
3. The successful install is mirrored into `mcp_connections` with `mcpId = 'linear'` and `userId = null`.
4. Linear is enabled in `deployment_mcp_enablements`.
5. Router and worker MCP discovery can now treat Linear like other deployment-scoped curated MCPs.

The Linear organization/workspace identifiers are provider identifiers from Linear. They are not Roomote workspaces.

## Webhook Flow

1. Linear sends a signed webhook to the API.
2. The handler validates the signature and records idempotency in `webhooks`.
3. The handler resolves the Linear installation, issue/session metadata, linked user when available, and existing active task if one exists.
4. New actionable sessions route to a Roomote launch target.
5. Follow-up messages drain into the active worker or create a snapshot resume when the previous task is resumable.

When a routing decision needs user input, Linear uses its elicitation/fallback path to pick the workspace, but the product model remains one Roomote deployment.

## Runtime Behavior

- Linear outbound activity uses the Linear Agent Sessions API.
- Worker callbacks emit thoughts, actions, plan updates, request-user-input prompts, closeouts, and terminal failure information.
- Active follow-ups update `task_runs.actingUserId` when the Linear user maps to a Roomote user, so user-scoped MCP credentials can refresh before the next turn.
- Deployment-scoped MCP connections, such as Linear itself, use `mcp_connections.userId = null`.

## Data Model

Current Linear-facing state is deployment-wide unless it explicitly references a user, task, session, or issue:

- `linear_installations`
- `linear_user_mappings`
- `linear_pending_selections`
- `mcp_connections`
- `deployment_mcp_enablements`
- `task_runs`
- `tasks`
- Redis follow-up queues for active workers

Linear authorization checks the signed webhook, deployment installation, linked user where needed, and task/session ownership.

## Testing

Use focused tests around webhook routing, active-job matching, and resume behavior:

- [`apps/api/src/handlers/linear/__tests__`](../../apps/api/src/handlers/linear/__tests__)
- [`packages/linear/src/__tests__`](../../packages/linear/src/__tests__)
- [`apps/worker/src/callbacks/__tests__/linear-agent.test.ts`](../../apps/worker/src/callbacks/__tests__/linear-agent.test.ts)

For MCP changes, also cover [`packages/sdk/src/server/lib/mcp/linear-connections.ts`](../../packages/sdk/src/server/lib/mcp/linear-connections.ts) callers.
