# @roomote/docs

The public Roomote documentation site, published at
[docs.roomote.dev](https://docs.roomote.dev). It is a self-contained
[Mintlify](https://mintlify.com) workspace: the content, navigation, branding,
and assets all live in this directory and do not depend on `@roomote/web`.

## Structure

- `docs.json` — the single source of truth for navigation, theme, branding, and
  the navbar CTA.
- `*.mdx` — the documentation pages. Each page is referenced by its file name
  (without extension) in the `docs.json` navigation. Add `icon` frontmatter
  with a Lucide icon name to show an icon for the page in the sidebar.
- `roomote.css` — Roomote brand styling (Monaspace Neon code font, lime CTA,
  rounded surfaces). Mintlify auto-loads CSS placed at the workspace root.
- `logo/` — light and dark Roomote wordmark logos used in the navbar.
- `favicon.svg` — the Roomote mark used as the site favicon.
- `fonts/` — the locally bundled Monaspace Neon code font (DM Sans is loaded by Mintlify via the `docs.json` font family reference).

## Local development

Install the Mintlify CLI (`mint`) globally, then run the dev server:

```bash
npm install -g mint
pnpm --filter @roomote/docs dev
```

## Checking links

```bash
mise exec -- pnpm --filter @roomote/docs check
```

`check` runs `mint validate` before `mint broken-links`, so it catches
frontmatter and MDX syntax errors as well as broken internal links.

## Content boundaries

This site is for **public, user-facing** documentation: setup, product
concepts, admin workflows, integrations, and common tasks. See
[`AGENTS.md`](./AGENTS.md) for the full policy.
