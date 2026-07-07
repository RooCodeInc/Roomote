---
title: API Contract Index
status: active
last_reviewed: 2026-06-29
owner: engineering
summary: Entry point for Roomote API contracts, tRPC routers, webhook documentation, and internal machine-auth API surfaces.
---

# APIs

API contracts, tRPC router documentation, and webhook handler references for the Roomote platform.

## Documentation

- [API App](./api-app.md) — Technical documentation of the Hono API app covering route mounting, middleware, and the handler families hosted in `apps/api`.
- [SDK tRPC Router (Backend-to-Backend)](./trpc-sdk.md) — Technical documentation of the SDK tRPC router covering sub-router inventory, auth middleware, cloud job operations, and client configuration.
- [Web tRPC Router (Browser-to-Next.js)](./trpc-web.md) — Technical documentation of the Web tRPC router covering sub-router inventory, commands pattern, client hooks, and route-handler usage.
- [Webhook Handlers](./webhooks.md) — Technical documentation of webhook handlers for GitHub, GitLab, Azure DevOps, Slack, Teams, Telegram, and Linear covering endpoints, event types, verification, and processing patterns.

## tRPC Architecture (Two Separate Stacks)

### Stack A: SDK / API (backend-to-backend)

- **Router**: `packages/sdk/src/server/routers/app.ts` — sub-routers per domain
- **Served by**: `apps/api` (Hono) at `/trpc`
- **Consumed by**: workers, controller via `packages/sdk/src/client/index.ts` (httpBatchLink + superjson)
- **Auth middleware**: `authenticatedProcedure`, `nonJobProcedure`, `jobScoped(schema, fieldName)` for job-token ID checks plus auth-token scoping on cloud-job resources
- **Public API**: Source-level wrappers live in `packages/sdk/src/<domain>.ts`; published exports are `@roomote/sdk`, `@roomote/sdk/client`, and `@roomote/sdk/server`

### Stack B: Web (browser-to-Next.js)

- **Router**: `apps/web/src/trpc/routers/_app.ts` — all sub-routers inline
- **Served by**: Next.js route handler at `/api/trpc`
- **Commands pattern**: Procedure handlers delegate to `apps/web/src/trpc/commands/<domain>/` with domain logic that commonly uses `@/lib/server` plus package-level server utilities
- **Client usage**:
  - React components: `useTRPC()` hook (tanstack-react-query integration)
  - Server components and route handlers: `createServerCaller()` from `apps/web/src/trpc/server.ts` when server-side code should reuse the web router; direct server utilities are still common for lower-level reads

## Webhook Handlers

- **GitHub**: `apps/api/src/handlers/github/` — PR events, issue/PR comments, installations, push conflict checks
- **GitLab**: `apps/api/src/handlers/gitlab/` — merge request events and MR note mention routing
- **Gitea**: `apps/api/src/handlers/gitea/` — pull request events and PR comment mention routing
- **Azure DevOps**: `apps/api/src/handlers/ado/` — pull request events and PR comment mention routing
- **Slack**: `apps/api/src/handlers/slack/` — Events API, interactive payloads
- **Teams**: `apps/api/src/handlers/teams/` — Bot Framework activities, installation persistence, provider-neutral chat task entry
- **Telegram**: `apps/api/src/handlers/telegram/` — Bot API updates, provider-neutral chat task entry
- **Linear**: `apps/api/src/handlers/linear/` — Agent session webhooks
