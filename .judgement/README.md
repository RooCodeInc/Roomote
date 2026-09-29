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

## Running examples

Use Judgement's shared test and calibration commands once Roomote upgrades to the
release containing them. Roomote currently pins 0.1.5. The command documentation
and implementation belong in [Judgement](https://github.com/RooCodeInc/judgement).
Keep generated reports local; `results/` is ignored by Git.

## Coverage limits

The privacy rule explicitly allows synthetic credentials and fictional identities.
Its fixtures are therefore **all valid**. Do not relabel a placeholder as a secret
violation just to get a positive test, and never add real credentials or private
data as fixtures. These examples measure false alarms only; they do not establish
secret-detection recall or justify a new privacy threshold.

The other rules include violations, allowed exceptions, and fixes to existing
violations. Rule 7 also checks identifiers, sentence starts, title case, exact UI
labels, and an unrelated edit near an unchanged capitalization violation.

Incomplete checks allow hook commits but fail strict checks. They do not count as
successful violation detection or complete approval of a valid edit.
