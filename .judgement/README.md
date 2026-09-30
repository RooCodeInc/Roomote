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

## Turn feedback into examples

Capture reads the staged version and previews a fixture without inference:

```sh
pnpm judgement capture --rule criterion_7 --path docs/example.md --name 'ordinary noun' --expected violation
```

Use the actual changed path and the intended label (`pass` for a false positive,
`violation` for a missed violation). Inspect the preview and redact private data.
Repeat with `--output .judgement/examples/new-case.json` to save a new file;
existing files are never overwritten or staged. Test it with
`pnpm judgement test --rule criterion_7 --examples .judgement/examples/new-case.json`,
then merge the reviewed example into that rule's fixture file. Supporting context
is included when the rule requests it; `--context <path>` adds an unchanged file.
Committed changes can be captured with `--base <commit> --head <commit>`.

To compare model, rule, or cutoff changes, save JSON reports before and after on
the same examples, then run:

```sh
pnpm judgement compare --before .judgement/results/before.json --after .judgement/results/after.json
```

Comparison reports improvements and regressions per example, including inference
failures. Both reports must include fixture hashes from the current library.
Use `--before-threshold` and `--after-threshold` to select recorded calibration
cutoffs. A regression exits with code 1. Comparison makes no inference calls.

## Check output and CI

Findings include the observed probability, rule cutoff, and a bounded preview of
changed lines. The preview identifies the packet's edits; it does not claim the
model located the violation on a particular line. Longer checks print progress to
stderr; `--no-progress` disables it. JSON reports remain on stdout.

The standalone library reuses cached judgments for matching packets. Roomote's
custom inference adapter keeps caching disabled because backend settings can
change without a stable cache fingerprint.

The `Judgement` GitHub Actions workflow runs a strict check of the full PR diff.
A job with read-only permissions and no inference secret collects Git objects for
the base and head snapshots. A separate job imports those objects into an empty
repository and runs the pinned checker without checking out PR files. Git hooks,
configuration, and repository history are not transferred. Status publication
runs separately with repository status permission. Violations,
missing inference credentials, timeouts, and incomplete checks fail the status.
The workflow uses a dedicated `TYPESAFE_API_KEY` repository secret and the
`JUDGEMENT_MODEL` repository variable (default `jev-1.13.0`). Keep that model aligned
with calibration; local commands use Roomote's configured model.

After this workflow lands, configure the secret, verify a successful run, and add
`Judgement` as a required status check for protected branches. Until then, the
workflow alone does not enforce a merge gate. Keep the workflow's pinned checker
version aligned with the application dependencies.
