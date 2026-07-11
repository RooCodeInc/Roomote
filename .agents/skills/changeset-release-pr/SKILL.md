---
name: changeset-release-pr
description: 'Put together a changeset release PR for Roomote: review what merged to develop since the last release, confirm patch/minor/major with the user when unspecified, and author concise changeset release notes that drive the automated Release Roomote Version PR. Use when asked to prep a release, cut a release PR, or write release notes for the next version.'
---

# Changeset Release PR

Use this skill to assemble the release notes that ship the next Roomote version. The deliverable is a normal PR against `develop` that adds pending changeset files under `.changeset/` — nothing else. CI does the actual version bump.

## How releases work here

- Roomote has a **single product version**: the root `package.json` `version` field. Workspace package versions are frozen and meaningless (all packages are private).
- Changesets are an **authoring format only**. `pnpm run version` (`scripts/release/apply-version.mjs`) folds pending `.changeset/*.md` files into the root `CHANGELOG.md`, bumps the root version by the highest pending level, and deletes the consumed files. `changeset version` itself is never run.
- `.github/workflows/release.yml` runs on every push to `develop`. Whenever pending changesets exist, it keeps a **"Release Roomote <version>"** Version PR open against `develop` (branch `changeset-release/develop`, force-pushed by CI). Merging that Version PR cuts a frozen `release/vX.Y.Z` branch and a Promote PR to `main`, which tags and publishes on merge.
- Therefore "putting together a release PR" means **authoring the changeset files and opening a PR that adds them to `develop`**. Once that PR merges, CI opens or refreshes the real Version PR automatically.

Full details: `.changeset/README.md` and `CONTRIBUTING.md#product-releases`.

## Workflow

### 1. Establish the last release reference point

Cross-check three signals; they should agree:

```bash
git tag --sort=-creatordate | head -5          # e.g. v0.0.4
node -p "require('./package.json').version"    # e.g. 0.0.4
head -10 CHANGELOG.md                          # top section: ## 0.0.4 (YYYY-MM-DD)
```

Use the `v<version>` tag as the diff base when it exists. If the root version is ahead of the newest tag (a Version PR merged but the Promote PR has not shipped yet), use the version-bump commit on `develop` instead — resolve it with the repo's own tool:

```bash
node scripts/release/find-version-commit.mjs <version> origin/develop
```

### 2. Collect what changed since then

`develop` is squash-only, so `--first-parent` yields one line per merged PR:

```bash
git fetch origin develop
git log v<last>..origin/develop --oneline --first-parent
```

For anything ambiguous, pull the PR body with `gh pr view <number>` to understand the user-facing impact.

### 3. Subtract what already has a changeset

```bash
ls .changeset/*.md   # ignore README.md
```

Changes already covered by a pending changeset must not get a second note. Read the pending files so wording and bump levels stay consistent with what you add.

### 4. Classify the remaining changes

- **Include**: user-visible or operator-visible changes — new capabilities, behavior changes, fixes to visible symptoms, notable performance or UX improvements.
- **Skip**: chores, docs-only changes, CI/infra tweaks, pure-internal refactors, and dependency bumps with no visible effect. They ride along with the release without a note.

### 5. Confirm the bump level

If the user already said patch/minor/major, use it. **Otherwise ask** — do not guess silently. Present the choice with a recommendation derived from the actual changes:

- **patch** — bug fixes and small non-breaking changes only
- **minor** — new capabilities that stay backward compatible
- **major** — breaking behavior changes

Two mechanics to state when asking:

- The release script applies the **highest level across all pending changesets** to the single product version. If an already-pending changeset carries a higher level than the user picks, the release will bump by that higher level anyway — say so.
- Individual changesets may carry different levels (e.g. features as `minor`, fixes as `patch`); the CHANGELOG groups bullets under `### Major changes`, `### Minor changes`, and `### Patch changes` accordingly, and the overall bump is still the highest present.

### 6. Author the changeset files

One file per logical release note, `.changeset/<descriptive-slug>.md`:

```markdown
---
'@roomote/web': patch
---

One concise, user-facing summary of the change.
```

- **Frontmatter is bump-level only.** Always use exactly one package line: `'@roomote/web': <major|minor|patch>`. Do **not** list multiple packages, invent package maps from the PR diff, or try to mirror changed workspaces — workspace package versions are frozen, and `scripts/release/lib.mjs` ignores package names entirely (it only reads each note’s highest level for CHANGELOG grouping and the max level across notes for the root product bump). Listing real packages still looks like an inaccurate accounting in review.
- Preview the next product version with standard semver/`scripts/release` math before writing the PR body: from `X.Y.Z`, **patch → X.Y.(Z+1)**, **minor → X.(Y+1).0**, **major → (X+1).0.0**. Example: `0.0.4` + minor = **`0.1.0`**, not `0.0.5`.
- Each summary becomes **one CHANGELOG bullet**, and the release script collapses all whitespace to a single line. Write one tight paragraph; no headings, lists, or line breaks that matter.
- Write for a user or operator reading release notes: lead with what changed or what now works, name the surface (e.g. "Settings → Sandboxes", "Slack tasks"), and mention the previous broken behavior for fixes. See any existing `.changeset/*.md` file for tone.
- Group closely related PRs into one note when they ship a single user-facing story; otherwise keep notes separate.

### 7. Open the PR

Commit only the new `.changeset/*.md` files on a feature branch and open a PR against `develop` through the normal delivery path. In the PR body include:

- the expected next version (current version bumped by the highest pending level),
- the drafted release-note bullets grouped by level (a preview of the CHANGELOG section),
- a note that merging this PR makes CI open or refresh the **Release Roomote <version>** Version PR, which is what actually bumps the version and updates `CHANGELOG.md`.

## Guardrails

- Never edit `CHANGELOG.md` or the root `package.json` version by hand, and never commit the output of `pnpm run version` — the CI Version PR owns both.
- Never push to `changeset-release/develop` or `release/v*` branches; CI force-pushes and freezes them.
- Never bump versions in workspace `package.json` files.
- Do not create the "Release Roomote" Version PR or the Promote PR manually.
- Ask for the bump level when it was not specified; recommend one, but let the user decide.
- Do not write notes for changes that already have a pending changeset, and do not pad the changelog with internal noise.
- Do not multi-package-attribute changesets or free-associate package names with PR file paths; always emit a single `'@roomote/web': <level>` frontmatter line.
- When stating the expected next version in a release PR body or chat, use the actual scripted bump (`scripts/release/lib.mjs` `computeNextVersion` / ordinary semver: minor zeros the patch).
