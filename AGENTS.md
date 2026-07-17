# AGENTS

This file provides a quick-start guide for AI agents working with the Roomote codebase.

Roomote is a product centered on **Roomote agents**. Those agents are the core user-facing product: they can be configured in the web app, triggered from the web UI, and interacted with through integrations such as Slack, Teams, Telegram, Linear, and GitHub.

## Open source and public surfaces

This repository is open source. Treat GitHub and other public surfaces as fully public:

- Do not put customer names, customer data, private deployment details, secrets, credentials, or internal maintainer discussion into commits, PR titles/bodies, PR/issue comments, review replies, or other public artifacts.
- Prefer private channels (for example Slack or the task UI) for anything that is customer-specific, confidential, or only meaningful as internal discussion.
- When writing public text, keep it general enough for an open-source audience and omit private context even when it was available in the private task thread.

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

- `pnpm lint` — oxfmt format check + oxlint + residual ESLint across workspaces
- `pnpm check-types` — TypeScript type checking
- `pnpm format` — oxfmt formatting

## Validation

- `pnpm test` — Vitest across all workspaces
- Targeted tests: `pnpm exec dotenvx run -f .env.test -- pnpm --filter <package> exec vitest run path/to/file.test.ts`
- If `pnpm` is missing or resolves to the wrong version, run `mise install` and retry the command with `mise exec --`
- `pnpm lint && pnpm check-types` — Full static analysis
- `pnpm lint:fast && pnpm check-types:fast && pnpm knip` — Matches the full pre-push suite (pre-push runs the same gates in parallel after oxlint)
- `pnpm check` — Runs lint + check-types + test + knip
- If `pnpm lint` fails because of formatting, run `pnpm format` and rerun `pnpm lint`
- Pre-commit hooks: `lint-staged` (oxfmt on staged files). Pre-push: `node scripts/pre-push-checks.mjs` (oxlint, then residual ESLint + `check-types:fast` + knip in parallel).

## Working notes

- When a skill path is needed, treat repository-root-relative paths as checked-in source files. In this repo that includes [`.agents/skills/...`](.agents/skills/) and [`packages/cloud-agents/src/server/workflows/skills/...`](packages/cloud-agents/src/server/workflows/skills/standard/environment-setup/SKILL.md).
- Treat absolute home-directory skill paths such as `/home/roomote/.agents/skills/...` as activated or installed runtime copies, not as the checked-in source of truth for repository changes.
- Treat workflow prompts and instructions as a first-class control surface. When agent behavior is off, debug prompt clarity before defaulting to code enforcement.
- `apps/docs/` is the public product documentation site (published at `https://docs.roomote.dev`) and should be kept in sync with user-facing product changes.
- **Schema N-1 rollback guarantee:** Roomote must always be able to roll application code back one release against the current database. Do not drop tables or columns that the previous release still reads or writes in the same release that removes the feature. Stop using the columns in app code first, keep them in `packages/db` with an explicit N-1 comment, and drop them only after the next release is the supported rollback target. See `packages/db/AGENTS.md` for the package-local rules.

## Slack message formatting

- Present LLM / agent narrative output in Slack as `markdown` blocks (`{ type: 'markdown', text }`) with standard markdown (`[label](url)`, `**bold**`, lists, tables, code fences) whenever possible. Do not convert that body text into legacy mrkdwn (`*bold*`, `<url|label>`) before posting a `markdown` block.
- Do not migrate hardcoded product UI Block Kit (routing confirmations, sticky footers, unfurls, accessory sections, etc.) for style alone; keep `mrkdwn` there when those builders already rely on it or Slack requires it (for example `section` text with an `accessory`).
- When reading inbound Slack message blocks, continue to accept both `markdown` blocks and legacy `mrkdwn` text objects.
