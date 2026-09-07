---
name: changeset-release-pr
description: 'Prepare Roomote releases: cut the normal release PR from develop, or ship an urgent patch directly from latest main and synchronize its version back to develop. Use when asked to prep, cut, hotfix, or write notes for a release.'
---

# Changeset Release PR

By default, use this skill to prepare the single release PR that cuts the next
Roomote version. The deliverable is a normal PR against `develop` containing the
root version bump, final `CHANGELOG.md` entry, any public documentation updates
needed for the release's meaningful user-facing features, and deletion of every
consumed pending changeset. Merging it makes CI open the frozen Promote PR to
`main`. For an urgent patch that cannot wait for that path, use the clearly
separated direct-to-main hotfix workflow below.

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

Fetch the release-bearing refs and tags before checking any boundary signal, then
cross-check all four signals; they should normally agree:

```bash
git fetch --tags origin \
  refs/heads/main:refs/remotes/origin/main \
  refs/heads/develop:refs/remotes/origin/develop
git tag --sort=-creatordate | head -5
node -p "require('./package.json').version"
head -10 CHANGELOG.md
gh release view v<version> --json tagName,isDraft,isPrerelease,publishedAt
```

Use the exact newest published `v<version>` tag as the diff base. Verify that its
GitHub Release is published and that the tag is reachable from `origin/main`; a
local-only tag or an unmerged Promote candidate is not a release boundary. If
the root version is ahead of the newest published tag because a release PR
merged but its Promote PR has not shipped yet, use the version-bump commit on
`develop` as the next diff base:

```bash
node scripts/release/find-version-commit.mjs <version> origin/develop
```

Call out the unshipped release and do not merge a later Promote PR before it.
If the user explicitly chooses to replace that unshipped release instead, audit
from the newest published tag, close the older Promote PR, and run
`pnpm run version -- --supersede <patch|minor|major>` so the replacement release
keeps the unshipped notes and folds in every newer pending changeset.

### 2. Collect what changed since then

`develop` is squash-only, so `--first-parent` yields one line per merged PR:

```bash
git fetch origin develop
git log v<last>..origin/develop --oneline --first-parent
```

Here `v<last>` is the exact published tag established in step 1, never an
earlier version-bump commit for the same release.

For anything ambiguous, read the PR body with `gh pr view <number>` to identify
the user-facing or operator-facing impact.

### 3. Identify external contributors and issue reporters

For every merged PR that will have a changelog bullet, inspect its author with
`gh pr view <number> --json author,closingIssuesReferences`. Inspect the author
of every returned issue with
`gh issue view <issue-url> --json author,authorAssociation,url`. Classify PR
authors and issue reporters as external only when they are not bots and are not
code owners. Also require an issue reporter's `authorAssociation` to be outside
`OWNER`, `MEMBER`, and `COLLABORATOR`. Read `.github/CODEOWNERS` directly rather
than inferring its presence from recursive discovery or glob results, and resolve
its individual GitHub-owner entries and organization-team entries before
classifying them. If `.github/CODEOWNERS` does not exist, no author or reporter
is excluded on that basis, but the issue-author association check still applies.
Do not treat someone as external merely because another person merged the PR or
implemented the fix.

- Treat GitHub App and bot accounts as bots; never add contributor thanks for
  them.
- Do not thank maintainers listed directly or through a code-owner team.
- Keep a mapping from each eligible external contributor to the release note
  that covers their PR. If multiple eligible contributors are covered by one
  note, thank each of them in that note.
- Keep a mapping from each eligible external issue reporter and linked issue URL
  to the release note that covers the associated PR. Link each issue and thank
  its reporter in that note.
- When the same person is both the contributor and issue reporter for one note,
  combine the acknowledgement instead of thanking them twice.
- Do not add a thank-you to a skipped internal, docs-only, CI, or dependency
  change that does not receive a changelog bullet.

### 4. Subtract existing pending changesets

```bash
find .changeset -maxdepth 1 -type f -name '*.md' ! -iname 'README.md' -print
```

Read every pending file. A change already covered by a pending changeset must
not receive a duplicate note. Keep it in the complete release-change inventory
for the documentation audit; subtracting a changeset only removes the need to
author another changelog note.

### 5. Classify the remaining changes

- **Include** user-visible or operator-visible capabilities, behavior changes,
  fixes to visible symptoms, and notable performance or UX improvements.
