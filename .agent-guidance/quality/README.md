---
title: Agent Guidance Quality Index
status: active
last_reviewed: 2026-05-06
owner: engineering
summary: Entry point for generated agent-guidance quality signals such as the knowledge garden report and scorecard.
---

# Agent Guidance Quality

This section holds generated internal agent-guidance quality signals for the repository.

## Current Reports

- [Latest Knowledge Garden Report](./latest-garden-report.md) — Staleness, orphaning, and deprecation hygiene.
- [Latest Knowledge Scorecard](./latest-scorecard.md) — Weighted bootstrap and maintenance score for the internal agent-guidance tree.

## Generation

Use the repo-level wrappers when refreshing these reports:

- `pnpm knowledge:check`
- `pnpm knowledge:garden`
- `pnpm knowledge:scorecard`
