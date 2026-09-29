# Roomote rule calibration

These are labeled changes for each of the seven repository rules. Labels describe
what the rule requires, not what the model happened to answer. Keep cases that
fail: they are regression examples, not reasons to change the expected label.

| ID            | Rule                           | Examples |
| ------------- | ------------------------------ | -------: |
| `criterion_1` | Secrets and private data       |        6 |
| `criterion_2` | Worker subprocess environments |        6 |
| `criterion_3` | Sanitized API errors           |        6 |
| `criterion_4` | Agent setup prose              |        6 |
| `criterion_5` | Independent async operations   |        6 |
| `criterion_6` | UI and setup copy              |        6 |
| `criterion_7` | Lowercase ordinary nouns       |       11 |

IDs currently follow the order in `JUDGE.json`. Preserve those IDs explicitly if
reordering rules, and update examples when changing the intended rule behavior.
The `path` in each example matches the real rule's file globs. Before/after strings
are synthetic source files; they are judged as diffs and are never executed.

## Run locally

Roomote currently pins Judgement 0.1.5, which predates the calibration API. Use a
local checkout of [Judgement's calibration branch](https://github.com/RooCodeInc/judgement/pull/1)
until the new package is released and Roomote upgrades. Install that checkout's
dependencies first. From the Roomote root:

```sh
# Validate the fixtures and plan checks without inference.
pnpm exec tsx .judgement/run-calibration.mjs \
  --judgement-source ../judgement --dry-run --repeats 1

# Run all rules at their configured thresholds, three times per example.
pnpm exec dotenvx run --quiet -f .env.local -- \
  pnpm exec tsx .judgement/run-calibration.mjs \
  --judgement-source ../judgement --output .judgement/results/current.json

# Compare thresholds for one rule.
pnpm exec dotenvx run --quiet -f .env.local -- \
  pnpm exec tsx .judgement/run-calibration.mjs \
  --judgement-source ../judgement --rule criterion_2 \
  --thresholds 0.8,0.85,0.9 --output .judgement/results/worker-sweep.json
```

Replace `../judgement` with the checkout path. Once the installed package exports
`calibrate`, that flag can be omitted. The runner uses Roomote's existing inference
adapter, model settings, and server credentials. Live runs make paid inference
requests. They run only when explicitly invoked, never during a commit hook.

The runner copies the working-tree `JUDGE.json` into a disposable
`.judgement/rules.json` for the new harness. This is a temporary bridge for
Roomote's pinned hook; it does not add legacy lookup to Judgement. Migrate the real
policy and remove this copy step when upgrading Roomote to the new package.
Neither calibration nor threshold comparisons modify the real policy or index.

Checks use two concurrent fixtures, a three-second deadline, and no verdict cache.
Each example can make more than one model request if context needs expanding.
Use `--repeats <n>` to change repetitions and `--examples-dir <dir>` to run a separate
held-out set. Save tuning and held-out sets separately; the current set is a small
initial calibration suite, not independent proof of generalization.

Output includes each score and context expansion, plus caught violations, false
blocks, complete valid passes, incomplete results, and timing. Optional JSON output
includes policy and fixture hashes. `results/` is ignored by Git.

Exit codes:

- `0`: every observed result matches its label, or a dry run finished.
- `1`: at least one result is wrong or incomplete, or inference failed.
- `2`: setup, input, or configuration failed.
- `130`: interrupted.

For a sweep, exit `0` requires every candidate's results to match, even when the
harness recommends one of the candidates. Inspect the table before adopting a
threshold. A recommendation can still leave valid examples incomplete.

## Coverage limits

The privacy rule explicitly allows synthetic credentials and fictional identities.
Its fixtures are therefore **all valid**. Do not relabel a placeholder as a secret
violation just to get a positive test, and never add real credentials or private
data as fixtures. These examples measure false alarms only; they do not establish
secret-detection recall or justify a new privacy threshold.

The other rules include violations, allowed exceptions, and fixes to existing
violations. Rule 7 also checks identifiers, sentence starts, title case, exact UI
labels, and an unrelated edit near an unchanged capitalization violation.

See [the initial results](calibration-results.md) for observed gaps. Incomplete
checks allow hook commits but fail strict checks, so they are not successful
violation detection or complete approval of a valid edit.
