# Roomote rule calibration

These are labeled changes for each of the six repository rules. Labels describe
what the rule requires, not what the model happened to answer. Keep cases that
fail: they are regression examples, not reasons to change the expected label.

| ID            | Rule                                    | Examples |
| ------------- | --------------------------------------- | -------: |
| `criterion_2` | Worker credentials crossing into tasks  |        8 |
| `criterion_3` | Sanitized API errors                    |        6 |
| `criterion_4` | Agent setup prose                       |        6 |
| `criterion_6` | UI and setup copy                       |        6 |
| `criterion_7` | Lowercase ordinary nouns                |       11 |
| `criterion_8` | Direct descriptions of current behavior |       10 |

IDs are explicit in `.judgement/rules.json`. Keep them stable when removing or
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

The rules include violations, allowed exceptions, and fixes to existing
violations. Rule 7 also checks identifiers, sentence starts, title case, exact UI
labels, and an unrelated edit near an unchanged capitalization violation. Rule 8
also covers migration guides, release notes, supported choices, and useful security
constraints.

Incomplete checks allow hook commits but fail strict checks. They do not count as
successful violation detection or complete approval of a valid edit.

## Inspect examples in the decision tester

Admins can open **Settings → Models → Test decisions**, choose **Repository
Judgement**, and select a rule, example, and evidence packet.
Click **Load example**, then **Ask**. The state and questions remain editable.
Select three runs to inspect variation; the last ten runs remain available while
the page is open, with their original labels and violation cutoffs.

Expected labels stay outside model input. The model asks whether changed lines
need correction to satisfy the rule and returns the probability of a violation.
A probability at or above the rule's cutoff produces a finding; lower
probabilities produce no finding. A low score does not prove
that the edit is correct. Missing evidence and inference failures can still make
a check incomplete. The tester has a 20-second request timeout compared with the
hook's three-second budget, and a single packet does not establish a full checker
result.

`pnpm judgement:presets` uses Judgement's `prepareExamples` API to bundle synthetic
request inputs for the deployed tester. Run it after changing rules, fixtures,
the preparation script, or the pinned library. No credentials or inference are
needed. `pnpm judgement:presets --check` verifies exact preparation; the focused
`judgement-presets.test.ts` test detects stale source hashes and question drift.
Generated inputs are checked in so the web server does not need Git or a checkout.
Observed scores and calibration reports belong in local output or CI artifacts.

## Choosing cutoffs

Use repeated runs of the labeled examples to compare missed violations and false
blocks. Check a candidate cutoff against additional examples under
`examples/validation/`; the prose rules also have confirmation examples under
`examples/confirmation/`. Preserve failing examples and their intended labels.
If valid and violating scores overlap, improve the rule or evidence before
lowering the cutoff. Recalibrate after changing the rule, model, or question.

```sh
pnpm judgement test --examples-dir .judgement/examples/validation --repeats 5
pnpm judgement test --examples-dir .judgement/examples/confirmation --rule criterion_7 --repeats 5
pnpm judgement test --examples-dir .judgement/examples/confirmation --rule criterion_8 --repeats 5
```

Keep rules focused on contextual requirements and exceptions that are difficult
to express as deterministic checks. General performance advice belongs in code
review. Keep observed calibration scores in local reports or CI artifacts.

Rules 7 and 8 use a violation cutoff of 0.75. Validate the capitalization and prose
rules together with sentence starts, quoted UI labels, headings, migration and
security requirements, and edits near unchanged violations. Difficult examples
remain in the validation fixtures even when their scores fall below the cutoff.
