# Repository Agent Guidance

This directory is the canonical internal agent-guidance knowledge base for the Roomote repository.

The checked-in Roomote guidance lives in `.agent-guidance/`. It is the internal, contributor-facing knowledge base. The public, user-facing product documentation is a separate self-contained Mintlify workspace in `apps/docs/` (published at [docs.roomote.dev](https://docs.roomote.dev)); keep it in sync with user-facing behavior. The hosted marketing site and internal admin apps were removed from this repository during the Roomote split.

Add project-specific architecture, feature, API, and runbook docs as they are formalized.

## Product Overview

Roomote is a product centered on **Roomote agents**.

- Roomote agents are the primary product surface.
- Users interact with those agents through the web dashboard and through integrations such as Slack, Teams, Telegram, Linear, and GitHub.
- The current user-facing agent types include `Generalist`, `Code Reviewer`, and `PR Fixer`.
- The guidance below is organized to explain how those agents are configured, routed, executed, and presented across product surfaces.

## Architecture

- [Architecture Index](./architecture/README.md)
- [Repository Surface Map](./architecture/repository-surface-map.md) — Coverage checklist linking major repo surfaces to their owning docs and explicit exclusions
- [Cloud Job Execution](./architecture/cloud-job-execution.md) — End-to-end cloud job system: queueing, controller dispatch, worker runtime, snapshots
- [Communication Providers](./architecture/communication-providers.md) — Provider-neutral Slack, Teams, Telegram, and future chat messaging boundary
- [Workspace Surface Ownership](./architecture/workspace-surface-ownership.md) — Canonical ownership inventory for the direct `apps/*` and `packages/*` workspaces in the monorepo
- [Agent Context & Prompts](./architecture/agent-context.md) — Prompt layering, Roomote control layers, and runtime assembly
- [Workflow System](./architecture/workflow-system.md) — Workflow-builder inventory, strict Generalist pathways, and the shipped standard packaged-skill catalog
- [Workflow Contracts](./architecture/workflow-contracts.md) — Detailed contract reference for workflow builders, `standardTask()` pathway rules, and the shipped standard skill workflows
- [Sandbox Performance](./architecture/sandbox-performance.md) — React performance investigation and optimization findings
- [Compute Providers](./architecture/compute-providers.md) — Technical documentation of compute provider abstractions covering Docker, Modal, Daytona, E2B, and worker bootstrap behavior
- [Compute Provider Usage Accounting](./architecture/compute-provider-usage-accounting.md) — How Roomote records local compute telemetry and hidden provider-reported costs without billing or quota enforcement
- [Adding a Compute Provider](./architecture/adding-compute-provider.md) — End-to-end checklist for adding a new sandbox-compatible compute provider, including controller wiring, snapshots, and `pnpm dev`
- [Database Architecture](./architecture/database.md) — Technical documentation of the database architecture covering PostgreSQL schema, ClickHouse analytics, Drizzle ORM patterns, encrypted columns, migrations, and test factories
- [Authentication & Authorization](./architecture/auth.md) — Technical documentation of the auth system covering JWT token types, Better Auth browser sessions, API middleware, and tRPC procedure guards
- [Runtime Environment Handling](./architecture/runtime-env.md) — Technical documentation of the shared env schema, the web runtime's dotenvx-backed resolver, and the target Vercel-safe model for web-reachable packages
- [Redis & BullMQ Infrastructure](./architecture/redis-queues.md) — Technical documentation of Redis usage covering the CloudJobQueue, BullMQ job processors, caching patterns, socket.io adapter, and scheduled jobs
- [Feature Flags](./architecture/feature-flags.md) — Technical documentation of the Redis-backed feature flag system covering evaluation, caching, server sub-exports, and usage patterns
- [Monorepo Structure](./architecture/monorepo-structure.md) — Technical documentation of the pnpm monorepo layout covering apps, packages, Turborepo orchestration, ESM conventions, and tool management
- [Cloud Agents Package](./architecture/cloud-agents-package.md) — Package-level ownership guide for `packages/cloud-agents`, linking prompt dispatch, strict Generalist pathway routing, packaged workflows, and fast/video agent subsystems to their deeper docs
- [LLM Routing System](./architecture/llm-routing.md) — Technical documentation of the LLM-enhanced routing system covering agent/workspace selection, context builders, follow-up classification, and confirmation flows

## Features

- [Feature Behavior Index](./features/README.md)
- [Agent Entry Surfaces](./features/agent-entry-surfaces.md) — Cross-surface overview of how work enters Roomote from the web dashboard, Slack, Teams, Telegram, Linear, GitHub, and programmatic launch paths
- [Slack Integration](./features/slack-integration.md) — Bidirectional Slack integration with OAuth, routing, message delivery
- [Slack Onboarding Timeline](./features/slack-onboarding.md) — Canonical timeline of proactive Slack setup/onboarding messages and noise-review guardrails
- [Linear Integration](./features/linear-integration.md) — Linear Agent Sessions integration with OAuth, routing, plan steps
- [GitHub Integration](./features/github-integration.md) — End-to-end technical documentation of the Roomote GitHub integration covering App installation, webhook handling, PR reviews, PR follow-up workflows, and conflict resolution
- [GitLab Connection Setup](./features/gitlab-connection-setup.md) — Operator-facing setup guide for connecting GitLab through Roomote's deployment-token-backed integration path
- [Gitea Connection Setup](./features/gitea-connection-setup.md) — Operator-facing setup guide for connecting Gitea through Roomote's deployment-token-backed source-control path
- [Azure DevOps Connection Setup](./features/ado-connection-setup.md) — Operator-facing setup guide for connecting Azure DevOps through Roomote's deployment-token-backed source-control path
- [Environment Management](./features/environment-management.md) — Technical documentation of Roomote environment and workspace management covering configuration, snapshots, and compute target mapping
- [Preview Proxy](./features/preview-proxy.md) — Technical documentation of the preview proxy service that routes HTTP and WebSocket traffic to Roomote-managed sandbox surfaces via stable URLs
- [MCP Server Configuration](./features/mcp-servers.md) — Technical documentation of MCP server setup covering built-in servers, conditional integrations, packaging, and worker deployment
- [Web Dashboard](./features/web-dashboard.md) — Technical documentation of the Next.js 16 web dashboard covering route structure, design system components, page architecture, and state management

## APIs

- [API Contract Index](./api/README.md)
- [API App](./api/api-app.md) — Technical documentation of the Hono API app covering route mounting, middleware, and the handler families hosted in `apps/api`
- [SDK tRPC Router (Backend-to-Backend)](./api/trpc-sdk.md) — Technical documentation of the SDK tRPC router covering sub-router inventory, auth middleware, cloud job operations, and client configuration
- [Web tRPC Router (Browser-to-Next.js)](./api/trpc-web.md) — Technical documentation of the Web tRPC router covering sub-router inventory, commands pattern, client hooks, and route-handler usage
- [Webhook Handlers](./api/webhooks.md) — Technical documentation of webhook handlers for GitHub, GitLab, Slack, Teams, Telegram, and Linear covering endpoints, event types, verification, and processing patterns

## Operations

- [Operations Runbook Index](./operations/README.md)
- [Deployment & Release](./operations/deployment.md) — Technical documentation of the build, deployment, and release process covering worker builds, Docker setup, CI/CD, and environment management
- [Monitoring & Health Checks](./operations/monitoring.md) — Technical documentation of health monitoring covering API endpoints, controller heartbeat, orphan detection, and common debugging patterns
- [Dev CLI](./operations/dev-cli.md) — Technical documentation of the local development CLI covering database seeding, local seeding, and GitHub bootstrap
- [Testing Strategy](./operations/testing.md) — Technical documentation of how Roomote prioritizes high-signal tests, chooses the right validation layer, and runs repository test paths

## References

- [Reference Index](./references/README.md) — Stable repo-local reference material that does not fit the main architecture/feature/API/operations sections

## Generated Guidance

- [Generated Guidance Index](./generated/README.md) — Placeholder index for generated inventories or other machine-derived reference material when Roomote starts checking them in

## Guidance Quality

- [Agent Guidance Quality Index](./quality/README.md) — Generated garden and scorecard reports for agent-guidance bootstrap and maintenance health
