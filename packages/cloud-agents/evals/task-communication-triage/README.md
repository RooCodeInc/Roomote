# Task communication triage eval

Calibration fixtures for Session task-communication triage
(`src/server/fast-agent/fast-agent-task-communication-triage.ts`). Each fixture
is a triage state plus the outcome a person would want: `reaches_session`,
`quiet`, or `either`.

`fixtures.json` is a synthetic set about a fictional app, one or more cases
per scenario: routine progress, a confirmed finding, a wrong premise, an
unrequested judgment call, a constraint workaround, drift from a stated
constraint, a blocking question, the task's own result, a repeat of what the
user already heard, and milestones with the requester present or away.

```bash
pnpm --filter @roomote/cloud-agents task-communication-triage:eval
```

To calibrate against real work, export recent delegated tasks from a local
deployment, label each fixture's `expected`, and score the export:

```bash
pnpm --filter @roomote/cloud-agents task-communication-triage:eval \
  --export-runs 480-500 --out evals/task-communication-triage/runs.local.json
pnpm --filter @roomote/cloud-agents task-communication-triage:eval \
  --fixtures evals/task-communication-triage/runs.local.json
```

Exports contain real task and repository content, so they must stay in
gitignored `*.local.json` files. Add a synthetic case here instead when a real
export reveals a new pattern worth keeping.

Both commands need the local database and a judgment model key in the
environment (for example, run them under `dotenvx run -f ../../.env.local --`).
