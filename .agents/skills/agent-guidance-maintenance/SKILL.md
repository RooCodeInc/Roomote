---
name: agent-guidance-maintenance
description: Implement and maintain the repository's internal agent-guidance corpus using the installed taxonomy and coverage rules. Use for guidance-only maintenance, for code changes that must ship with agent-guidance updates, and for repo-wide guidance backbone or coverage work in `.agent-guidance/` or `AGENTS.md`.
---

# Repo Agent Guidance Workflow

Implement and maintain the repository's internal agent-guidance tree as a curated knowledge base. Prefer precise updates to the existing corpus over writing one-off markdown from scratch.
Treat `AGENTS.md` as the short map and `.agent-guidance/` as the system of record.
This skill covers three guidance paths: targeted guidance-only maintenance, code-plus-guidance maintenance, and repo-wide guidance backbone or coverage work.

## Start Here

- Read `AGENTS.md` for the repo-wide agent-guidance maintenance rules and top-level knowledge map.
- Read `.agent-guidance/README.md` plus the relevant section index:
  - `.agent-guidance/architecture/README.md`
  - `.agent-guidance/features/README.md`
  - `.agent-guidance/api/README.md`
  - `.agent-guidance/operations/README.md`
- Read existing top-level guidance and any legacy guidance files that predate the current taxonomy when they appear relevant to the task.
- Read the nearest existing guidance page before editing. If the change spans multiple guidance pages, read the neighboring pages that could overlap.
- When the repository does not yet have the agent-guidance backbone, create these files first before deeper guidance work:
  - `.agent-guidance/README.md`
  - `.agent-guidance/architecture/README.md`
  - `.agent-guidance/architecture/repository-surface-map.md`
  - `.agent-guidance/features/README.md`
  - `.agent-guidance/api/README.md`
  - `.agent-guidance/operations/README.md`
  - `.agent-guidance/references/README.md`
  - `.agent-guidance/generated/README.md`
  - `.agent-guidance/quality/README.md`
- Treat those indexes as part of the standard backbone. Keep them even when a section is currently empty, and say so explicitly instead of deleting the index.
- Use the local validator scripts bundled with this skill when repo-level wrappers are absent:
  - `node .agents/skills/agent-guidance-maintenance/scripts/knowledge-check.mjs`
  - `node .agents/skills/agent-guidance-maintenance/scripts/knowledge-garden.mjs`
  - `node .agents/skills/agent-guidance-maintenance/scripts/knowledge-scorecard.mjs`
- If the repository already exposes repo-level `scripts/knowledge-*.mjs`, prefer those wrappers because CI or package scripts may already rely on them.

## Core Maintenance Rules

- `.agent-guidance/` is the canonical internal knowledge base. `AGENTS.md` is only a concise entrypoint and should stay short enough to serve as a fast map rather than an encyclopedia.
- This skill owns internal agent-guidance work. Use it both for guidance-only maintenance and for the guidance portion of code-plus-guidance changes. Do not broaden it into unrelated implementation work, execution plans, delivery workflow guidance, or harness policy guidance unless those guidance surfaces themselves changed.
- Existing `AGENTS.md` content and pre-existing internal guidance files are source material for the guidance backbone. Preserve useful material and reconcile it into the current knowledge map instead of discarding it.
- If the guidance backbone is missing or incomplete, create or repair it locally instead of depending on an external template source at runtime.
- Update the nearest existing guidance page whenever the topic already exists.
- Create a new guidance page only for a durable topic that does not fit cleanly in an existing page.
- When the triggering task also changes code behavior, contracts, integrations, or operations, read the relevant implementation first and ensure the corresponding guidance updates ship in the same change instead of treating the guidance update as optional follow-up.
- For repo-wide agent-guidance bootstrap or full coverage work, every major app/package/service/library surface or equivalent subsystem needs explicit guidance ownership; index-only coverage is not enough.
- For repo-wide agent-guidance bootstrap or full coverage work, create or update `.agent-guidance/architecture/repository-surface-map.md` first and keep it as the completion checklist for every major surface and explicit exclusion.
- A row in `.agent-guidance/architecture/repository-surface-map.md` does not count as coverage by itself; the owning guidance page still needs concrete material on path ownership, key entrypoints/files, runtime boundaries, and major flows.
- In repositories with workspace manifests or more than six major surfaces, shared guidance pages should usually own at most two documented major surfaces.
- For a complex documented surface, the owning guidance page should include a recursive child-surface inventory such as a `## Child Surface Inventory` table with `Sub-surface`, `Kind`, `Coverage`, `Owning doc`, and `Notes` columns, use one row per direct repo-relative child surface, and continue recursing until the documented child surfaces are no longer complex.
- Same-doc child ownership is allowed only when the owning link resolves to the same file and includes a `#fragment` anchor to a dedicated section. Bare same-file links without anchors are invalid.
- Route agent guidance by intent:
  - `.agent-guidance/architecture/` for internals, runtime flow, system design, and data model
  - `.agent-guidance/features/` for user-visible behavior, integrations, and operator-facing product behavior
  - `.agent-guidance/api/` for routers, webhook contracts, and request/response behavior
  - `.agent-guidance/operations/` for deployment, monitoring, testing, and developer runbooks
  - `.agent-guidance/references/` for glossary material, copied stable external references, tool notes, or other repo-local reference pages that agents benefit from having in-repo
  - `.agent-guidance/generated/` for generated or machine-derived reference material such as schema snapshots, inventories, or extracted contract guidance
  - `.agent-guidance/quality/` for scorecards, garden reports, coverage audits, and other mechanical quality signals
