---
title: Slack Behavior Evals
status: active
last_reviewed: 2026-07-08
owner: engineering
summary: Run criterion-based behavior evals against the mock Slack harness and judge captured transcripts with the RooCodeInc/opencode-bench judge panel.
---

# Slack Behavior Evals

Scenario-driven evals for how Roomote behaves on Slack (threading, dedup,
reply quality, channel discipline). Each scenario is a JSON file carrying its
own **authored success criteria**; a runner drives the real local stack
through the mock Slack harness, captures every outbound message, and emits a
bundle that the [RooCodeInc/opencode-bench](https://github.com/RooCodeInc/opencode-bench)
judge panel scores criterion-by-criterion. Results render in that repo's
dashboard alongside code evals.

## Layout

- Runner: [`packages/slack/evals/run-slack-scenario.ts`](../../packages/slack/evals/run-slack-scenario.ts)
- Scenarios: [`packages/slack/evals/scenarios/`](../../packages/slack/evals/scenarios/)
- Mock harness internals: see the `mock-slack-testing` skill and
  `packages/slack/src/mock-slack-server.ts`

## Running

Prerequisites: local dev stack up (`pnpm dev`), `SLACK_API_BASE_URL` in
`.env.local` pointing at the mock port (`http://127.0.0.1:3012/api/`), and the
mock Slack installation/user mapping seeded (see the `mock-slack-testing`
skill — note its SQL snippet is stale; the real `slack_installations` schema
has `bot_access_token` + required `scopes`, and no `organization_id`).

```bash
pnpm --filter @roomote/slack eval:scenario -- \
  --scenario evals/scenarios/slack-fast-answer.json \
  --webhook http://localhost:13101/api/webhooks/slack \
  --target roomote@local-dev --episode 1 --out /tmp/slack-eval-bundles
```

Then judge the bundles from a checkout of `RooCodeInc/opencode-bench`:

```bash
bun run scripts/judge-criteria.ts --input /tmp/slack-eval-bundles --out results/slack-evals.json
```

The `--target` label is the comparison axis (prompt version, branch, model) —
use it to regression-test prompt edits: run the suite before and after a
Slack prompt change and compare columns in the bench dashboard.

## Writing scenarios

- One concrete, independently checkable fact per criterion; judges mark each
  binary satisfied/unsatisfied against the captured artifacts only.
- Use `$E<n>` / `$TS<n>` tokens for event ids and Slack timestamps — the
  runner substitutes run-unique values (same token, same value), so repeated
  episodes never collide on Slack event dedup or thread locks. Reuse the same
  `$E` token across two events to test duplicate delivery.
- Prefer `!fast` flows for cheap scenarios (inline answer, no cloud job).
  Scenarios that need a full cloud job (deleted-thread suppression mid-task,
  completion notifications) also work but take minutes per episode.
- The runner settles when the message log is stable for `settleMs` (with at
  least one bot message) or gives up at `timeoutMs` and judges whatever
  happened.
