---
title: Testing Strategy
status: active
last_reviewed: 2026-07-10
owner: engineering
summary: Prioritize high-signal tests, choose the right validation layer, and run Roomote's Vitest, Promptfoo, and browser verification without wasting coverage on low-value cases.
---

# Testing Strategy

Roomote should optimize for signal, not test count. The goal is to prove the highest-risk behavior with the right set of tests that meaningfully reduces regression risk.

In this repo, the most important regressions are usually:

- authorization and org/user scoping
- persistence, idempotency, and deduplication
- queue, snapshot, and resume state transitions
- provider, webhook, and API contracts
- deterministic prompt contracts that downstream automation depends on
- user-visible UI flows and failure states

Treat `pnpm test` as the repo-wide execution command, not the definition of what is worth testing.

## Pick the Right Layer First

Before writing a test, decide which question you are trying to answer.

| If you need to prove...                                                                        | Prefer...                                                                              | Avoid...                                                                                            |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| SQL behavior, authorization scoping, persistence, transactions, dedupe, or idempotency         | A real database-backed integration test with factories                                 | Mocking `@roomote/db/server` or rebuilding Drizzle chains in mocks                                  |
| HTTP, adapter, queue, or orchestration contracts where persistence is not the thing under test | A contract or request-flow test with targeted mocks at the collaborator boundary       | Pulling in the full DB stack when the DB is just plumbing, or asserting only that mocks were called |
| Deterministic prompt assembly rules                                                            | Narrow prompt-builder unit tests that assert only load-bearing slots and helper output | Snapshotting or locking long incidental prose                                                       |
| Actual model behavior                                                                          | Promptfoo or other model-in-the-loop evals                                             | Assuming string assembly tests prove the model will behave correctly                                |
| Local component or hook state transitions                                                      | A jsdom component or hook test                                                         | Treating jsdom as proof of real browser behavior                                                    |
| A user-visible flow in the product                                                             | Browser verification against the preview environment                                   | Relying only on unit or jsdom tests for UI regressions                                              |

## Priorities

1. Test the load-bearing seam, not the easiest function to call.
2. Prefer one regression test that proves the contract over several tests that restate implementation details.
3. Add coverage at multiple layers only when each layer proves a different risk.
4. Spend most effort on failure modes, boundaries, and irreversible side effects.
5. If a test fails with a vague diff, it is probably asserting the wrong thing.

## High-Signal Test Cases

Prefer cases like these:

- authorization boundaries across users, tasks, environments, and deployment-wide state
- idempotency, deduplication, and retry safety
- failure handling, rollback, and partial-success behavior
- enqueued jobs, emitted notifications, persisted artifacts, and state transitions
- public response contracts: headers, payload shape, required fields, and adapter interfaces
- prompt slots or helper output that downstream systems actually depend on
- the single browser flow that proves a UI change really works for a user

## Low-Signal Patterns To Avoid

Avoid adding tests that mostly prove the test harness is wired up:

- `toBeDefined()` or `toBeTruthy()` as the only meaningful assertion
- `status === 200` without checking the body, headers, or side effects that matter
- locking exact prose when the wording itself is not the contract
- broad snapshots of long configs, prompt paragraphs, or payloads
- jsdom tests for minor visual-only tweaks whose main assertion is an exact Tailwind class or token swap after a small readability or polish change
- mocking Drizzle or `@roomote/db/server` in tests that claim to prove SQL or auth semantics
- repeating the same branch at unit, integration, and UI layers when no new risk is covered
- `describe.skip` or `it.skip` placeholders with no concrete removal plan

A `toBeDefined()` assertion is still fine as a secondary guard when the primary assertion proves something real.

## Database-Backed Integration Tests

Use the real PostgreSQL test database when the behavior under test depends on:

- query predicates and joins
- org or user scoping
- transactions or constraint enforcement
- persistence after mutations
- idempotency or dedupe across existing rows

For these tests:

- Use factories from `@roomote/db/server` when a factory exists.
- Verify database state after mutations, not just return values.
- Keep test setup close to the contract you are proving.
- Do not mock the DB layer just to avoid writing the integration test you actually need.

Good fits in the current repo include:

- [`apps/web/src/trpc/commands/tasks/__tests__/list.test.ts`](../../apps/web/src/trpc/commands/tasks/__tests__/list.test.ts)
- [`apps/api/src/handlers/github/__tests__/recordWebhook.test.ts`](../../apps/api/src/handlers/github/__tests__/recordWebhook.test.ts)

## Contract And Orchestration Tests

Use a narrower contract or orchestration test when the risk is in control flow or output shape rather than SQL semantics. Good fits include:

- request or response shaping
- queueing and branching behavior
- outbound payload formatting
- adapter interfaces and capability contracts
- fallback behavior when collaborators fail

At this layer it is acceptable to mock DB-facing collaborators if persistence itself is not the contract. The important guardrail is scope:

- Mock the collaborator boundary, not the semantics you should be proving with a real integration test.
- Do not hand-build fake Drizzle chains to "prove" auth filtering or persistence behavior.
- Assert the externally visible contract or side effect, not just that an internal helper was called.