- **Skip** chores, docs-only changes, CI or infrastructure tweaks, internal
  refactors, and dependency bumps with no visible effect. They ship without a
  changelog bullet.

### 6. Audit public documentation coverage

For every included change in the complete release inventory, including changes
already covered by pending changesets, decide whether it is a **meaningful
user-facing feature** that users or operators need documentation to discover,
configure, or use successfully. This normally includes new capabilities,
supported providers or integrations, configuration options, permissions or
prerequisites, and material workflow changes. Small visible fixes, minor polish,
and implementation details generally need a changelog note but not a docs
update.

For each meaningful feature:

- identify the relevant public page or pages under `apps/docs`; read the
  applicable `apps/docs/AGENTS.md` instructions before editing
- compare the shipped behavior and PR context with the current docs; do not
  assume that a feature PR updated docs merely because it has a changeset
- update missing, stale, or incomplete guidance in the release branch, including
  setup steps, prerequisites, permissions, expected behavior, and navigation
  entries when needed
- for every newly added or materially updated provider or integration, verify
  that its page and every overview or comparison entry use a source-backed
  provider icon rather than a generic placeholder; check both page frontmatter
  and rendered overview helpers or tables
- centralize each provider or integration logo reference: prefer one shared
  Iconify slug when available, otherwise add one monochrome asset under
  `apps/docs/logo/integrations/` and map the provider key in
  `apps/docs/snippets/integration-name.jsx`; point page frontmatter and overview
  entries at that shared slug, key, or asset instead of repeating unrelated
  fallbacks or asset URLs
- treat a missing icon, a generic icon used when a source-backed mark exists, or
  inconsistent page and overview marks as incomplete documentation coverage
- keep docs practical and user-facing; do not copy changelog prose or add
  internal implementation details just to mention the feature
- record a feature-to-docs coverage checklist for the release PR body, linking
  each meaningful feature to its updated or already-current docs page

If no included change meets this threshold, explicitly record that the docs
audit found no release-blocking documentation updates. Do not use that outcome
without reviewing every included change, including those with existing pending
changesets.

### 7. Confirm the bump level

If the user specified patch, minor, or major, use it. Otherwise ask and include
a recommendation based on the actual changes:

- **patch** — bug fixes and small non-breaking changes only
- **minor** — backward-compatible new capabilities
- **major** — breaking behavior changes

Explain that the highest level across all pending changesets determines the
single product version. If an existing pending changeset is higher than the
user's choice, say that the higher bump will win. Individual notes may carry
different levels and are grouped by level in the changelog.

### 8. Author missing changesets locally

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
- For a note associated with an issue from an eligible external reporter, link
  the issue and thank them with a concise sentence such as
  `Thanks to @octocat for reporting [#123](https://github.com/owner/repo/issues/123).`
  Use the issue's canonical URL, keep the thanks in the same paragraph, and
  update an existing pending changeset when it covers the reported change.
- These newly authored files are temporary release inputs. `pnpm run version`
  consumes them before the release branch is committed.

### 9. Generate and verify the release

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
- every meaningful user-facing feature has an accurate public docs destination,
  with any required `apps/docs` updates, navigation changes, source-backed
  provider icons, and centralized logo references included
- the diff contains only release artifacts and required public docs updates:
  root `package.json`, `CHANGELOG.md`, relevant files under `apps/docs`, and
  deletions of changesets that already existed on the base branch. Locally
  created missing changesets normally leave no final diff because they are
  created and consumed in the same working tree.

Do not manually rerun the release-script tests, docs validation, repository
lint/format, type checks, Knip, or the pre-push script while preparing the PR.
The PR workflows run the full versions of those checks for changes targeting
`develop`; allow the ordinary push hook to run exactly once as the local static
gate instead of invoking it separately. Do not merge the release PR until the
**CI** workflow and, when `apps/docs` changed, the **Docs** workflow succeed.
Treat that as a release-process gate even when repository rules do not require
status checks.

### 10. Open the release PR

Read `.github/CODEOWNERS` directly again and use its current entries as the
source of truth for release PR ownership and reviewer handling; do not infer
reviewers from PR authorship or a recursive file search.

Commit the generated release artifacts on a feature branch and open a PR against
`develop` titled **Release Roomote X.Y.Z**. The PR body should include:

