---
name: hotfix-release
description: 'Ship an urgent patch directly from latest main, then synchronize only the generated product version and changelog back to develop. Use for production hotfixes that cannot wait for the normal develop release flow.'
---

# Hotfix Release

Use this skill only for an urgent production patch that must bypass the normal
`develop` -> release candidate -> `main` flow. It produces two PRs:

1. a complete patch and generated release artifacts targeting `main`
2. a companion PR targeting `develop` that changes only root `package.json` and
   `CHANGELOG.md`

The production PR must merge first. Do not merge the companion until the tag,
images, and GitHub Release have all shipped successfully.

For ordinary releases, use `changeset-release-pr` instead.

## 1. Establish the release state

Fetch both branches and tags before branching:

```bash
git fetch origin main develop --tags
git switch --create hotfix/<concise-name> origin/main
```

Cross-check the latest product tag, root version, and top changelog section:

```bash
git tag --sort=-version:refname | head -5
node -p "require('./package.json').version"
head -20 CHANGELOG.md
```

Before continuing, verify:

- `HEAD` is exactly the current `origin/main` tip.
- The newest shipped `vX.Y.Z` tag, root version, and changelog agree.
- `main` has no pending non-README changeset that `pnpm run version` would
  accidentally consume with the hotfix.
- No newer unshipped Promote PR or release candidate conflicts with the patch
  version. Stop and resolve release ordering rather than guessing.
- The fix is appropriate for a patch release and its prerequisites are already
  on `main`. Include missing prerequisite commits only when they are required
  for the fix and safe to release together.
- The patch preserves the schema N-1 rollback guarantee and does not require an
  incompatible data migration, destructive schema change, or coordinated
  rollout that makes direct release unsafe.

## 2. Select and apply the complete fix

Identify the exact merged fix on `develop`, including its tests, docs, and
required supporting changes. Read the source PR and compare its merge commit to
`main`; do not copy only the most obvious runtime file.

Cherry-pick the smallest complete commit set onto the hotfix branch. A
single-squash fix can usually be applied directly:

```bash
git cherry-pick <develop-fix-sha>
```

Resolve conflicts from current `main`, then prove the result still represents
the complete intended fix:

```bash
git diff --stat origin/main...HEAD
git diff --name-status origin/main...HEAD
git diff <develop-fix-sha>^..<develop-fix-sha> -- <expected-fix-paths>
git diff origin/main...HEAD -- <expected-fix-paths>
```

Account explicitly for any intentional differences caused by prerequisites or
conflict resolution. Reject unrelated features, pending `develop` changesets,
and release artifacts from another version.

When the fix depends on an external service or a production-like integration,
repeat the smallest safe live check that demonstrates the original symptom is
fixed. Record the environment and observable result without putting secrets or
private data in the public PR. If a live check is irrelevant or unavailable,
say why and rely on deterministic focused tests instead.

## 3. Generate the patch release artifacts

Add one hotfix-specific patch changeset using the repository authoring format:

```markdown
---
'@roomote/web': patch
---

One concise, user-facing summary of the corrected behavior.
```

Commit the patch and changeset separately when useful for auditability, then run
the repository-owned product version command:

```bash
pnpm run version
```

Never run `changeset version`, and never hand-edit the root version or generated
changelog heading. Review and polish the generated top changelog summary and
highlights according to `changeset-release-pr`, without changing the generated
version or omitting the patch note. Commit the generated `package.json` and
`CHANGELOG.md` as the version commit.

Verify that:

- the root version is exactly one patch above the shipped `main` version
- the new top `CHANGELOG.md` section contains the complete hotfix note
- the hotfix changeset was consumed and no non-README `.changeset/*.md` file is
  left on the hotfix branch
- no workspace package version changed
- `origin/main...HEAD` contains only the complete fix plus root `package.json`
  and `CHANGELOG.md`

Preserve the changeset commit in branch history even though the later version
commit deletes the file. This is one reason the `main` PR requires a merge
commit rather than squash.

## 4. Validate the hotfix branch

Run all of the following before opening the production PR:

```bash
pnpm test:release-scripts
pnpm exec oxfmt --check .
node scripts/pre-push-checks.mjs
```

