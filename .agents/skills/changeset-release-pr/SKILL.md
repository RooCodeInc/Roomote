---
name: changeset-release-pr
description: 'Prepare the next Roomote release PR: review what merged to develop, fill missing release notes, confirm patch/minor/major when unspecified, run the product version script, and open the final version-and-changelog PR. Use when asked to prep, cut, or write notes for a release.'
---

# Changeset Release PR

Use this skill to prepare the single release PR that cuts the next Roomote
version. The deliverable is a normal PR against `develop` containing the root
version bump, final `CHANGELOG.md` entry, and deletion of every consumed pending
changeset. Merging it makes CI open the frozen Promote PR to `main`.

## How releases work here

- Roomote has a **single product version**: the root `package.json` `version`
  field. Workspace package versions are frozen and meaningless because every
  workspace package is private.
- Changesets are an **authoring format only**. Feature PRs may add them ahead of
  time; this skill creates any missing notes locally before versioning.
- `pnpm run version` (`scripts/release/apply-version.mjs`) folds all pending
  `.changeset/*.md` files into the root `CHANGELOG.md`, bumps the root version by
  the highest pending level, and deletes the consumed files. `changeset version`
  itself is never run.
- `.github/workflows/release.yml` does not create another Version PR. After the
  release PR merges to `develop`, it freezes `release/vX.Y.Z` at that merge and
  opens the Promote PR to `main`. Merging the Promote PR tags and publishes the
  release.

Full details: `.changeset/README.md` and `CONTRIBUTING.md#product-releases`.

## Workflow

### 1. Establish the last release reference point

Cross-check three signals; they should normally agree:

```bash
git tag --sort=-creatordate | head -5
node -p "require('./package.json').version"
head -10 CHANGELOG.md
```

Use the `v<version>` tag as the diff base when it exists. If the root version is
ahead of the newest tag because a release PR merged but its Promote PR has not
shipped yet, use the version-bump commit on `develop` as the next diff base:

```bash
node scripts/release/find-version-commit.mjs <version> origin/develop
```

Call out the unshipped release and do not merge a later Promote PR before it.

### 2. Collect what changed since then

`develop` is squash-only, so `--first-parent` yields one line per merged PR:

```bash
git fetch origin develop
git log v<last>..origin/develop --oneline --first-parent
```

For anything ambiguous, read the PR body with `gh pr view <number>` to identify
the user-facing or operator-facing impact.

### 3. Identify external contributors

For every merged PR that will have a changelog bullet, inspect its author with
`gh pr view <number> --json author`. Thank contributors only when the author is
not a bot and is not a code owner. Read the applicable `CODEOWNERS` file and
resolve its individual GitHub-owner entries and organization-team entries before
classifying the author; if this repository has no `CODEOWNERS` file, no author
is excluded on that basis. Do not treat an author as external merely because
their PR was merged by someone else.

- Treat GitHub App and bot accounts as bots; never add contributor thanks for
  them.
- Do not thank maintainers listed directly or through a code-owner team.
- Keep a mapping from each eligible external contributor to the release note
  that covers their PR. If multiple eligible contributors are covered by one
  note, thank each of them in that note.
- Do not add a thank-you to a skipped internal, docs-only, CI, or dependency
  change that does not receive a changelog bullet.

### 4. Subtract existing pending changesets

```bash
find .changeset -maxdepth 1 -type f -name '*.md' ! -iname 'README.md' -print
```

Read every pending file. A change already covered by a pending changeset must
not receive a duplicate note.

### 5. Classify the remaining changes

- **Include** user-visible or operator-visible capabilities, behavior changes,
  fixes to visible symptoms, and notable performance or UX improvements.
- **Skip** chores, docs-only changes, CI or infrastructure tweaks, internal
  refactors, and dependency bumps with no visible effect. They ship without a
  changelog bullet.

### 6. Confirm the bump level

If the user specified patch, minor, or major, use it. Otherwise ask and include
a recommendation based on the actual changes:

- **patch** — bug fixes and small non-breaking changes only
- **minor** — backward-compatible new capabilities
- **major** — breaking behavior changes

Explain that the highest level across all pending changesets determines the
single product version. If an existing pending changeset is higher than the
user's choice, say that the higher bump will win. Individual notes may carry
different levels and are grouped by level in the changelog.