- the previous and next product versions
- the final changelog bullets grouped by bump level
- the feature-to-docs coverage checklist, including required updates or an
  explicit no-updates-needed result
- validation performed
- a note that squash-merging the PR cuts the release and automatically opens
  the frozen **Promote vX.Y.Z to production** PR against `main`

## Emergency direct-to-main hotfix path

Use this path only for an urgent production patch that cannot wait for the
normal `develop` release flow above. The normal workflow remains the default.
This exception produces two PRs:

1. a complete patch and generated release artifacts targeting `main`
2. a companion PR targeting `develop` that changes only root `package.json` and
   `CHANGELOG.md`

The production PR must merge first. Do not merge the companion until the tag,
images, and GitHub Release have all shipped successfully.

### A. Establish the release state

Fetch both branches and tags, then branch from the exact latest `main` tip:

```bash
git fetch --tags origin \
  refs/heads/main:refs/remotes/origin/main \
  refs/heads/develop:refs/remotes/origin/develop
git switch --create hotfix/<concise-name> origin/main
git tag --sort=-version:refname | head -5
node -p "require('./package.json').version"
head -20 CHANGELOG.md
```

Before continuing, verify:

- `HEAD` is exactly `origin/main`.
- The newest shipped `vX.Y.Z` tag, root version, and top changelog section agree.
- `main` has no pending non-README changeset that `pnpm run version` would
  accidentally consume with the hotfix.
- No newer unshipped Promote PR or release candidate conflicts with the patch
  version. Resolve release ordering rather than guessing.
- The fix is a patch and every required prerequisite is already on `main` or is
  explicitly included because it is safe to ship with the fix.
- The patch preserves the schema N-1 rollback guarantee and does not require an
  incompatible migration, destructive schema change, or coordinated rollout
  that makes direct release unsafe.

### B. Apply the complete fix

Identify the exact merged fix on `develop`, including tests, docs, and required
supporting changes. Read its source PR and compare its merge commit to `main`;
do not copy only the most obvious runtime file. Cherry-pick the smallest complete
commit set, usually the squash commit:

```bash
git cherry-pick <develop-fix-sha>
git diff --stat origin/main...HEAD
git diff --name-status origin/main...HEAD
git diff <develop-fix-sha>^..<develop-fix-sha> -- <expected-fix-paths>
git diff origin/main...HEAD -- <expected-fix-paths>
```

Account for every intentional difference caused by prerequisites or conflict
resolution. Exclude unrelated features, pending `develop` changesets, and
release artifacts from another version.

When the fix depends on an external service or production-like integration,
repeat the smallest safe live check that proves the original symptom is fixed.
Record the environment and observable result without exposing secrets or private
data. If a live check is irrelevant or unavailable, say why and rely on focused
deterministic tests.

### C. Generate and validate the patch release

Add one hotfix-specific patch changeset using the same format as step 8. Commit
the complete fix and changeset separately when useful for auditability, then
consume the changeset through the repository-owned command:

```bash
pnpm run version
```

Never run `changeset version`, and never hand-edit the generated version or
changelog heading. Polish the generated top changelog summary and highlights as
described in step 9, then commit root `package.json` and `CHANGELOG.md` as the
version commit.

Verify that:

- the root version is exactly one patch above the shipped `main` version
- the top `CHANGELOG.md` section contains the complete hotfix note
- the hotfix changeset was consumed and no non-README `.changeset/*.md` remains
- no workspace package version changed
- `origin/main...HEAD` contains only the complete fix plus root `package.json`
  and `CHANGELOG.md`

Preserve the changeset commit in branch history even though the version commit
deletes its file. Do not manually rerun the release-script tests, focused product
tests and type checks covered by the repository suite, formatting, Knip, or the
pre-push script. The hotfix PR workflows run their full versions for changes
targeting `main`; allow the ordinary push hook to run exactly once as the local
static gate instead of invoking it separately. Do not merge the production
hotfix PR until the **CI** workflow and, when `apps/docs` changed, the **Docs**
workflow succeed. Treat that as a release-process gate even when repository
rules do not require status checks.

Repeat any relevant live check after final conflict resolution or release edits;
CI cannot replace external-service or production-like evidence. Failed or
unavailable release-specific or live checks are release blockers unless a
maintainer explicitly accepts and records the risk.

