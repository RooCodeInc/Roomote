# Initial calibration results

This suite exposes real gaps; it does not certify that the current rules catch
all violations. No production rule text or thresholds were changed.

## Setup

- 47 labeled examples, three repetitions each: 141 checks at current thresholds.
- Existing Roomote inference adapter and local model configuration; no verdict cache.
- Full Judgement checks, including context expansion, two concurrent fixtures and a three-second deadline.
- Judgement calibration implementation: `8c54991817bc42106c505721c007c1aa645206e7`.
- Policy SHA-256: `28e10de1f28460924c471d8abd03337ae1b47083edb5679fed129ab5884c07ba`.
- The runner returned exit 1 because incomplete results do not satisfy the expected labels.
- No operational failures or confidently incorrect passes were observed.

## Current thresholds

Each numerator/denominator counts runs, not unique examples. “Valid passes” means
a complete checker pass; the incomplete columns show the remaining cases.

| Rule        | Threshold | Violations caught | False blocks | Valid passes | Incomplete violations | Incomplete valid | Mean check ms |
| ----------- | --------: | ----------------: | -----------: | -----------: | --------------------: | ---------------: | ------------: |
| criterion_1 |      0.96 |        Not tested |         0/18 |        12/18 |                     0 |                6 |           763 |
| criterion_2 |      0.95 |               3/6 |         0/12 |         0/12 |                     3 |               12 |           587 |
| criterion_3 |      0.95 |               7/9 |          0/9 |          9/9 |                     2 |                0 |           419 |
| criterion_4 |      0.94 |               6/6 |         0/12 |         6/12 |                     0 |                6 |           357 |
| criterion_5 |      0.97 |               3/6 |         0/12 |         3/12 |                     3 |                9 |           518 |
| criterion_6 |      0.95 |               6/6 |         0/12 |         9/12 |                     0 |                3 |           438 |
| criterion_7 |      0.85 |               9/9 |         0/24 |        15/24 |                     0 |                9 |           418 |

Overall: **34/42 violating runs blocked, 0/99 valid runs falsely blocked,
54/99 valid runs fully passed, and 53 checks incomplete**. Those incomplete
checks comprise eight violations and 45 valid changes. The hook permits incomplete
checks; a strict check rejects them. Neither outcome is equivalent to a correct
classification. Timing includes Git setup within each check and context expansion,
but excludes disposable-fixture preparation; it is not whole-commit latency.

A preceding run on the same examples caught 33/42 violations and passed 55/99
valid runs. This variation is another reason to repeat evaluation and avoid
treating an exact confidence value as a guarantee.

## What needs work

- **Privacy:** no real private data was used. There are no positive secret cases,
  so detection recall is untested. Public config and environment-managed credential
  lookup were valid but incomplete at 0.96.
- **Worker environments:** spreading all launcher variables was blocked. Explicitly
  forwarding worker authentication remained incomplete, as did all valid exceptions.
- **API errors:** raw messages and stacks were blocked. Returning the whole exception
  object was inconsistent at 0.95.
- **Agent setup prose:** both violations were blocked. Allowed internal tool schemas
  and trusted UI descriptions remained incomplete.
- **Async operations:** serial independent queries were blocked. Moving a read before
  an unrelated early return was missed, with low-confidence `pass` answers. Dependent
  queries, transactions and explicit rate limits also remained incomplete. Lowering
  a threshold cannot repair a wrong outcome; test clearer or narrower rules.
- **UI copy:** both violations were blocked. Necessary permission consequences remained
  incomplete despite being allowed.
- **Capitalization:** all three violating examples were blocked. Title-case headings
  and unrelated edits near unchanged violations remained incomplete; code identifiers
  and sentence-start cases can vary between complete and incomplete.

## Candidate threshold comparisons

Each candidate was tested with three repetitions per example through the same full
checker. These are tuning results on the original examples, not held-out validation.

| Rule        | Candidate | Violations caught | False blocks | Valid passes | Incomplete valid |
| ----------- | --------: | ----------------: | -----------: | -----------: | ---------------: |
| criterion_2 |      0.80 |               6/6 |         0/12 |        12/12 |                0 |
| criterion_2 |      0.85 |               6/6 |         0/12 |        10/12 |                2 |
| criterion_2 |      0.90 |               6/6 |         0/12 |         5/12 |                7 |
| criterion_3 |      0.80 |               9/9 |          0/9 |          9/9 |                0 |
| criterion_3 |      0.85 |               9/9 |          0/9 |          9/9 |                0 |
| criterion_3 |      0.90 |               9/9 |          0/9 |          9/9 |                0 |

The harness selected **0.80 for worker environments** and **0.90 for API errors**.
Those candidates caught every labeled violation with complete passes for every
valid run in their respective sweeps. All 108 sweep checks completed without
operational failures. They are candidates for a separate policy change after
adding held-out examples, especially close allowed exceptions.

The worker sweep exited 1 because its other candidates still had incomplete
valid runs. The API-error sweep exited 0 because every candidate matched every
expected result. The threshold recommendation and suite exit code answer different
questions.

## Reproduce and extend

Use the commands in [README.md](README.md). Reports include per-run answers and
confidence values plus hashes of the exact policy and fixture input. Keep reports
under the ignored `results/` directory. Add independently labeled held-out cases
before selecting new thresholds, then rerun after rule, prompt, model, or backend
changes. Small examples cannot establish coverage for large commits or missing
supporting context; add representative cases for those separately.