Also run the focused tests and typechecks for every changed product area. Repeat
the relevant live check after the final conflict resolution or release edits
when those edits could affect its result.

Confirm the exact final scope again with `git diff origin/main...HEAD`, and
compare the fix paths with the selected `develop` commit. Failed or unavailable
checks are release blockers unless a maintainer explicitly accepts and records
the risk.

## 5. Open the production hotfix PR

Open a PR from the hotfix branch to `main`. Its body must include:

- the selected source fix PR/commit and every included prerequisite
- previous and next product versions
- exact patch scope and any intentional source differences
- focused tests, release-script tests, pre-push gates, and relevant live checks
- operational risk and rollback instructions
- a link to the companion `develop` sync PR once available
- an explicit instruction to merge with a **merge commit**, never squash or
  rebase

Rollback guidance must distinguish two states:

- Before the tag is consumed externally, revert the hotfix merge commit if that
  is still operationally safe.
- After publication, redeploy the previous immutable `vX.Y.Z`; never move,
  delete, or reuse a published version tag. Describe any data or schema cleanup
  separately, and preserve the N-1 rollback contract.

## 6. Prepare the companion develop sync

After the production branch is final, create a second branch from the latest
`origin/develop`. Bring over only the generated root version and changelog:

```bash
git switch --create chore/sync-<version>-on-develop origin/develop
git restore --source <hotfix-tip> -- package.json CHANGELOG.md
```

Do not cherry-pick the runtime fix: it should already be present on `develop`.
Do not run `pnpm run version` on this branch, because that would consume
unrelated pending `develop` changesets.

Verify:

```bash
git diff --name-only origin/develop
git diff --exit-code <hotfix-tip> -- package.json CHANGELOG.md
git diff --exit-code origin/develop -- .changeset
```

The first command must list exactly `package.json` and `CHANGELOG.md`; the other
two must be empty. If `develop` has independently changed either release
artifact, reconcile deliberately without touching pending changesets, and stop
if the companion cannot remain a truthful two-file sync.

Open the companion PR against `develop`. State that it must be squash-merged
only after the production release gates below succeed. Explain that merging it
early can make `.github/workflows/release.yml` freeze the moving `develop` tip
as `release/vX.Y.Z` and open an incorrect Promote PR.

## 7. Enforce the merge and release order

Do not collapse or reorder these gates:

1. Merge the production hotfix PR into `main` with a merge commit.
2. Wait for **Tag Product Release** to succeed for that `main` merge.
3. Verify the remote annotated tag exists and resolves to the released tree:
   `git ls-remote --tags origin refs/tags/vX.Y.Z` and, after fetching, inspect
   `git rev-parse 'vX.Y.Z^{}'`.
4. Wait for the tag-triggered **Publish GHCR Images** workflow to succeed,
   including image publication and GitHub Release creation. Verify the GitHub
   Release and immutable image tags exist; do not treat tag creation alone as a
   completed release.
5. Only then squash-merge the companion PR into `develop`.

After the tag exists, the `develop` Release workflow sees an already shipped
version and exits without creating a candidate. If any production gate fails,
leave the companion open and unmerged while the release is repaired or rolled
back.

## Evidence and guardrails

PRs [#1840](https://github.com/RooCodeInc/Roomote/pull/1840) and
[#1841](https://github.com/RooCodeInc/Roomote/pull/1841) demonstrate this
two-branch workflow: a complete fix and consumed patch changeset went directly
to `main`, while only the byte-identical root version and changelog were later
synchronized to `develop`. Their Notion-specific live checks are an example,
not a requirement for unrelated hotfixes.

- Do not use this path for a routine release or an incomplete fix.
- Do not release from stale `main` or guess at prerequisites.
- Do not leave an inert changeset on the production branch.
- Do not consume, delete, or rewrite unrelated pending `develop` changesets.
- Do not merge the companion before the production tag, images, and GitHub
  Release are verified.
- Do not move or reuse an immutable release tag during rollback.

## Output standard

End by reporting both PR URLs, the released version, source fix and prerequisite
commits, exact file scope, live-check result or reason omitted, validation
results, current merge-order gate, and rollback risks.