### D. Open the production hotfix PR

Open the hotfix PR against `main`. Include the source fix PR/commit and
prerequisites, previous and next versions, exact patch scope and intentional
differences, all validation and live-check results, rollback instructions, and a
link to the companion PR once available. Require a **merge commit**; never squash
or rebase this PR.

Rollback guidance must distinguish two states:

- Before the tag is consumed externally, revert the hotfix merge commit if that
  is still operationally safe.
- After publication, redeploy the previous immutable `vX.Y.Z`; never move,
  delete, or reuse a published tag. Describe data or schema cleanup separately
  and preserve the N-1 rollback contract.

### E. Prepare the companion develop sync

After the production branch is final, create a branch from latest
`origin/develop` and bring over only the generated product version and changelog:

```bash
git switch --create chore/sync-<version>-on-develop origin/develop
git restore --source <hotfix-tip> -- package.json CHANGELOG.md
git diff --name-only origin/develop
git diff --exit-code <hotfix-tip> -- package.json CHANGELOG.md
git diff --exit-code origin/develop -- .changeset
```

Do not cherry-pick the runtime fix; it should already be on `develop`. Do not run
`pnpm run version` on this branch because that would consume unrelated pending
`develop` changesets. The first diff must list exactly `package.json` and
`CHANGELOG.md`; the other two must be empty. If `develop` independently changed
either release artifact, reconcile deliberately without touching pending
changesets and stop if the companion cannot remain a truthful two-file sync.

Open the companion PR against `develop`. It must be squash-merged only after all
production gates below succeed. Merging it early can make
`.github/workflows/release.yml` freeze the moving `develop` tip as
`release/vX.Y.Z` and open an incorrect Promote PR.

### F. Enforce merge and release order

Do not collapse or reorder these gates:

1. Merge the production hotfix PR into `main` with a merge commit.
2. Wait for **Tag Product Release** to succeed for that `main` merge.
3. Verify the remote annotated tag exists and resolves to the released tree with
   `git ls-remote --tags origin refs/tags/vX.Y.Z` and, after fetching,
   `git rev-parse 'vX.Y.Z^{}'`.
4. Wait for the tag-triggered **Publish GHCR Images** workflow to succeed,
   including image publication and GitHub Release creation. Verify the GitHub
   Release and immutable image tags; tag creation alone is not completion.
5. Only then squash-merge the companion PR into `develop`.

After the tag exists, the `develop` Release workflow sees an already shipped
version and exits without creating a candidate. If a production gate fails,
leave the companion open while the release is repaired or rolled back.

PRs [#1840](https://github.com/RooCodeInc/Roomote/pull/1840) and
[#1841](https://github.com/RooCodeInc/Roomote/pull/1841) demonstrate this
two-branch workflow. Their Notion-specific live checks are an optional example,
not a requirement for unrelated hotfixes.

End the hotfix path by reporting both PR URLs, released version, source fix and
prerequisite commits, exact file scope, live-check result or reason omitted,
validation results, current merge-order gate, and rollback risks.

## Guardrails

- Never edit `CHANGELOG.md` or the root version by hand; generate both with
  `pnpm run version`, review the result, and commit that output in the release
  PR.
- Never run or commit `changeset version` output.
- Never push to `release/v*` manually. CI owns release branches; before a
  candidate reaches `main`, maintainers may amend its notes with
  `pnpm run version -- --amend` and explicitly dispatch the Release workflow to
  fast-forward the open candidate from `develop`.
- Never leave an older Promote PR open when an explicit superseding release is
  prepared. Close it so versions cannot be promoted out of order.
- Never merge an out-of-date release PR. Regenerate it from the latest
  `develop` so every commit included in the cut was part of the release audit.
- Never bump versions in workspace `package.json` files.
- Do not create the Promote PR manually.
- Ask for the bump level when unspecified; recommend one but let the user
  decide.
- Do not duplicate existing pending notes or pad the changelog with internal
  noise.
- Do not release a meaningful user-facing feature with missing or stale public
  docs; update `apps/docs` as part of the release PR when the original feature
  work did not keep it current.
- Do not multi-package-attribute changesets; always emit one
  `'@roomote/web': <level>` line.
- Use the actual version produced by `scripts/release/lib.mjs`; do not guess
  semver in the PR title or body.
