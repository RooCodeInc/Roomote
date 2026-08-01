# Contributing

Roomote is early in its public project shape. Right now, the most valuable
contribution is a **well-written issue**, not a pull request. Maintainers
triage issues actively, and a clear bug report or focused feature request
helps far more than an unrequested diff.

## Before You Start

- Roomote does not generally accept unsolicited community pull requests.
  Please do not open a PR unless a maintainer has explicitly invited it in an
  issue or discussion.
- The best way to help: open a well-scoped issue with reproduction steps,
  expected vs actual behavior, and your deployment context. The issue forms
  walk you through what maintainers need.
- Pull requests without a maintainer invitation or a clear linked issue will
  likely be closed without review so triage stays high-signal.
- When a PR has been invited: keep it small and scoped, link the issue, and
  include tests or a clear manual validation note when changing behavior.

## Developer Setup

```sh
mise install
pnpm install
pnpm lint
pnpm check-types
pnpm test
```

Use the narrower package-level test commands from `AGENTS.md` when a full suite
is not necessary.

## Product releases

Roomote ships a **single product version** for the monorepo (not per-package npm
releases). [Changesets](https://github.com/changesets/changesets) files are the
authoring format for bump level + release notes; workspace `package.json`
versions are frozen and never bumped. The canonical version is
the root `package.json` field and is published as GitHub Release / tag `vX.Y.Z`.

Optional contributor entrypoint when your change should show up in the changelog:

```sh
pnpm changeset
```

Any `@roomote/*` package selection is equivalent — only the bump level is read.
See [`.changeset/README.md`](.changeset/README.md).

### How a release ships

1. Merge work to `develop` (squash), adding changesets for user-visible changes
   when practical.
2. A maintainer uses the `changeset-release-pr` skill to audit missing notes,
   run `pnpm run version`, and open one **Release Roomote X.Y.Z** PR containing
   the final version bump and `CHANGELOG.md` entry.
3. Squash-merge that release PR. Automation cuts a frozen `release/vX.Y.Z`
   branch at the version-bump commit and opens or refreshes a **Promote
   `vX.Y.Z` to production** PR (`release/vX.Y.Z` → `main`). By default, work
   merged to `develop` afterward waits for the next release. Before promotion,
   a maintainer may amend the current version's notes with
   `pnpm run version -- --amend`, merge those amendments to `develop`, and
   explicitly dispatch the Release workflow for that version. The workflow
   only fast-forwards an open, unshipped candidate with no pending changesets.
4. Merge that promote PR with a **merge commit** (branch rules on `main` allow
   merge only; `develop` stays squash-only). Tagging (`vX.Y.Z`), GHCR image
   publish (`latest`), and the GitHub Release follow from `main` / tag workflows.
   Product tagging requires the `RELEASE_BOT_TOKEN` repository secret.

To replace an unshipped candidate rather than refresh it, run
`pnpm run version -- --supersede <patch|minor|major>` after auditing from the
last published tag. This carries the unshipped notes into the replacement
version; close the older Promote PR before promoting the replacement.

## Contributor License Agreement

All contributors are required to sign the Roomote
[Contributor License Agreement](CLA.md) before their pull requests can be
merged.

Signing is handled automatically on your first pull request: the CLA Assistant
bot posts a comment with instructions, and you sign by replying with:

```text
I have read the CLA Document and I hereby sign the CLA
```

You only need to sign once; your signature applies to all your future
contributions to this repository.

## License

By contributing, you agree that your contribution is licensed under the same
license as the repository. See `LICENSE`.
