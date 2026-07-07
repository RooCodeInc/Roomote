---
title: Architecture Index
status: active
last_reviewed: 2026-06-29
owner: engineering
summary: Entry point for Roomote architecture docs covering runtime, prompt and workflow control layers, data, compute, routing, and streaming integration design.
---

# Architecture

System, runtime, data-flow, and integration architecture docs for the Roomote platform.

## Doc Authoring Checklist

- Before committing any doc that names a specific function, class, or constant, run `rg -n "<symbol>" .` to confirm the symbol still exists under that exact name. If it has been renamed or removed, use the current name or omit the stale reference.
- Before committing any doc that names a specific repo path, confirm the path still exists at that location with an existence check such as `test -e <path>` or `ls <path>`, then re-check any repo-relative doc links against the current layout before shipping the doc update.

## Documents

- [Repository Surface Map](./repository-surface-map.md) — Coverage checklist mapping major repo surfaces to their owning docs and explicit exclusions
- [Monorepo Structure](./monorepo-structure.md) — Technical documentation of the pnpm monorepo layout covering apps, packages, Turborepo orchestration, ESM conventions, and tool management
- [Workspace Surface Ownership](./workspace-surface-ownership.md) — Canonical ownership inventory for the direct `apps/*` and `packages/*` workspaces in the monorepo
- [Cloud Agents Package](./cloud-agents-package.md) — Package-level ownership guide for `packages/cloud-agents`, linking prompt dispatch, strict Generalist pathway routing, packaged workflows, and fast/video agent subsystems to their deeper docs
- [Database Architecture](./database.md) — Technical documentation of the database architecture covering PostgreSQL schema, ClickHouse analytics, Drizzle ORM patterns, encrypted columns, migrations, and test factories
- [Authentication & Authorization](./auth.md) — Technical documentation of the auth system covering JWT token types, Better Auth browser sessions, API middleware, and tRPC procedure guards
- [Runtime Environment Handling](./runtime-env.md) — Technical documentation of the shared env schema, the web runtime's dotenvx-backed resolver, and the target Vercel-safe model for web-reachable packages
- [Redis & BullMQ Infrastructure](./redis-queues.md) — Technical documentation of Redis usage covering the CloudJobQueue, BullMQ job processors, caching patterns, socket.io adapter, and scheduled jobs
- [Feature Flags](./feature-flags.md) — Technical documentation of the Redis-backed feature flag system covering evaluation, caching, server sub-exports, and usage patterns
- [Compute Providers](./compute-providers.md) — Technical documentation of compute provider abstractions covering Docker, Modal, Daytona, E2B, and worker bootstrap behavior
- [Compute Provider Usage Accounting](./compute-provider-usage-accounting.md) — How Roomote records Docker, Modal, Daytona, and E2B compute telemetry, persists task rollups, and keeps provider-reported costs internal
- [Adding a Compute Provider](./adding-compute-provider.md) — End-to-end checklist for adding a new sandbox-compatible compute provider, including controller wiring, snapshots, and `pnpm dev`
- [Cloud Job Execution Architecture](./cloud-job-execution.md) — Cloud job execution system covering enqueueing, controller dispatch, worker runtime, snapshots, and completion
- [Communication Providers](./communication-providers.md) — Provider-neutral chat messaging boundary covering Slack compatibility, Teams active follow-up delivery, and outbound adapter contracts
- [Roomote Agent Context](./agent-context.md) — Multi-layer prompt assembly architecture covering OpenCode text channels, Roomote control layers, task-type builders, channel wrappers, environment instructions, subagent execution modes, and personality strategy
- [Workflow System](./workflow-system.md) — Canonical workflow reference covering task-type builders, strict Generalist pathways, and the shipped standard packaged-skill catalog
- [Workflow Contracts](./workflow-contracts.md) — Detailed workflow contract mirror covering `standardTask()` pathway rules, builder-specific rules, and the shipped standard skill mechanics
- [Sandbox Task Performance Debugging](./sandbox-performance.md) — React performance investigation findings for the sandbox task view, covering idle rerender reduction and subscription optimization
- [LLM Routing System](./llm-routing.md) — Technical documentation of the LLM-enhanced routing system covering agent/workspace selection, context builders, follow-up classification, and confirmation flows
