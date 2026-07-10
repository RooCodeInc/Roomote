# AGENTS

This file provides a quick-start guide for AI agents working with the Roomote codebase.

Roomote is a product centered on **Roomote agents**. Those agents are the core user-facing product: they can be configured in the web app, triggered from the web UI, and interacted with through integrations such as Slack, Teams, Telegram, Linear, and GitHub.

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

## Working notes

- When a skill path is needed, treat repository-root-relative paths as checked-in source files. In this repo that includes [`.agents/skills/...`](.agents/skills/) and [`packages/cloud-agents/src/server/workflows/skills/...`](packages/cloud-agents/src/server/workflows/skills/standard/environment-setup/SKILL.md).
- Treat absolute home-directory skill paths such as `/home/roomote/.agents/skills/...` as activated or installed runtime copies, not as the checked-in source of truth for repository changes.
- Treat workflow prompts and instructions as a first-class control surface. When agent behavior is off, debug prompt clarity before defaulting to code enforcement.
- `apps/docs/` is the public product documentation site (published at `https://docs.roomote.dev`) and should be kept in sync with user-facing product changes.
