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

## Authorization for release repairs

An explicit request to fix release conflicts authorizes completing the routine
repair end to end: inspect current state, preserve the frozen candidate and
production changes, resolve and validate, deliver through the supported
reconciliation path, and verify the updated promotion head. Do not stop at a
diagnosis or review-only PR when the authorized next steps are available, and
do not ask again for discretionary permission already given. Check for existing
repair PRs and active workflow runs before creating or dispatching duplicates.

Authorization to repair is not authorization to merge the production Promote PR,
enable its auto-merge, tag, publish, or deploy. Those actions require separate
explicit authorization. A replacement release or importing newer develop work
also requires its own scope decision.

Respect actual branch protections and the trusted workflow's independent-human,
exact-commit approval and unresolved-review requirements. Reuse an existing
valid approval for the unchanged resolution SHA; a follow-up request to continue
does not require another approval. If a tooling defect blocks the authorized
repair, fix it with focused tests on a separate develop-based PR, outside the
frozen candidate. Carry that repair through normal integration when authorized
and permitted; never bypass protections, self-approve, or weaken a gate to ship.
If GitHub rejects an operation, report the exact enforced blocker and prepared
fix, rather than inventing an approval requirement or inferring it solely from
incomplete policy metadata.

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

### 11. Monitor the promotion candidate, not just release preparation

Release preparation and promotion are separate validation boundaries. Passing
checks or reviews on the release-preparation PR do not clear the Promote PR.
When the preparation PR merges, find the open Promote PR by its exact
`release/vX.Y.Z` head and `main` base, and record its current head SHA. If the
preparation PR has not merged, report that boundary; do not merge it just to
continue monitoring.

Inspect **both CI and reviews** on the current promotion head:

```bash
gh pr view <promote-pr> --json state,headRefOid,baseRefName,mergeable,reviewDecision,statusCheckRollup
gh pr checks <promote-pr>
gh api --paginate repos/<owner>/<repo>/pulls/<promote-pr>/reviews
gh api --paginate repos/<owner>/<repo>/pulls/<promote-pr>/comments
```

Also retrieve all review threads, including their `isResolved` state, through
the source-control review tool or paginated GraphQL. Inline comments alone do
not establish whether a finding is resolved. Include top-level review summaries
and the Roomote code-review check; green CI is not a substitute for review.

- Require successful **CI**, applicable **Docs**, and required checks on the
  promotion head, not on the preparation head or a previous candidate. Missing,
  queued, running, cancelled, or failed checks are not a pass. Account explicitly
  for conditional skipped jobs rather than treating every skip as success.
- Report outstanding `CHANGES_REQUESTED`, unresolved review findings, failed or
  pending automated reviews, and missing required human approvals separately
  from CI. An empty review list or a null `reviewDecision` is not approval.
- Re-read the head and PR state during each observation. A refresh or
  reconciliation invalidates the old checks and review evidence; restart against
  the new SHA. If the head changes while collecting results, discard that mixed
  snapshot. If the PR merges externally, stop candidate mutation and report the
  observed publication state without initiating release actions.
- While authorized monitoring is active, poll at a bounded interval (for example
  60 seconds for at most 30 minutes), report actionable failures promptly, and
  stop with an explicit pending/input-needed result at the bound. Do not wait
  indefinitely for a human review. Reuse an existing equivalent monitor instead
  of scheduling duplicates; use supported Session follow-up only when available
  and authorized, otherwise report the remaining checks without claiming a
  monitor is running.
- Review fixes stay within the audited candidate scope. Diagnose unrelated
  runtime findings separately; do not silently pull in newer develop commits.
  Candidate conflicts use the reconciliation procedure below, never a manual
  push to the release branch.

Report the Promote PR URL, observed head SHA, CI status, review status, and
remaining blockers independently. Monitoring, a green status, or approval never
authorizes merging, enabling auto-merge, tagging, publishing, or deployment.

## Reconcile a frozen candidate with production

Use **Reconcile Release Candidate** (`release-reconcile.yml`) only with explicit
authorization, for an open, unshipped candidate whose production base has
diverged. The workflow must already be available on trusted `develop`; preparing
its implementation PR is not evidence that reconciliation ran. It never imports
the current develop tree. No tag may exist for the candidate, and the candidate
must not already be contained in `main`.

1. Fetch and pin the full candidate and main SHAs. Revalidate the published
   baseline and open Promote PR. On an ordinary `reconcile/vX.Y.Z` branch rooted
   at that exact candidate, merge only the pinned main with `--no-commit --no-ff`.
   Do not merge develop or use blanket ours/theirs resolution.
2. Resolve each conflict by intent, retaining production hotfixes and candidate
   features/tests. Keep automatically merged files unchanged. Preserve the root
   candidate version, its complete release section, and all published main
   changelog history; do not run versioning or author new release notes. This is
   reconciliation of existing generated artifacts, not a new release cut.
3. Validate the actual merged tree with focused tests and ordinary commit/push
   gates. The review commit must have exactly two parents in order: pinned
   candidate, pinned main. Push only the ordinary `reconcile/vX.Y.Z` branch and
   open a **review-only** PR targeting `release/vX.Y.Z`. Clearly mark it
   **Do not merge: CI applies this reviewed tree**. Record the pins, each
   conflict decision, hotfix preservation evidence, and validation. Resolve all
   review threads and verify an independent human collaborator's approval at the
   exact resolution SHA, reusing an existing valid approval. The reviewer must
   differ from the PR author and have `admin`, `maintain`, or `write` repository
   permission from `GET /repos/{owner}/{repo}/collaborators/{username}/permission`.
   Do not use review `author_association` as an authority proxy: an admin may be
   labeled `CONTRIBUTOR`. Missing or failed permission lookups are not approval;
   retain the workflow's repeated review and permission checks before pushing.
   Do not self-approve or merge this PR.
4. Dispatch **Reconcile Release Candidate** on `develop` with `version` (without
   `v`), `expected_candidate_sha`, `expected_main_sha`, and `resolution_sha`.
   It requires `RELEASE_BOT_TOKEN` so the candidate push can trigger fresh PR CI.
   CI verifies the open PR identities, approval and thread state, exact merge
   parents, unchanged automatic-merge paths, release artifacts, and repeated
   remote pins before creating its own merge commit and fast-forwarding the
   release branch. It never executes code from the candidate or resolution.
5. Inspect the run and actual remote head, then monitor the Promote PR's new CI
   **and reviews** using step 11. CI appends reconciliation provenance to the
   existing Promote PR body. If metadata fails after a successful push, report
   that partial result; do not retry with stale pins or claim no change occurred.
   Revalidate the actual remote head, parents, tree and open PR identity, then
   repair only the missing metadata within the authorized repair. A failed run
   after a successful push is not a reason to push or reconcile again.
   The review-only PR remains unmerged; it can be closed separately once its
   outcome is verified and closure is authorized.

After reconciliation the candidate generally diverges from develop. Ordinary
Release refresh deliberately refuses that state; push-triggered Release runs
also refuse to replace its metadata with the original version-bump SHA. Do not
force the candidate back onto develop. Reconcile a later pinned production base
through another reviewed run, or obtain a separately audited replacement-release
decision if newer develop work is needed. If any pin, approval, publication, or
scope guard fails, stop and re-audit rather than bypassing it.

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
  fast-forward the open candidate from `develop`. Production-base conflicts use
  the explicitly authorized, reviewed CI reconciliation procedure above.
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
