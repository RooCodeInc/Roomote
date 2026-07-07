---
name: cleanup-stale-prs
description: "Identify and optionally close stale GitHub pull requests using `gh`, with dry-run support and a configurable exempt label. Use when asked to clean stale PRs, close inactive PRs, or run PR hygiene."
---

# Cleanup Stale PRs

Use this skill for GitHub pull request hygiene. Start with a dry run, review the candidates, and only use `--apply` when the user wants the closures to happen.

## Prerequisites

- `gh` is installed and authenticated for the target repository.
- `python3` is available.
- Prefer the bundled script over ad-hoc shell pipelines.

## Bundled Resource

- `scripts/cleanup_stale_prs.py` lists stale PRs and optionally closes them.

## Default Workflow

Commands below assume the repo root is the current working directory. Invoke the bundled script via its full path under `.agents/skills/cleanup-stale-prs/`.

```bash
python3 ./.agents/skills/cleanup-stale-prs/scripts/cleanup_stale_prs.py --dry-run
```

```bash
python3 ./.agents/skills/cleanup-stale-prs/scripts/cleanup_stale_prs.py \
  --dry-run \
  --repo owner/repo \
  --stale-days 5 \
  --exempt-label do-not-close
```

```bash
python3 ./.agents/skills/cleanup-stale-prs/scripts/cleanup_stale_prs.py \
  --apply \
  --stale-days 3 \
  --exempt-label wip
```

## Behavior

- Uses `gh pr list --json` to inspect open PRs, including titles and PR descriptions.
- Treats a PR as stale when `updatedAt` is older than the cutoff. The default threshold is 7 days.
- Excludes PRs whose labels include the exempt label, case-insensitive.
- In dry-run mode, prints a grouped summary with counts, change-type breakdowns, and detailed candidates grouped by inferred topic.
- Adds a close comment when `--apply` is used.

## Notes

- `updatedAt` can be bumped by bots, comments, or status changes. If that is too noisy, switch to a commit-recency variant.
- Keep dry-run as the default. Do not close PRs unless the user asked for it.