Good fits in the current repo include:

- [`packages/compute-providers/src/__tests__/adapters.contract.test.ts`](../../packages/compute-providers/src/__tests__/adapters.contract.test.ts)
- [`apps/preview-proxy/src/__tests__/integration.test.ts`](../../apps/preview-proxy/src/__tests__/integration.test.ts)
- [`packages/sdk/src/server/routers/mcp-connections.test.ts`](../../packages/sdk/src/server/routers/mcp-connections.test.ts)
- [`packages/slack/src/__tests__/start-auto-routed-slack-task.test.ts`](../../packages/slack/src/__tests__/start-auto-routed-slack-task.test.ts)

## Deterministic Prompt Builder Tests

Roomote has workflow prompt builders in `packages/cloud-agents/src/server/workflows/*.ts` such as `standardTask()` and the GitHub review and fixer builders. These functions assemble prompt text from typed inputs; they do not call an LLM directly. Some of those builders mainly delegate downstream behavior to packaged skills, so the test target should be the deterministic owner that still carries a real contract.

When a prompt change is supposed to refine existing behavior, first update the existing slot, helper, or rule that already owns that behavior instead of appending another prompt paragraph. Prompt accretion makes the runtime harder to reason about and pushes tests toward low-signal prose locking. Only add a new prompt block when the behavior is genuinely new and has no clean home in the current layering model described in [`.agent-guidance/architecture/agent-context.md`](../architecture/agent-context.md#prompt-editing-policy).

Use unit tests here to lock down load-bearing contracts such as:

- prompt vs instructions separation
- resolved `draft`, `create`, or `push` action propagation into every required slot
- Interactive mode, Autonomous mode, and explicit slash-command safety rules
- required tool or live-plan contract text that downstream systems depend on
- helper interpolation such as attribution and workspace placeholders

Do not keep workflow-level tests whose main effect is to freeze prose that is now owned by a packaged skill. When a workflow mostly delegates to a skill such as [`capture-visual-proof`](../../packages/cloud-agents/src/server/workflows/skills/standard/capture-visual-proof/SKILL.md), prefer:

- testing the deterministic builder slots that still matter in the wrapper
- testing helper functions directly when they own formatting or interpolation
- relying on package typecheck, lint, and targeted evals when the remaining question is model behavior or skill-following behavior rather than string assembly

Avoid broad exact-prose assertions when the wording itself is not the contract. When a regression came from one specific slot, assert that slot directly instead of snapshotting surrounding prose.

If a workflow mostly delegates behavior to packaged skills, test the smallest remaining helper or prompt slot that still owns the deterministic contract, then keep the workflow-level test focused on the integration points that matter.

Good fits in the current repo include:

- [`packages/cloud-agents/src/server/workflows/__tests__/standardTaskTaskLaunchPolicy.test.ts`](../../packages/cloud-agents/src/server/workflows/__tests__/standardTaskTaskLaunchPolicy.test.ts)
- [`packages/cloud-agents/src/server/workflows/__tests__/requestUserInputGuidance.test.ts`](../../packages/cloud-agents/src/server/workflows/__tests__/requestUserInputGuidance.test.ts)

## Model-in-the-Loop Prompt Evaluation

Prompt-builder unit tests prove deterministic assembly, not whether a model will actually follow the prompt well. Use model-in-the-loop evals when the question is about LLM behavior rather than string construction:

- routing, classification, ranking, or interpretation decisions made by a model
- prompt changes meant to improve model behavior, not preserve a deterministic contract
- cases where the same assembled prompt could be interpreted differently by different models or model versions

Roomote already uses Promptfoo for the LLM router in `packages/cloud-agents/evals/router/`; see [`.agent-guidance/architecture/llm-routing.md`](../architecture/llm-routing.md#routing-evaluation). For `standardTask()` and other workflow builders, add a similar eval path only when confidence about real model behavior matters beyond contract-level unit coverage.

## Client Tests And Browser Verification

Use jsdom tests for component and hook logic that can be proven locally:

- optimistic UI state
- conditional rendering
- event handling inside a component boundary
- cache update or rollback behavior in hooks

Do not treat jsdom as proof for:

- preview-auth flows
- nested preview routing
- browser-only APIs or focus behavior that jsdom only approximates
- layout or interaction issues that need a real browser

For UI-visible changes, verify the affected flow in a browser against the live browser or browser surface provided by the environment when practical. Use raw preview/service URLs only when the task specifically needs an internal service route.

For small UI polish changes, prefer browser verification or delegated visual proof over new component tests unless behavior, accessibility semantics, or state transitions changed.

## Test Environment And Infrastructure

Roomote uses **Vitest** with `globals: true` across workspaces.

### Server Tests

Server-side tests run in Node.js. Today, only `apps/web` and `packages/sdk` use a package-local `vitest.setup.server.ts` global setup that truncates all tables in the test database before the suite starts and again on teardown so stale rows do not block later `db:push:test` runs.

Examples:

- [`apps/web/vitest.config.ts`](../../apps/web/vitest.config.ts)
- [`apps/web/vitest.setup.server.ts`](../../apps/web/vitest.setup.server.ts)
- [`packages/sdk/vitest.config.ts`](../../packages/sdk/vitest.config.ts)
- [`packages/sdk/vitest.setup.server.ts`](../../packages/sdk/vitest.setup.server.ts)

### Client Tests

Client-side tests run in jsdom and usually load browser API mocks from setup files such as [`apps/web/vitest.setup.client.ts`](../../apps/web/vitest.setup.client.ts).

### Test Database

PostgreSQL runs in Docker Compose with both `development` and `test` databases in the same instance. Server-side targeted runs should load `.env.test` so `DATABASE_URL` and other test-only environment variables are present.

## Running Targeted Tests With Database Access

Always inject `.env.test` for package-scoped test runs. When this repo is using
`mise`, treat the repo-managed toolchain as the default for `node`, `npm`,
`pnpm`, `uv`, and similar commands. Run the command normally first, then fall
back to `mise exec -- <command>` only if the tool is missing or resolves to the
wrong version:

```bash
# Preferred
pnpm exec dotenvx run -f .env.test -- pnpm --filter @roomote/worker exec vitest run src/.../file.test.ts

# If pnpm is unavailable in PATH or resolves to the wrong version
mise exec -- pnpm exec dotenvx run -f .env.test -- pnpm --filter @roomote/worker exec vitest run src/.../file.test.ts
```

Avoid:

- `pnpm --filter <pkg> exec vitest run ...` without dotenvx when the suite needs `DATABASE_URL`
- `pnpm test <path>` at repo root for targeted runs
- passing file paths to `turbo test`

## OpenCode Server Harness Debugging

For `opencode-server`, validate the actual worker and sandbox-server paths that
run in production.

For Roomote runtime envelope, sandbox-server, or harness changes:

- start with the smallest targeted package tests for the worker or
  sandbox-server surface you changed
- inspect `/tmp/harness.log`, worker logs, and `[opencode-server]` startup logs
  from a real worker run when you need raw lifecycle or transport detail
- check the generated `~/.config/opencode/opencode.json` inside the task home
  when debugging model, instruction, or MCP configuration
- exercise the actual caller under test when the bug might be above the harness
  layer instead of assuming a lower-level harness probe proves the full flow

## Running Validation

```bash
# Full test suite
pnpm test

# Full static analysis (`pnpm lint` includes `pnpm format:check`)
pnpm lint && pnpm check-types

# Matches the pre-push hook
pnpm lint:fast
pnpm check-types:fast
pnpm knip

# Full repo validation
pnpm check
```

`pnpm test` first runs `@roomote/db db:push:test` and then executes workspace test suites via Turbo.

Choose the command set that proves the change, but say clearly what you ran and what you did not run.

## Docs-Only CI

The main CI workflow detects docs-only changes before starting package validation jobs. Changes are treated as docs-only when every changed path is under `apps/docs/` or `.agent-guidance/`, or the changed file ends in `.md` or `.mdx`. In that case CI skips lint, Knip, typecheck, tests, and the Docker build because those jobs validate runtime code and package wiring rather than documentation content.

The GHCR publish workflow also skips docs-only pushes to `develop`, so documentation edits do not build or publish images. Manual `workflow_dispatch` runs and `v*` release tag pushes still execute normally.

## Change Review Checks

Before you stop at a passing test or lint run, do one quick repo-shape review for the kinds of changes that tend to leave adjacent callsites behind:

- After changing any tool registration, env variable read, or handler branch, run a targeted `rg` search through the same file and closely related files for sibling callsites with the same shape. Confirm each one is either updated in the same change or explicitly left out of scope, and note that decision in the PR description.
- When changing a named constant, run `rg -n "<CONSTANT_NAME>" .` across the monorepo and confirm every consumer still matches the new value. If any consumer is intentionally left unchanged, explain why in the PR description.

When a code change adds a new module import to a file that already has tests,
check whether those tests fully mock that dependency with `vi.mock(...)` or an
equivalent module-level mock factory. If they do, add any newly used exports to
the mock factory in the same change and run the affected targeted Vitest files
before pushing. This catches the common failure mode where production code starts
importing a new helper from an already-mocked module and the existing test suite
breaks only after the PR is opened.

## Factories And Key Paths

Factories live under [`packages/db/src/fixtures/factories/`](../../packages/db/src/fixtures/factories/) and are exported from `@roomote/db/server`.

Useful references:

- [`apps/*/vitest.config.ts`](../../apps)
- [`packages/*/vitest.config.ts`](../../packages)
- [`packages/cloud-agents/evals/router/`](../../packages/cloud-agents/evals/router/)
- [`packages/db/src/fixtures/factories/index.ts`](../../packages/db/src/fixtures/factories/index.ts)
- [`package.json`](../../package.json)

## Related Documentation

- [Database Architecture](../architecture/database.md)
- [LLM Routing](../architecture/llm-routing.md)
- [Environment Management](../features/environment-management.md)
- [Monorepo Structure](../architecture/monorepo-structure.md)
