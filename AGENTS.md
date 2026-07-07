# AGENTS

This file provides a quick-start guide and knowledge map for AI agents working with the Roomote codebase.

Roomote is a product centered on **Roomote agents**. Those agents are the core user-facing product: they can be configured in the web app, triggered from the web UI, and interacted with through integrations such as Slack, Teams, Telegram, Linear, and GitHub. The internal agent guidance below explains how Roomote agents are defined, routed, executed, and surfaced across those product entry points.

## Setup

- `mise install && pnpm install` (requires mise for repo tool versions)
- Treat `mise` as the default toolchain for repo-managed commands like `node`, `npm`, `pnpm`, `uv`, and `python`
- If a tool is missing or resolves to the wrong version, run `mise install` and retry with `mise exec -- <command>`
- Requires Docker Engine with Compose for database, Redis, and artifact-storage containers (Docker Desktop on macOS also works), ngrok for tunneling

## Run

- `pnpm dev` — Start all services locally (PM2-managed)
- `pnpm dev --reset` — Start with database reset
- `pm2 logs [service-name]` / `pm2 status` — Process management

## Build

- `pnpm lint` — Prettier format check + ESLint across workspaces
- `pnpm check-types` — TypeScript type checking
- `pnpm format` — Prettier formatting

## Validation

- `pnpm test` — Vitest across all workspaces
- Targeted tests: `pnpm exec dotenvx run -f .env.test -- pnpm --filter <package> exec vitest run path/to/file.test.ts`
- If `pnpm` is missing or resolves to the wrong version, run `mise install` and retry the command with `mise exec --`
- `pnpm lint && pnpm check-types` — Full static analysis
- `pnpm lint:fast && pnpm check-types:fast && pnpm knip` — Matches the pre-push hook
- `pnpm check` — Runs lint + check-types + test + knip
- If `pnpm lint` fails because of formatting, run `pnpm format` and rerun `pnpm lint`
- Pre-commit hooks: `lint-staged`. Pre-push: `pnpm lint:fast` + `pnpm check-types:fast` + `pnpm knip`.

## Knowledge Map

- Agent guidance index: [`.agent-guidance/README.md`](.agent-guidance/README.md)
- Architecture index: [`.agent-guidance/architecture/README.md`](.agent-guidance/architecture/README.md)
  - Repository surface map: [`.agent-guidance/architecture/repository-surface-map.md`](.agent-guidance/architecture/repository-surface-map.md)
  - Cloud job execution: [`.agent-guidance/architecture/cloud-job-execution.md`](.agent-guidance/architecture/cloud-job-execution.md)
  - Workspace surface ownership: [`.agent-guidance/architecture/workspace-surface-ownership.md`](.agent-guidance/architecture/workspace-surface-ownership.md)
  - Cloud Agents package: [`.agent-guidance/architecture/cloud-agents-package.md`](.agent-guidance/architecture/cloud-agents-package.md)
  - Agent context & prompts: [`.agent-guidance/architecture/agent-context.md`](.agent-guidance/architecture/agent-context.md)
  - Workflow contracts: [`.agent-guidance/architecture/workflow-contracts.md`](.agent-guidance/architecture/workflow-contracts.md)
  - Workflow system: [`.agent-guidance/architecture/workflow-system.md`](.agent-guidance/architecture/workflow-system.md)
  - Sandbox performance: [`.agent-guidance/architecture/sandbox-performance.md`](.agent-guidance/architecture/sandbox-performance.md)
  - Compute providers: [`.agent-guidance/architecture/compute-providers.md`](.agent-guidance/architecture/compute-providers.md)
  - Compute provider usage accounting: [`.agent-guidance/architecture/compute-provider-usage-accounting.md`](.agent-guidance/architecture/compute-provider-usage-accounting.md)
  - Adding a compute provider: [`.agent-guidance/architecture/adding-compute-provider.md`](.agent-guidance/architecture/adding-compute-provider.md)
  - Database architecture: [`.agent-guidance/architecture/database.md`](.agent-guidance/architecture/database.md)
  - Authentication & authorization: [`.agent-guidance/architecture/auth.md`](.agent-guidance/architecture/auth.md)
  - Runtime environment handling: [`.agent-guidance/architecture/runtime-env.md`](.agent-guidance/architecture/runtime-env.md)
  - Redis & BullMQ infrastructure: [`.agent-guidance/architecture/redis-queues.md`](.agent-guidance/architecture/redis-queues.md)
  - Feature flags: [`.agent-guidance/architecture/feature-flags.md`](.agent-guidance/architecture/feature-flags.md)
  - Monorepo structure: [`.agent-guidance/architecture/monorepo-structure.md`](.agent-guidance/architecture/monorepo-structure.md)
  - LLM routing system: [`.agent-guidance/architecture/llm-routing.md`](.agent-guidance/architecture/llm-routing.md)