### 7. Author missing changesets locally

Create one `.changeset/<descriptive-slug>.md` file per logical release note:

```markdown
---
'@roomote/web': patch
---

One concise, user-facing summary of the change.
```

- Always use exactly one package line: `'@roomote/web': <level>`. Package names
  are ignored by the release script; the frontmatter carries only bump level.
- Each summary becomes one changelog bullet. Write one tight paragraph with no
  headings or nested lists.
- Lead with what changed or now works, name the affected product surface, and
  mention the previous symptom when describing a fix.
- Group closely related PRs when they form one user-facing story. Otherwise keep
  their notes separate.
- For a note that covers an eligible external contributor's PR, add a concise
  sentence such as `Thanks to @octocat for contributing this improvement.` Keep
  the thanks in the same paragraph as the release-note summary. Update an
  existing pending changeset when it is the note that covers the contribution.
- These newly authored files are temporary release inputs. `pnpm run version`
  consumes them before the release branch is committed.

### 8. Generate and verify the release

Start from the current `origin/develop` tip. If `develop` advances before the
release PR merges, rebuild the release artifacts from the new tip and repeat the
audit; do not merely merge the new commits into an already-generated release
branch, because their changesets and notes would not have been consumed.

Run the repository-owned version command; never hand-edit the output:

```bash
pnpm run version
```

Then author the **in-app release summary and highlights** for the new top
`CHANGELOG.md` section. The version script seeds a one-sentence summary and a
`### Highlights` list from the bump bullets — replace those with polished,
user-facing copy before opening the PR:

- **Summary**: one plain-language sentence about what this release delivers.
- **Highlights**: 1–4 bullets of the most important changes operators and users
  should notice. Avoid internal jargon, commit SHAs, and package names. Always
  include this section; if there is nothing more specific to call out, use the
  single bullet `Bug fixes and small improvements.`
- Omit any Major/Minor/Patch section with no bullets; never use placeholders or
  filler such as `Nothing of note.`

These fields power the in-app What's new / Update available dialogs (they ship
through GitHub Releases via `extract-changelog-section`). Leave
`### Major/Minor/Patch changes` bullets as generated unless a bullet needs a
clarity fix; do not pad them.

Then verify:

- `package.json` contains the expected next version using ordinary semver
  (`patch` increments patch, `minor` increments minor and zeros patch, `major`
  increments major and zeros minor and patch)
- the new top `CHANGELOG.md` section contains every intended note under the
  correct bump-level heading, plus an edited summary paragraph and a
  `### Highlights` list suitable for in-app display
- every pending changeset was consumed and `.changeset/README.md` remains
- workspace package versions did not change
- the diff contains only release artifacts: root `package.json`,
  `CHANGELOG.md`, and deletions of changesets that already existed on the base
  branch. Locally created missing changesets normally leave no final diff because
  they are created and consumed in the same working tree.

Run the release-script tests and the repository's appropriate static checks
before opening the PR.

### 9. Open the release PR

Commit the generated release artifacts on a feature branch and open a PR against
`develop` titled **Release Roomote X.Y.Z**. The PR body should include:

- the previous and next product versions
- the final changelog bullets grouped by bump level
- validation performed
- a note that squash-merging the PR cuts the release and automatically opens
  the frozen **Promote vX.Y.Z to production** PR against `main`

## Guardrails

- Never edit `CHANGELOG.md` or the root version by hand; generate both with
  `pnpm run version`, review the result, and commit that output in the release
  PR.
- Never run or commit `changeset version` output.
- Never push to `release/v*`; CI owns frozen release branches.
- Never merge an out-of-date release PR. Regenerate it from the latest
  `develop` so every commit included in the cut was part of the release audit.
- Never bump versions in workspace `package.json` files.
- Do not create the Promote PR manually.
- Ask for the bump level when unspecified; recommend one but let the user
  decide.
- Do not duplicate existing pending notes or pad the changelog with internal
  noise.
- Do not multi-package-attribute changesets; always emit one
  `'@roomote/web': <level>` line.
- Use the actual version produced by `scripts/release/lib.mjs`; do not guess
  semver in the PR title or body.