- When you add, move, rename, or remove a guidance doc, update the matching `.agent-guidance/.../README.md` index in the same change.
- Update `AGENTS.md` only when the top-level knowledge map or repo-wide quick-start guidance changes.
- New guidance pages must include frontmatter: `title`, `status`, `last_reviewed`, `owner`, `summary`.
- When materially editing an existing doc, keep the frontmatter accurate and refresh `last_reviewed`.

## Workflow

### 1. Classify the change

- Determine whether the update belongs to architecture, features, API, operations, or top-level repo guidance.
- Check whether the request is guidance-only maintenance, code-plus-guidance maintenance, or agent-guidance reorganization/index work.
- Narrow the target using repository context before asking the user for clarification. Ask only if multiple doc surfaces remain equally plausible.
- For repo-wide guidance implementation or full guidance coverage work, identify the major repo surfaces up front, update `.agent-guidance/architecture/repository-surface-map.md` before expanding the rest of the agent-guidance tree, keep that inventory live while you document, and treat any undocumented major surface as incomplete work unless it is trivial, generated, or dead.
- When a documented surface is still internally complex after the first overview doc, add a recursive `## Child Surface Inventory` table in that owning doc, use one direct repo-relative child surface per row, and treat undocumented or still-complex documented child surfaces as incomplete work until the recursion bottoms out.

### 2. Choose the guidance path

- `Guidance-only maintenance`: use this path when the request is updating or correcting internal agent guidance without changing repository behavior. Focus on the nearest existing guidance surface, related indexes, and guidance validation.
- `Code-plus-guidance maintenance`: use this path when repository behavior, contracts, integrations, or operations changed and the agent guidance must ship with that change. Read the relevant implementation first, then update the nearest existing guidance in the same change.
- `Repo-wide agent-guidance backbone or coverage work`: use this path when the repository is missing foundational internal guidance structure, lacks durable ownership coverage, or the request explicitly asks for broad agent-guidance implementation or repair.

### 3. Find the primary guidance surface

- Use the section indexes and current guidance corpus to find the closest existing page.
- Prefer extending an existing page over creating a sibling doc.
- If the topic spans multiple pages, choose one primary page and add concise cross-links from the others instead of duplicating content.

### 4. Ground the update in code and current guidance

- Read the implementation files and the current target guidance page.
- Read adjacent guidance pages that share boundaries with the topic so you do not create overlap or drift.
- Keep framing and terminology consistent with the current guidance index and nearby pages.

### 5. Create or repair the backbone when needed

- If any backbone entrypoint is missing, create it in local style before deeper guidance work:
  - `.agent-guidance/README.md`
  - `.agent-guidance/architecture/README.md`
  - `.agent-guidance/architecture/repository-surface-map.md`
  - `.agent-guidance/features/README.md`
  - `.agent-guidance/api/README.md`
  - `.agent-guidance/operations/README.md`
  - `.agent-guidance/references/README.md`
  - `.agent-guidance/generated/README.md`
  - `.agent-guidance/quality/README.md`
- If `AGENTS.md` is missing, create a concise repo-level quick-start map. If it already exists, preserve useful setup and knowledge-map material and reconcile it into the agent-guidance backbone.
- Keep `AGENTS.md` short enough to stay skimmable. Move deep design history, long reference material, or detailed operational guidance into `.agent-guidance/` and link to it from the map.
- Populate new backbone files with repository-specific content immediately. Do not leave starter placeholders behind. For sections that do not yet have real guidance, keep the index and say explicitly that no current documents are required there yet.

