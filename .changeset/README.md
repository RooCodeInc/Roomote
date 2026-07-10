# Changesets

Roomote uses [Changesets](https://github.com/changesets/changesets) for a **single product version** shared by the monorepo. Workspace packages bump in lockstep; they are not published to npm. The canonical version lives in the root `package.json` and is cut as a GitHub Release (`vX.Y.Z`) when `develop` is promoted to `main`.

## Adding a changeset (optional)

For user-visible or operator-visible changes that should show up in the changelog and influence the semver bump:

```bash
pnpm changeset
```

When prompted for packages, any `@roomote/*` selection is fine — the
`.changeset/config.json` **fixed** group lists every workspace package by name
(Changesets does **not** expand globs such as `@roomote/*`), so every package
bumps together. When you add a new `apps/*` or `packages/*` workspace, append
its `package.json` name to that fixed list in the same change. Choose:

- **patch** for bug fixes and small non-breaking changes
- **minor** for new capabilities that stay backward compatible
- **major** for breaking behavior changes

Commit the generated file under `.changeset/` with the rest of the PR.

Chores, docs-only, and pure-internal refactors can skip a changeset; they ride along with the next release.

## How a release ships

1. Merge code to `develop`. When pending changesets exist, CI keeps a **Release PR** open against `develop` that bumps versions and updates the root `CHANGELOG.md`.
2. Merging that Release PR (or any push to `develop` whose version is untagged) cuts a frozen `release/vX.Y.Z` branch at the version-bump commit and opens or refreshes a **Promote PR** (`release/vX.Y.Z` → `main`). Commits merged to `develop` after the version bump wait for the next release instead of riding along.
3. Merging the Promote PR with a **merge commit** (not squash) into `main` tags `vX.Y.Z`, then GHCR builds the matching images; the GitHub Release is created only after those images exist so `releases/latest` never points at a missing image set. The `release/vX.Y.Z` branch can be deleted after the merge.

Branch rules (must match GitHub rulesets):

- **`develop`**: squash-only merges for feature and Version PRs.
- **`main`**: merge-commit-only so promote PRs keep shared history with `develop`.

Maintainers: product tagging requires repository secret `RELEASE_BOT_TOKEN` (see `.github/workflows/tag-release.yml`). Contributor overview: [CONTRIBUTING.md](../CONTRIBUTING.md#product-releases).
