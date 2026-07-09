# Changesets

Roomote uses [Changesets](https://github.com/changesets/changesets) for a **single product version** shared by the monorepo. Workspace packages bump in lockstep; they are not published to npm. The canonical version lives in the root `package.json` and is cut as a GitHub Release (`vX.Y.Z`) when `develop` is promoted to `main`.

## Adding a changeset (optional)

For user-visible or operator-visible changes that should show up in the changelog and influence the semver bump:

```bash
pnpm changeset
```

When prompted for packages, any `@roomote/*` selection is fine — the fixed group bumps every package together. Choose:

- **patch** for bug fixes and small non-breaking changes
- **minor** for new capabilities that stay backward compatible
- **major** for breaking behavior changes

Commit the generated file under `.changeset/` with the rest of the PR.

Chores, docs-only, and pure-internal refactors can skip a changeset; they ride along with the next release.

## How a release ships

1. Merge code to `develop`. When pending changesets exist, CI keeps a **Release PR** open against `develop` that bumps versions and updates the root `CHANGELOG.md`.
2. Merging that Release PR (or any push to `develop` whose version is untagged) opens or refreshes a **Promote PR** (`develop` → `main`).
3. Merging the Promote PR (merge commit, not squash) triggers tagging and a GitHub Release on `main`, which reuses the existing GHCR `v*` publish path for production images and the `latest` channel.

Details live in [`.agent-guidance/operations/deployment.md`](../.agent-guidance/operations/deployment.md).
