# Contributing

Roomote is early in its public project shape. We welcome focused fixes,
documentation improvements, and small integration/runtime improvements that are
easy to review.

## Before You Start

- Open a well-scoped issue before starting code changes. Roomote currently
  prefers well-written issues over unsolicited pull requests.
- If you want to contribute code, first describe the problem, proposed approach,
  and relevant self-hosting context in an issue or existing discussion.
- Pull requests without a clear issue, maintainer discussion, or focused
  reproduction may be closed so maintainers can keep triage high-signal.
- Keep pull requests small and scoped.
- Include tests or a clear manual validation note when changing behavior.

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
releases). Workspace `package.json` versions move in lockstep via
[Changesets](https://github.com/changesets/changesets). The canonical version is
the root `package.json` field and is published as GitHub Release / tag `vX.Y.Z`.

Optional contributor entrypoint when your change should show up in the changelog:

```sh
pnpm changeset
```

Any `@roomote/*` package selection is equivalent under the fixed group. See
[`.changeset/README.md`](.changeset/README.md).

### How a release ships

1. Merge work to `develop` (squash). When pending changesets exist, automation
   opens a **Release Roomote** Version PR that bumps lockstep versions and
   `CHANGELOG.md`.
2. When the product version is untagged, automation cuts a frozen
   `release/vX.Y.Z` branch at the version-bump commit and opens or refreshes a
   **Promote `vX.Y.Z` to production** PR (`release/vX.Y.Z` → `main`). Work
   merged to `develop` after the version bump waits for the next release.
3. Merge that promote PR with a **merge commit** (branch rules on `main` allow
   merge only; `develop` stays squash-only). Tagging (`vX.Y.Z`), GHCR image
   publish (`latest`), and the GitHub Release follow from `main` / tag workflows.
   Product tagging requires the `RELEASE_BOT_TOKEN` repository secret.

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
