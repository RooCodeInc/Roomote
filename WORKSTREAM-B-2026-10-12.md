# Runtime/reliability workstream — 2026-10-12

This branch is an inspectable execution ledger, not a product-code change or merge proposal. Private operational context remains in the owning session.

## Timing and ownership

- Scheduled start: 2026-10-12T05:00:21.641Z.
- Intake cutoff: 2026-10-12T07:00:21.641Z; discovery continues until then, followed by completion of admitted work.
- Reconciliation cadence: ten minutes; recurring coverage confirmed by the parent session. The parent owns occurrence reconciliation.
- Owner: workstream B (runtime/operator/CI/persistence). Workstream A independently owns web product/UI journeys.
- Baseline: current `develop` at `50a58ed4b042bcb15a70074c84581bec466ec765`, clean at start.

## Discovery checkpoint — 05:08 UTC

- Prior #3398, #3399 and #3400 merged October 5. #3354 merged October 9; its historical automated-review infrastructure failure is no longer an outstanding PR.
- Excluded active owner-held #3287 review identity, #3342 environment mappings, #3389 approval waits, #3392 credentials, #3449 model consent and #3455 bundled OpenCode upgrade; no branches adopted.
- Recent snapshot setup evidence reports demo-seed refusal in development and dependent missing-session artifact seeding. Current source omits task identity in the snapshot setup environment, while ordinary task runtime supplies it.
- Missing image-build backend is environment-specific; command-correlated diagnostics and snapshot receipt redesign require broader contracts. No admissions for those leads.

## B1 — snapshot setup task identity (pre-admission)

1. **Capacity vs obligations:** no other B implementation admitted; one narrow increment can use the existing snapshot tests and actual disposable seed/database command path.
2. **Baseline/claim/ownership/proof:** current source and runtime evidence establish missing sandbox identity; reproduce propagation on unchanged develop before admission. Claimed files: `apps/worker/src/commands/snapshot.ts` and its existing test. Preserve seed production refusal. No web implementation overlap; A informed.
3. **Plan/regression boundary/owner/next action:** B owns adding trusted fetched task identity to snapshot setup, testing propagation and override precedence, and repeating real seed stimulus against a disposable PostgreSQL database. Do not redesign optional-command policy, provider snapshotting, or seed authorization. Next: establish red propagation check and actual seed refusal/empty persistence.

## Delivery and proof

- No implementation head or PR yet. No tests or proof claimed complete.
- Required: identical baseline/head seed stimulus; actual durable demo rows and rerun idempotency; production refusal; focused worker tests, static gates, exact-head CI/review reconciliation.
- Hosted snapshot creation/restore is not yet exercised. Any limit must remain explicit.

## Runnable continuation

Run the existing worker snapshot suite with `pnpm exec dotenvx run -f .env.test -- pnpm --filter @roomote/worker exec vitest run src/commands/__tests__/snapshot.test.ts`, add the propagation regression, then exercise the actual seed CLI against a newly migrated disposable local PostgreSQL database. Recheck active PRs and current develop before implementation publication. Update this ledger at admission, progress and before yielding.
