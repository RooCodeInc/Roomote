---
title: Workspace Surface Ownership
status: active
last_reviewed: 2026-06-30
owner: engineering
summary: Canonical ownership inventory for the direct apps and packages workspaces in the Roomote monorepo.
---

# Workspace Surface Ownership

This page is the canonical ownership inventory for the direct `apps/*` and `packages/*` workspaces in the Roomote monorepo.

Use [Monorepo Structure](./monorepo-structure.md) for workspace mechanics, toolchain rules, and package-manager conventions. Use this page when you need the canonical docs owner for a specific checked-in workspace surface.

## App Workspaces

| Sub-surface           | Kind         | Coverage   | Owning doc                                                                           | Notes                                                                             |
| --------------------- | ------------ | ---------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `apps/api/`           | api          | documented | [API App](../api/api-app.md)                                                         | Hono host for SDK tRPC plus webhook, MCP, task, artifact, CLI, and health routes. |
| `apps/bullmq/`        | operations   | documented | [Cloud Job Execution Architecture](./cloud-job-execution.md#child-surface-inventory) | BullMQ jobs, snapshot scheduling, and queue-health backstops.                     |
| `apps/controller/`    | architecture | documented | [Cloud Job Execution Architecture](./cloud-job-execution.md#child-surface-inventory) | Queue consumer and worker-dispatch runtime.                                       |
| `apps/dev/`           | operations   | documented | [Dev CLI](../operations/dev-cli.md)                                                  | Local dev bootstrap, seeding, and worker release tooling.                         |
| `apps/docs/`          | feature      | documented | [Public Docs Site](../features/public-docs-site.md)                                  | Self-contained Mintlify public docs workspace published at docs.roomote.dev.      |
| `apps/preview-proxy/` | feature      | documented | [Preview Proxy](../features/preview-proxy.md)                                        | Stable URL proxy for sandbox surfaces.                                            |
| `apps/web/`           | feature      | documented | [Web Dashboard](../features/web-dashboard.md)                                        | Next.js dashboard app, task UI, settings, and browser-facing route surface.       |
| `apps/worker/`        | architecture | documented | [Cloud Job Execution Architecture](./cloud-job-execution.md#child-surface-inventory) | Sandbox task runtime, harness integration, and task execution lifecycle.          |

## Package Workspaces

| Sub-surface                   | Kind         | Coverage   | Owning doc                                                 | Notes                                                                       |
| ----------------------------- | ------------ | ---------- | ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| `packages/ado/`               | feature      | documented | [GitHub Integration](../features/github-integration.md)    | Azure DevOps repository sync and runtime git credential helpers.            |
| `packages/auth/`              | architecture | documented | [Authentication & Authorization](./auth.md)                | Shared auth token generation, validation, and runtime policy helpers.       |
| `packages/cloud-agents/`      | architecture | documented | [Cloud Agents Package](./cloud-agents-package.md)          | Prompt dispatch, routing, packaged workflows, and fast/video agent helpers. |
| `packages/compute-providers/` | architecture | documented | [Compute Providers](./compute-providers.md)                | Provider abstraction, fresh-launch helpers, and runtime bootstrap surfaces. |
| `packages/config-eslint/`     | architecture | documented | [Monorepo Structure](./monorepo-structure.md#packages)     | Shared ESLint config package.                                               |
| `packages/config-typescript/` | architecture | documented | [Monorepo Structure](./monorepo-structure.md#packages)     | Shared TypeScript config package.                                           |
| `packages/db/`                | architecture | documented | [Database Architecture](./database.md)                     | Drizzle schema, migrations, server API, and test factories.                 |
| `packages/env/`               | architecture | documented | [Runtime Environment Handling](./runtime-env.md)           | Shared env schema and host/runtime env access helpers.                      |
| `packages/feature-flags/`     | architecture | documented | [Feature Flags](./feature-flags.md)                        | Redis-backed feature flag package and server sub-exports.                   |
| `packages/gitea/`             | feature      | documented | [GitHub Integration](../features/github-integration.md)    | Gitea repository sync, webhook setup, PR comment, and runtime git credential helpers. |
| `packages/gitlab/`            | feature      | documented | [GitHub Integration](../features/github-integration.md)    | GitLab project sync, scoped token creation, and webhook-adjacent helpers.   |
| `packages/github/`            | feature      | documented | [GitHub Integration](../features/github-integration.md)    | GitHub App integration helpers and shared GitHub package utilities.         |
| `packages/linear/`            | feature      | documented | [Linear Integration](../features/linear-integration.md)    | Linear SDK wrapper and shared Linear integration helpers.                   |
| `packages/redis/`             | architecture | documented | [Redis & BullMQ Infrastructure](./redis-queues.md)         | Redis connection factory, queue helpers, and adapter exports.               |
| `packages/sdk/`               | api          | documented | [SDK tRPC Router (Backend-to-Backend)](../api/trpc-sdk.md) | Shared backend client/server surface for worker and controller RPC calls.   |
| `packages/slack/`             | feature      | documented | [Slack Integration](../features/slack-integration.md)      | Slack notifier, block-kit helpers, queue drains, and mock harness support.  |
| `packages/types/`             | architecture | documented | [Monorepo Structure](./monorepo-structure.md#packages)     | Shared type and schema package used across app and package boundaries.      |
