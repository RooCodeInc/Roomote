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

## B1 — snapshot setup task identity (admitted 05:11 UTC)

1. **Capacity vs obligations:** no other B implementation admitted; one narrow increment can use the existing snapshot tests and actual disposable seed/database command path.
2. **Baseline/claim/ownership/proof:** current source and runtime evidence establish missing sandbox identity. On unchanged develop, the propagation regression fails with stale identity; actual snapshot caller through WorkspaceManager/CommandExecutor/pnpm refuses development seed and leaves users/sessions/task_runs at 0/0/0 in a newly migrated disposable PostgreSQL database. Claimed files: `apps/worker/src/commands/snapshot.ts` and its existing test. Preserve seed production refusal. No web implementation overlap; A informed.
3. **Plan/regression boundary/owner/next action:** B owns adding trusted fetched task identity to snapshot setup, testing propagation and override precedence, and repeating real seed stimulus against a disposable PostgreSQL database. Do not redesign optional-command policy, provider snapshotting, or seed authorization. Next: reconcile exact-head hosted CI and automated review, repair genuine findings and deliver readiness.

## Delivery and proof

- Baseline propagation: one expected failing regression, three existing passes. Baseline actual-command proof: expected refusal and empty durable state verified. Infrastructure provisioning used actual createdb and the checked-in migration runner; initial relative migration-folder invocation failed, corrected package-relative `drizzle` succeeds.
- Implementation: [PR #3459](https://github.com/RooCodeInc/Roomote/pull/3459), branch `fix/snapshot-setup-identity-27e7ankfza687`, exact head `7e2746c21c4f2e48f0379683dee22c18f1505e08`. One runtime env assignment plus two missing/stale-identity test cases. Pushed; draft pending CI/review, not completed.
- 05:23 exact-head replay from fresh migrated PostgreSQL: both real seed commands succeed, yielding 1 user / 4 sessions / 4 runs / 2 uploaded session-owned artifacts, version 1. Repeat preserves counts; actual production `--force` CLI refuses and preserves counts. 88 focused tests, worker typecheck, normal full pre-push oxlint/residual ESLint/fast workspace types/Knip pass. Temporary probe removed.
- Proof boundary: actual snapshot caller and real WorkspaceManager/CommandExecutor/CLI/DB/local object storage; SDK/provider completion, outer setup wrapper and shell injection mocked. Provider-hosted create/restore not exercised. Browser proof not applicable; no images or judge. No real customer messages.
- 05:24 hosted CI and automated review in progress; head matches, mergeable. Human-review merge gate remains; no merge or approval authorized.
- 05:27 automated review finished clean at the exact head (zero findings, no threads); service promoted the PR to non-draft. By 05:30 all checks except the ongoing worker-image build pass. B retains final CI reconciliation.
- Required: identical baseline/head seed stimulus; actual durable demo rows and rerun idempotency; production refusal; focused worker tests, static gates, exact-head CI/review reconciliation.
- Hosted snapshot creation/restore is not yet exercised. Any limit must remain explicit.

## Runnable continuation

Run the existing worker snapshot suite with `pnpm exec dotenvx run -f .env.test -- pnpm --filter @roomote/worker exec vitest run src/commands/__tests__/snapshot.test.ts`, add the propagation regression, then exercise the actual seed CLI against a newly migrated disposable local PostgreSQL database. Recheck active PRs and current develop before implementation publication. Update this ledger at admission, progress and before yielding.

For local command reproduction use a fresh disposable database, actual `createdb`, and `DATABASE_URL=postgresql://postgres@localhost:5432/roomote_shift_b_seed DRIZZLE_MIGRATIONS_FOLDER=drizzle pnpm --filter @roomote/db exec tsx src/run-migrations.ts`. Execute the two seed commands listed in PR #3459 through WorkspaceManager using snapshot setup's env, not the ambient harness env. Inspect `users`, `sessions`, `task_runs`, and `task_artifacts` directly, including uploaded/session ownership/version. Repeat at the pinned head; verify production refusal before dropping the disposable database. The owning task retains the full temporary probe and baseline/head receipts as durable artifacts.

## Independent discovery — continuing intake

- A1 is provider-settings in-place query recovery; files are web settings components/tests, independent of B.
- 05:24 public-sanitized ledger and B1 are the only B branches. Next independent evidence sources: recent operator support, monitoring incidents, current required-command semantics and snapshot scrub receipts. No further admission yet.
- Recent snapshot/provider-default support report is covered by merged #3457; the separate upgrade/model-settings report remains unreproduced. No recent monitoring incidents returned. No admission for broad provider-row deletion or telemetry redesign.

## B2 — honor required snapshot setup commands (admitted 05:31 UTC)

1. **Capacity vs obligations:** B1 is proven, clean-review and non-draft; only its worker-image CI remains passive. B2 is one independent flag-forwarding and truthful-error increment, using isolated subprocess/filesystem resources, no new DB/global state, and a 3-case exact-head proof.
2. **Baseline/claim/ownership/proof:** current develop `50a58ed4` passes `false` from snapshot setup but the repository-command wrapper ignores it and always continues. A real required child process exits 23, its dependent child still creates a marker, and the wrapper resolves with optional warnings. Snapshot readiness can therefore proceed despite a required prerequisite failure. Ordinary/resume and per-command optional continuation already have passing controls. Files: `apps/worker/src/commands/setup/workspace/environment-commands.ts`, new adjacent `__tests__/environment-commands.test.ts`, and one existing `setup/__tests__/workspace.test.ts` expectation. A informed; no web/shared ownership overlap.
3. **Bounded plan/regression boundary/owner/next action:** B forwards the existing policy, preserves ordinary-task and explicitly optional continuation, and ensures required-failure messaging does not claim continuation. Use actual child processes, dependent file existence and persisted `.roomote/setup-status.json`/logs. Preserve existing snapshot failure handling; no schema/provider/readiness-receipt redesign. Next: implement, prove skip/failure persistence, check affected setup/static suites and publish independently.
