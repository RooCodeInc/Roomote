---
title: Public Docs Site
status: active
last_reviewed: 2026-07-07
owner: engineering
summary: The self-contained Mintlify workspace in apps/docs that powers the public product documentation site at docs.roomote.dev.
---

# Public Docs Site

The public, user-facing product documentation lives in `apps/docs/` as the
`@roomote/docs` workspace. It is a self-contained [Mintlify](https://mintlify.com)
site published at [docs.roomote.dev](https://docs.roomote.dev). It is
intentionally independent from `@roomote/web`: it does not rely on any web app
route, MDX compilation, search endpoint, or docs asset. The web app only keeps
external redirects from the legacy in-app `/docs` URLs (see
[Web Dashboard](./web-dashboard.md)).

## Workspace ownership

- `apps/docs` is a first-class workspace (`@roomote/docs`), picked up by the
  `apps/*` glob in `pnpm-workspace.yaml`.
- Scripts: `dev` runs `mint dev`, `validate` runs `mint validate`,
  `check-links` runs `mint broken-links`, and `check` runs validation before
  the broken-link check. The Mintlify CLI (`mint`) is installed globally for
  local development.

## Navigation source of truth

`apps/docs/docs.json` is the single source of truth for navigation, theme,
branding, fonts, and the navbar CTA. When you add, rename, remove, or reorder a
page, update its `navigation` entry in `docs.json` in the same change. Pages are
MDX files referenced by file name (without extension), and internal links use
root-relative paths (`/environments`, not `/docs/...`).

For any `apps/docs/**/*.mdx` or `apps/docs/docs.json` change, run
`mise exec -- pnpm --filter @roomote/docs check`. Do not rely on
`check-links` alone: `mint broken-links` can miss frontmatter or MDX syntax
errors that `mint validate` catches. Quote frontmatter strings that contain
YAML-significant characters such as `:`.

## Content boundaries

The public docs cover setup, self-hosting, product concepts, admin and
configuration workflows, integrations, and common user-facing tasks. Internal
architecture, implementation notes, and runbooks stay in `.agent-guidance/` and
must not be duplicated into the public docs. See `apps/docs/AGENTS.md` for the
full policy.

Treat self-hosting as a primary docs path, not an appendix. Public docs should
help operators, admins, team leads, and users get Roomote running and make agent
work useful for their team. Keep repository setup, communications providers,
inference providers, compute providers, environments, and source-control flows
prominent because they are core to a working deployment.

Roomote should be presented as an open, self-hostable platform for cloud coding
agents. Emphasize that it lets teams run agent work in their own infrastructure
while still fitting into shared workflows like the web dashboard, Slack,
Microsoft Teams, Telegram, GitHub, GitLab, Gitea, Azure DevOps, Linear, and
MCP-backed tools. When comparing with editor-based coding tools, frame Roomote
as the shared, reviewable, outside-the-IDE layer for agent work.

## Public docs terminology

Use these terms consistently in public docs:

- `Roomote` for the product/platform.
- `Roomote agent` for the AI teammate users configure or interact with.
- `Roomote task` for a unit of work.
- `environment` for a configured workspace: repositories, setup guidance,
  environment variables, services, MCP servers, and related task context.
- `deployment` for a running Roomote instance.
- `self-hosted` for operator-managed installations.
- `communications provider` for chat or collaboration surfaces such as Slack,
  Microsoft Teams, or Telegram.
- `source-control provider` for repository and review systems such as GitHub,
  GitLab, Gitea, and Azure DevOps.
- `inference provider` for the model provider used to run agents, such as
  OpenRouter, Anthropic, OpenAI, or other supported model backends.
- `compute provider` for the execution backend that runs Roomote tasks and
  sandboxes, such as Docker, Modal, E2B, or Daytona.
- `integration` for connected external tools that provide task context or
  actions, including Linear and MCP-backed services.
- `MCP server` for a Model Context Protocol tool connection configured at the
  deployment, user, or environment level.

## Voice and page shape

Write for users, admins, operators, and team leads, not internal engineers.
Assume readers are technical but unfamiliar with this codebase. Favor practical
workflow guidance over implementation detail: what to do, what happens next, how
to verify success, and what to check when setup fails.

Organize pages around real jobs: install Roomote, connect source control,
configure an environment, launch a task, review output, operate the deployment,
or troubleshoot a failing setup. Use second person where it helps the flow
(`Start the stack`, `Create an environment`, `Invite the Slack app`). Be direct
about prerequisites, tradeoffs, operational requirements, missing environment
variables, callback URLs, provider credentials, Docker or Compose issues,
tunnels, sandbox limits, and source-control permissions.

A strong public docs page usually answers:

- who this is for
- when to use it
- prerequisites
- setup or workflow steps
- required config or permissions
- what should happen next
- how to verify it worked
- common failure modes
- related next steps

For bullets and numbered lists, start items lowercase when they are fragments
that continue a lead-in sentence. Use sentence case for standalone requirements,
full sentences, or procedural steps.

For self-hosting pages, also cover required services, public URLs and callbacks,
environment variables, persistence and storage expectations, restart and upgrade
implications, and security or permission notes. Treat this as a strong pattern,
not a rigid template.

## Information architecture

Keep everything in one public docs surface under `apps/docs`. Recommended
navigation groups are:

- `Start here`: overview, self-hosting quickstart, first task.
- `Self-hosting`: install, configure, upgrade, environment variables, services,
  networking, source-control callbacks.
- `Admin guides`: dashboard, environments, agent guidance, skills, automations,
  models, inference providers, compute providers.
- `Using Roomote`: launching tasks, reviewing tasks, file attachments,
  follow-ups, common asks.
- `Integrations`: source control, communications providers, Linear, and
  MCP/tool integrations.
- `Concepts`: how Roomote works, agents, tasks, environments, sandboxes.
- `Development`: local development and contributing, if kept in public docs.

Keep Slack and GitHub prominent, but do not imply they are the only supported
paths. For source-control integrations, document GitHub, GitLab, Gitea, and
Azure DevOps as separate supported setup paths when content exists.

## Brand and snippet assets

Branding is self-contained inside `apps/docs`:

- `roomote.css` — Roomote brand styling. Mintlify auto-loads CSS placed at the
  workspace root. It defines the Monaspace Neon code font (bundled in
  `apps/docs/fonts/`), the lime CTA treatment, and rounded surfaces.
- `logo/light.svg` and `logo/dark.svg` — the Roomote wordmark logos.
- `favicon.svg` — the Roomote mark used as the favicon.
- `fonts/` — the locally bundled Monaspace Neon woff2 code font, wired via `roomote.css`.
- Colors use the Roomote lime primary `#B0CD26` with the `#D6EE26` light accent;
  DM Sans is used for headings and body via the `docs.json` `fonts` family reference, which Mintlify loads from its DM Sans web font (not self-hosted).
- Use the Mintlify `mint` theme and keep the interface clean and utility-first.
  The product is technical and operational, so clarity beats flourish.
- Use Lucide icons by default.

Keep source-control, communications, inference, and compute providers
conceptually distinct in copy. These provider categories do not belong in the
public Integrations section because they are already covered by provider-specific
setup pages and guidance.

The public Integrations section lives under `apps/docs/integrations/`:

- `integrations/index.mdx` is the overview and supported-integration table.
- Individual pages use `integrations/<id>.mdx`, where `<id>` follows the
  built-in integration id when practical.
- `docs.json` keeps a dedicated `Integrations` navigation group with the
  overview first and the individual integration pages alphabetized after it.
- The list should track `MCP_INTEGRATIONS` in
  `packages/types/src/mcp-oauth.ts`, plus any durable user-facing setup behavior
  from nearby setup metadata such as
  `packages/cloud-agents/src/server/mcp-self-setup/catalog.ts`.
- Exclude communications providers, inference providers, compute providers, and
  source-control providers from the Integrations group even when they can be
  used during tasks.

When adding, changing, or removing a built-in integration, update the overview
table, the matching integration page, and `docs.json` in the same change. If the
change affects setup model, scope, read/write behavior, tool availability, or
expected task behavior, mention that on the individual page.

Render integration names in overview tables with
`snippets/integration-name.jsx`. Prefer Iconify Simple Icons for integration
logos when available; if Iconify does not ship a logo, add a manual monochrome
fallback in the shared snippet instead of repeating inline SVG or image markup
across MDX pages. Use the same icon source in page frontmatter when Mintlify can
render it cleanly; otherwise use a simple Lucide fallback.

## Keeping docs aligned with shipped behavior

Public docs must stay aligned with shipped user-facing behavior. When a change
alters user-facing behavior, setup, integrations, or workflow copy, update the
relevant page in `apps/docs` in the same change so the public docs do not drift.
