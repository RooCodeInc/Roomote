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
- Update `.agent-guidance/` when changing architecture, workflows, APIs,
  operations, or durable product behavior.

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
