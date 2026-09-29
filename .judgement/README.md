# Roomote rule calibration

These are labeled changes for each of the eight repository rules. Labels describe
what the rule requires, not what the model happened to answer. Keep cases that
fail: they are regression examples, not reasons to change the expected label.

| ID            | Rule                                    | Examples |
| ------------- | --------------------------------------- | -------: |
| `criterion_1` | Secrets and private data                |        6 |
| `criterion_2` | Worker subprocess environments          |        6 |
| `criterion_3` | Sanitized API errors                    |        6 |
| `criterion_4` | Agent setup prose                       |        6 |
| `criterion_5` | Independent async operations            |        6 |
| `criterion_6` | UI and setup copy                       |        6 |
| `criterion_7` | Lowercase ordinary nouns                |       11 |
| `criterion_8` | Direct descriptions of current behavior |       10 |

IDs currently follow the order in `.judgement/rules.json`. Preserve those IDs explicitly if
reordering rules, and update examples when changing the intended rule behavior.
The `path` in each example matches the real rule's file globs. Before/after strings
are synthetic source files; they are judged as diffs and are never executed.

## Running examples

Run from the repository root:

```sh
pnpm judgement test --dry-run
pnpm judgement test --rule criterion_8
pnpm judgement calibrate --rule criterion_8 --thresholds 0.8,0.85,0.9
pnpm --silent judgement test --format json > .judgement/results/latest.json
```

Create `.judgement/results/` before redirecting output there. The commands use
Roomote's existing model settings and server credentials through the shared
Judgement library. Keep generated reports local; `results/` is ignored by Git.
See [Judgement's agent guide](https://github.com/RooCodeInc/judgement/blob/main/docs/agents.md)
for rule design, calibration, and interpreting incomplete results.

## Coverage limits

The privacy rule explicitly allows synthetic credentials and fictional identities.
Its fixtures are therefore **all valid**. Do not relabel a placeholder as a secret
violation just to get a positive test, and never add real credentials or private
data as fixtures. These examples measure false alarms only; they do not establish
secret-detection recall or justify a new privacy threshold.

The other rules include violations, allowed exceptions, and fixes to existing
violations. Rule 7 also checks identifiers, sentence starts, title case, exact UI
labels, and an unrelated edit near an unchanged capitalization violation. Rule 8
also covers migration guides, release notes, supported choices, and useful security
constraints.

Incomplete checks allow hook commits but fail strict checks. They do not count as
successful violation detection or complete approval of a valid edit.