- Feature index: [`.agent-guidance/features/README.md`](.agent-guidance/features/README.md)
  - Agent entry surfaces: [`.agent-guidance/features/agent-entry-surfaces.md`](.agent-guidance/features/agent-entry-surfaces.md)
  - Slack integration: [`.agent-guidance/features/slack-integration.md`](.agent-guidance/features/slack-integration.md)
  - Slack onboarding timeline: [`.agent-guidance/features/slack-onboarding.md`](.agent-guidance/features/slack-onboarding.md)
  - Linear integration: [`.agent-guidance/features/linear-integration.md`](.agent-guidance/features/linear-integration.md)
  - GitHub integration: [`.agent-guidance/features/github-integration.md`](.agent-guidance/features/github-integration.md)
  - GitLab connection setup: [`.agent-guidance/features/gitlab-connection-setup.md`](.agent-guidance/features/gitlab-connection-setup.md)
  - Gitea connection setup: [`.agent-guidance/features/gitea-connection-setup.md`](.agent-guidance/features/gitea-connection-setup.md)
  - Azure DevOps connection setup: [`.agent-guidance/features/ado-connection-setup.md`](.agent-guidance/features/ado-connection-setup.md)
  - Environment management: [`.agent-guidance/features/environment-management.md`](.agent-guidance/features/environment-management.md)
  - Preview proxy: [`.agent-guidance/features/preview-proxy.md`](.agent-guidance/features/preview-proxy.md)
  - MCP server configuration: [`.agent-guidance/features/mcp-servers.md`](.agent-guidance/features/mcp-servers.md)
  - Web dashboard: [`.agent-guidance/features/web-dashboard.md`](.agent-guidance/features/web-dashboard.md)
  - Public docs site: [`.agent-guidance/features/public-docs-site.md`](.agent-guidance/features/public-docs-site.md)
- API index: [`.agent-guidance/api/README.md`](.agent-guidance/api/README.md)
  - API app: [`.agent-guidance/api/api-app.md`](.agent-guidance/api/api-app.md)
  - SDK tRPC router: [`.agent-guidance/api/trpc-sdk.md`](.agent-guidance/api/trpc-sdk.md)
  - Web tRPC router: [`.agent-guidance/api/trpc-web.md`](.agent-guidance/api/trpc-web.md)
  - Webhook handlers: [`.agent-guidance/api/webhooks.md`](.agent-guidance/api/webhooks.md)
- Operations: [`.agent-guidance/operations/README.md`](.agent-guidance/operations/README.md)
  - Deployment & release: [`.agent-guidance/operations/deployment.md`](.agent-guidance/operations/deployment.md)
  - Monitoring & health checks: [`.agent-guidance/operations/monitoring.md`](.agent-guidance/operations/monitoring.md)
  - Dev CLI: [`.agent-guidance/operations/dev-cli.md`](.agent-guidance/operations/dev-cli.md)
  - Testing strategy: [`.agent-guidance/operations/testing.md`](.agent-guidance/operations/testing.md)
- References index: [`.agent-guidance/references/README.md`](.agent-guidance/references/README.md)
- Generated guidance index: [`.agent-guidance/generated/README.md`](.agent-guidance/generated/README.md)
- Guidance quality index: [`.agent-guidance/quality/README.md`](.agent-guidance/quality/README.md)
- Agent-guidance maintenance skill: [`.agents/skills/agent-guidance-maintenance/SKILL.md`](.agents/skills/agent-guidance-maintenance/SKILL.md)

## Working With This Guidance

- Treat `.agent-guidance/` as the canonical internal guidance tree and use `AGENTS.md` as the concise entrypoint only. `.agent-guidance/` is internal, contributor-facing guidance; `apps/docs/` is the public product documentation site (published at `https://docs.roomote.dev`) and should be kept in sync with user-facing product changes. The hosted marketing site and internal admin apps are not part of this Roomote split.
- Use [`.agents/skills/agent-guidance-maintenance/SKILL.md`](.agents/skills/agent-guidance-maintenance/SKILL.md) as the default repo-local skill for internal agent-guidance maintenance and for code changes that should ship with guidance updates.
- When a skill path is needed, treat repository-root-relative paths as checked-in source files. In this repo that includes [`.agents/skills/...`](.agents/skills/agent-guidance-maintenance/SKILL.md) and [`packages/cloud-agents/src/server/workflows/skills/...`](packages/cloud-agents/src/server/workflows/skills/standard/environment-setup/SKILL.md).
- Treat absolute home-directory skill paths such as `/home/roomote/.agents/skills/...` as activated or installed runtime copies, not as the checked-in source of truth for repository changes.
- Treat workflow prompts and instructions as a first-class control surface. When agent behavior is off, debug prompt clarity before defaulting to code enforcement, then follow the owned prompt-editing policy in [`.agent-guidance/architecture/agent-context.md#prompt-editing-policy`](.agent-guidance/architecture/agent-context.md#prompt-editing-policy) and the testing guidance in [`.agent-guidance/operations/testing.md`](.agent-guidance/operations/testing.md).
- Start from the nearest existing guidance doc and update it in the same change whenever behavior, architecture, API contracts, or operations change.
- When changing proactive Slack setup or onboarding messaging, update [`.agent-guidance/features/slack-onboarding.md`](.agent-guidance/features/slack-onboarding.md) in the same change and call out likely message clustering or notification noise to the human when adding a nearby step.
- Create a new guidance doc only when the change introduces a new durable topic that does not fit cleanly in an existing page:
  - `.agent-guidance/architecture/` for internals, runtime flow, data model, and system design
  - `.agent-guidance/features/` for user-visible behavior and integrations
  - `.agent-guidance/api/` for request/response contracts, routers, and webhooks
  - `.agent-guidance/operations/` for deployment, monitoring, testing, and developer runbooks
- When you add, move, rename, or remove a guidance doc, update the relevant `.agent-guidance/.../README.md` index in the same change.
- Update `AGENTS.md` only when the top-level knowledge map or repo-wide quick-start guidance changes.
- Keep guidance focused and additive: link to deeper docs instead of duplicating content across files.
- New topic docs should follow the existing format with frontmatter (`title`, `status`, `last_reviewed`, `owner`, `summary`).
