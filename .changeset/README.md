# Changesets

Roomote uses [Changesets](https://github.com/changesets/changesets) **as an authoring format only** for a **single product version**. The canonical version is the root `package.json` field; workspace package versions are frozen and meaningless (packages are private and never published). `pnpm run version` (a small in-repo script, `scripts/release/apply-version.mjs`) folds pending changesets into the root `CHANGELOG.md`, bumps the root version by the highest pending level, and deletes the consumed files — `changeset version` itself is never run.

## Adding a changeset (optional)

For user-visible or operator-visible changes that should show up in the changelog and influence the semver bump:

```bash
pnpm changeset
```

When prompted for packages, pick a single package — prefer `@roomote/web`. The
frontmatter only carries the bump level (workspace package versions are frozen);
the release script reads the highest level across all pending changesets and
applies it to the single product version. Prefer one package line over a multi-
package map so the file does not look like a package-level change inventory.
Choose:

- **patch** for bug fixes and small non-breaking changes
- **minor** for new capabilities that stay backward compatible
- **major** for breaking behavior changes

Commit the generated file under `.changeset/` with the rest of the PR.

Chores, docs-only, and pure-internal refactors can skip a changeset; they ride along with the next release.

## How a release ships

1. Merge code to `develop`. When pending changesets exist, CI keeps a **Release Roomote** Version PR open against `develop` that bumps the root version and updates the root `CHANGELOG.md` (nothing else).
2. Merging that Version PR (or any push to `develop` whose version is untagged) cuts a frozen `release/vX.Y.Z` branch at the version-bump commit and opens or refreshes a **Promote PR** (`release/vX.Y.Z` → `main`). Commits merged to `develop` after the version bump wait for the next release instead of riding along.
3. Merging the Promote PR with a **merge commit** (not squash) into `main` tags `vX.Y.Z`, then GHCR builds the matching images; the GitHub Release is created only after those images exist so `releases/latest` never points at a missing image set. The `release/vX.Y.Z` branch can be deleted after the merge.

Branch rules (must match GitHub rulesets):

- **`develop`**: squash-only merges for feature and Version PRs.
- **`main`**: merge-commit-only so promote PRs keep shared history with `develop`.

Maintainers: product tagging requires repository secret `RELEASE_BOT_TOKEN` (see `.github/workflows/tag-release.yml`). Contributor overview: [CONTRIBUTING.md](../CONTRIBUTING.md#product-releases).
