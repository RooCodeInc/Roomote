---
name: roomote-testing-validation
description: Run the correct Roomote test and validation workflow. Use when changing code in the Roomote repo and you need the right package-scoped Vitest commands, dotenvx usage, real-database test patterns, typecheck/lint pairing, or CI-parity validation instead of guessing from root scripts.
---

# Roomote Testing Validation

Use package-scoped validation by default.

## Start Here

- Read `.agent-guidance/operations/testing.md` for the current testing rules and examples.
- Read `package.json` for repo-level gates such as `pnpm check`.
- Read the package's own `package.json` and `vitest.config.*` before choosing commands.

## Command Selection

- Use `pnpm check` only when you intentionally want the full repo gate.
- Use `pnpm lint:fast`, `pnpm check-types:fast`, and `pnpm knip` when you want to match the pre-push hook.
- Use `pnpm lint` and `pnpm check-types` when you explicitly want formatting-inclusive full static validation. In this repo, `pnpm lint` includes `pnpm format:check` before the Turbo lint run.
- Use package-scoped Vitest for targeted runs.
Preferred targeted pattern:

```bash
pnpm exec dotenvx run -f .env.test -- pnpm --filter <package> exec vitest run path/to/file.test.ts
```

If `pnpm` is unavailable in PATH:

```bash
mise exec -- pnpm exec dotenvx run -f .env.test -- pnpm --filter <package> exec vitest run path/to/file.test.ts
```

## ACP And Harness Debugging

- For changes in `apps/worker/src/sandbox-server`, ACP envelope handling, or
  harness event rendering, start with the smallest targeted automated coverage
  in `@roomote/worker`.

- If you need manual payload inspection beyond that, use the real caller under
  test or add a temporary local-only probe in your branch instead of relying on
  a committed helper that no longer exists.

## Guardrails

- Do not use `pnpm test <path>` at repo root for targeted runs.
- Do not pass test file paths to `turbo test`.
- Pair focused test runs with `pnpm --filter <package> check-types` when the change is local to one package.
- If `pnpm lint` fails because of Prettier, run `pnpm format` and then rerun `pnpm lint` before considering the task done.
- Use `pnpm format:check` directly only when you explicitly need the formatting check in isolation.
- If the change touches Docker/build plumbing, consider the matching Docker build or CI-equivalent step.

## Test Design Rules

- Use the real test database for server-side integration paths where auth, queries, transactions, or persistence semantics matter.
- Use factories from `@roomote/db/server` instead of hand-rolling core records when a factory exists.
- In orchestration or payload-shaping unit tests, mock collaborators at the boundary instead of trying to prove SQL behavior with DB mocks.
- Verify database state after mutations when persistence is part of the contract.
- For minor visual-only UI changes, start with the smallest relevant static checks and visual proof rather than assuming a new jsdom or Vitest test is required.
- Do not add component tests whose main assertion is an exact Tailwind utility, token class, spacing class, or incidental markup shape.
- Add UI automation only when the regression is behavioral: conditional rendering, interaction, accessibility semantics, state transitions, or formatting logic that users depend on.
- Do not add `vitest` global imports where `globals: true` already applies.

## Common Paths

- Web app test guidance: `apps/web/vitest.config.ts`
- API tests: `apps/api/vitest.config.ts`
- DB package scripts and migrations: `packages/db/package.json`
- Factory definitions: `packages/db/src/fixtures/factories/`

## Output Standard

- Choose the smallest command set that proves the change.
- State clearly what you ran and what you did not run.
- If a validation path is blocked by environment setup, say so and give the exact command that should be used once the environment exists.
