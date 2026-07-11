# AGENTS — Public docs site (`apps/docs`)

This directory is the **public Roomote documentation site**, a self-contained
[Mintlify](https://mintlify.com) workspace published at
[docs.roomote.dev](https://docs.roomote.dev).

## What belongs here

Public, user-facing documentation:

- setup and self-hosting
- product concepts and how Roomote works
- admin and configuration workflows (dashboard, environments, skills,
  automations, integrations, vibes, personal settings)
- integrations and common user-facing tasks

## What does NOT belong here

Internal architecture, implementation notes, and other contributor-only
runbooks do not belong here. Keep public docs focused on operator and user
workflows.

## Voice and positioning

- Present Roomote as an open, self-hostable platform for cloud coding agents.
- Treat self-hosting as a primary path, not an appendix.
- Write for operators, admins, team leads, and users who need to get Roomote
  running and make agent work useful for their team.
- Prefer practical workflow guidance: what to do, what happens next, how to
  verify it worked, and what to check when setup fails.
-   Keep repository setup, communications providers, inference providers, sandbox
  providers, environments, and source-control flows prominent.
- Be direct about prerequisites, tradeoffs, permissions, callback URLs,
  credentials, Docker or Compose issues, tunnels, sandbox limits, and restart or
  upgrade implications.
- Avoid internal-only nouns unless the user sees them in the UI or config.
- For bullets and numbered lists, start items lowercase when they are fragments
  that continue a lead-in sentence. Use sentence case for standalone
  requirements, full sentences, or procedural steps.

Use these terms consistently: `Roomote`, `Roomote agent`, `Roomote task`,
`environment`, `deployment`, `self-hosted`, `communications provider`,
`source-control provider`, `inference provider`, `sandbox provider`,
`integration`, and `MCP server`.

## Keeping docs in sync

When a change alters user-facing behavior, setup, integrations, or workflow
copy, update the relevant page in `apps/docs` **in the same change** so the
public docs do not drift from shipped behavior.

When adding, changing, or removing a built-in integration from
`packages/types/src/mcp-oauth.ts`, update the public Integrations section in the
same change:

- `integrations/index.mdx` for the overview table
- the matching `integrations/<id>.mdx` page
- `docs.json` navigation, keeping pages alphabetized after the overview

Do not add communications, inference, sandbox, or source-control providers to
this Integrations section. Those provider categories have their own docs pages
or setup paths. For integration names in overview tables, use
`IntegrationName` from `snippets/integration-name.jsx`; prefer Iconify Simple
Icons slugs and add a manual monochrome fallback inside that snippet only when
Iconify does not provide the logo.

## Working notes

- `docs.json` is the navigation and branding source of truth. When you add,
  rename, or remove a page, update its `navigation` entry in the same change.
- Use sentence case for sidebar group labels and page `title` frontmatter
  (capitalize the first word and proper nouns only; keep product and brand
  names as written).
- Pages are MDX files referenced by file name (without extension).
- Internal links use root-relative paths (`/environments`, not `/docs/...`).
- Brand assets (`roomote.css`, `logo/`, `favicon.svg`, `fonts/`) live in this
  directory. Keep the docs self-contained; do not reach into `apps/web` assets
  or routes.
- Validate docs changes with
  `mise exec -- pnpm --filter @roomote/docs check`. This runs Mintlify
  validation before the broken-link check, so frontmatter and MDX parse errors
  are caught. `check-links` alone is not enough for changed pages.
- Quote frontmatter strings that contain YAML-significant characters such as
  `:` to avoid parser errors.