### 6. Edit in local style

- Match the structure of the doc you are editing; do not force every page into a universal template.
- For new guidance pages, mirror the nearest neighbor in the target section.
- Use concrete repository references. Prefer clickable file paths and line links when they materially clarify behavior.
- Include only the sections that help the reader: overview, system flow, key files, configuration, debugging, data flow, extension points, or operational notes.
- Use tables and ASCII diagrams when they improve clarity.
- Keep guidance additive: link to deeper guidance instead of restating it.

### 7. Maintain indexes and cross-links

- Update the relevant section `README.md` when doc inventory changes or a one-line summary becomes stale.
- Update `.agent-guidance/README.md` when a new top-level doc should appear in the repository knowledge map.
- If the repo grows stable glossary/reference material, generated inventories, or quality reports, link them from the matching `.agent-guidance/` index so they are discoverable without bloating `AGENTS.md`.
- Update neighboring links when the change creates a new important relationship.

### 8. Validate the agent-guidance change

- Verify the doc is in the right section and overlaps are minimized.
- Verify frontmatter exists and matches the current scope.
- Verify referenced file paths and doc links are correct.
- Verify README indexes mention the new or renamed guidance page when required.
- If code behavior changed, ensure guidance updates ship in the same change.
- Run the best available agent-guidance validation surface after editing:
  - first choice: repo-level `scripts/knowledge-*.mjs` wrappers when the repository already installs them
  - otherwise: the local skill scripts under `.agents/skills/agent-guidance-maintenance/scripts/`

## Legacy Guidance Reconciliation

- If the repository already has useful internal guidance or a pre-existing `AGENTS.md`, treat them as source material for the agent-guidance backbone.
- Preserve existing files unless the task explicitly calls for replacement or cleanup.
- Pull durable knowledge into the current guidance flow by extending the right existing page, updating the section indexes, and linking older guidance where that is the safest first step.
- Prefer incremental reconciliation over big-bang rewrites: index first, normalize structure later.
- If an older guidance page is still the right home, keep it and make it discoverable through the current guidance indexes instead of rewriting it just to match the starter shape.

## Opportunistic Improvement

- While editing agent guidance, look for small high-confidence improvements to the agent-guidance backbone in the same area: stale index entries, missing cross-links, weak one-line summaries, outdated frontmatter, or obviously misfiled guidance pages.
- Make those small fixes in the same change when they are local and clearly correct.
- If the current task reveals a missing durable doc surface, create it or extend the nearest index when the correct home is clear.
- Do not broaden into a taxonomy rewrite, large guidance reorganization, or repo-wide agent-guidance cleanup unless the user asked for that specifically.
- If you notice a larger agent-guidance system gap that is real but out of scope, name it explicitly in the output instead of silently expanding the task.

## When To Create A New Doc

Create a new guidance page only when all of the following are true:

- The topic is durable and will likely need future maintenance.
- The nearest existing page would become unfocused or misleading if you force the content into it.
- The new page has a clear home under `architecture`, `features`, `api`, or `operations`.
- You are prepared to update the corresponding section index in the same change.

## When To Touch `AGENTS.md`

Only update `AGENTS.md` when:

- repo-wide setup, run, build, or validation guidance changed,
- the top-level guidance knowledge map changed,
- or the top-level guidance taxonomy changed.

Do not use `AGENTS.md` for routine feature or implementation guidance. If an older `AGENTS.md` contains durable system knowledge, move that knowledge into `.agent-guidance/` and keep `AGENTS.md` focused on quick-start guidance and the top-level map.

## Output Standard

- Say whether you created or repaired the agent-guidance backbone, implemented repo-wide coverage, or performed targeted maintenance.
- Say which guidance path you used: guidance-only maintenance, code-plus-guidance maintenance, or repo-wide agent-guidance backbone or coverage work.
- List which guidance page or pages you updated and why they were the right surfaces.
- Call out any new doc, section `README.md` update, `AGENTS.md` update, or `.agent-guidance/architecture/repository-surface-map.md` ownership change.
- Call out which validation commands ran and whether repo-level wrappers or local skill scripts were used.
- If the requested change leaves follow-up doc gaps outside scope, name them explicitly instead of silently broadening the task.
