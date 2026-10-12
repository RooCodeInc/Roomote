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
- 05:35 final worker image check passes (9m24s). B1 is ready for human review: open/non-draft/mergeable, all checks green, exact-head review clean with no unresolved threads. Cross-linked with B2. No merge/approval/deploy performed. Disposable proof database dropped and absence confirmed; temporary probe removed.
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

### B2 delivery checkpoint — 05:40 UTC

- [PR #3461](https://github.com/RooCodeInc/Roomote/pull/3461), branch `fix/required-snapshot-setup-27e7ankfza687`, exact head `44b6fd804619990bd9504ed65f730e6fe287b922`; pushed and draft pending CI/automated review. Cross-linked with #3459.
- Existing policy now reaches the executor. Required errors propagate; their output/exit receipt is recorded before failed status finalization. No lower shared executor mutation. Ordinary/resume and optional-command behavior retained.
- Four actual subprocess cases pass at exact head: required exit 23 skips dependent marker and persists failed/pending command states plus exit/log; healthy setup completes; ordinary continuation and optional failure each complete with warnings and marker. 57 affected setup/status/command tests and normal full pre-push gates pass. Child processes terminate; per-test temporary workspaces are cleaned.
- Browser proof not applicable, no images/judge. Proof exercises actual wrapper, manager, executor and filesystem persistence. Hosted snapshots and tenant task-run finalization remain outside this boundary.
- Initial forwarding-only check exposed missing exit receipt because the executor throws before onResult; catch now records the receipt. Reverified affected paths. No unrelated checks altered.
- 05:44 B2 is ready for human review: all hosted checks green including both image builds; exact-head automated summary clean (zero findings), no review threads; open/non-draft/mergeable. No remaining admitted implementation or repair obligation at this checkpoint.

## Additional intake evidence — 05:40 UTC

- Current-develop CI/release/image-publish runs and installer health pass. No default-branch CI failure admitted.
- Prior provider support investigation distinguishes expected inactive-repository retention from the reported raw count; no delete-migration proposed. Missing original model-upgrade stack/settings prevents a current reproduction.
- Recent monitoring incident lookup empty. Telemetry source listing/field catalog works, but advertised query-help resources are unavailable through task tools; platform defect reported privately, bounded telemetry-query discovery degraded. Other source investigation continues.
- A1 #3460 is review/CI clean; A2 owns task-model settings recovery in web and one docs troubleshooting row. B remains independent.

Next: reconcile B2 exact-head review/checks, repair actual findings, confirm readiness; continue materially distinct operator/runtime discovery until the exact cutoff. At cutoff stop intake and complete admitted obligations. Parent retains confirmed recurring reconciliation coverage.

## Intake checkpoint — 05:51 UTC

- Both B PRs remain at their proven ready heads; public sibling links and all proof limits are preserved.
- Fresh analytics record inspection revalidated the remembered cancellation lead. Recent canceled records lack error codes/cancellation-reason/task correlation and span older releases; no current-develop regression established. Recent failed snapshot records are on older releases with already-fixed producer/default behavior. Older self-hosted address-pool failures are classified; current owned-network destroy path exists, with no present leak reproduction or authorized affected-instance evidence.
- Bounded issue-tracker snapshot lookup returned no visible issues but an incomplete-page flag without continuation token; do not claim exhaustive absence.
- Further evidence-led leads currently require unavailable original upgrade data, affected old-instance state, unavailable telemetry-query helper, or acknowledged handoff from active owners. No speculative third implementation admitted. Intake remains open; retain recurring reconciliation and recheck new events/current ownership at the next bounded interval. Completed PRs do not end the intake window.

## Intake checkpoint — 06:01 UTC

- UTC rechecked at 06:01:40Z on interval resume. Current develop still `50a58ed4`; both B heads unchanged/open/non-draft/mergeable. No superseding merge or new runtime owner conflict.
- New A2 #3462 is task-model settings recovery; separate web/docs files. No B expansion or branch adoption.
- New-support intake since 05:50 returns no new visible issues; historical issue updates not exhaustively covered by this created-time reader. Latest task/PR chronology supplies no new independent runtime failure candidate.
- Existing evidence prerequisites remain unavailable/owner-held; no new implementation admitted. Continue bounded intake/reconciliation at the next confirmed interval, preserving readiness and proof limits. No workstream/occurrence completion claimed before cutoff.

## Intake correction / active routes — 06:14–06:19 UTC

- Two earlier bounded waits until 06:01 and 06:11 were not active intake; they are an explicit coverage gap. Requester corrected the approach. No further sleep/wake waits or idle polling. PR readiness is unaffected; do not infer continuous discovery coverage from prior interval entries.
- Prepared API/BullMQ/controller/Redis/local artifact services are online. A disposable, separately scoped local Docker daemon was started using existing binaries and an isolated data root/socket; initial boolean argument syntax error was corrected. Daemon then reported Docker 29.1.3 with VFS, but network creation failed `operation not permitted` and even a no-network container failed layer registration (`unshare: operation not permitted`). Owned daemon stopped; no containers or daemon children remain. Real container/provider cancellation proof is kernel-blocked, not CLI-blocked.
- Continuing distinct real-process/Postgres queue/controller-boundary routes: terminal-exit classification, actual cancellation cleanup, and persisted command-level receipts. No real provider/customer messages.
- Exit/source investigation: explicit snapshot enqueue records request events but no snapshotRequestedAt field; controller exit classifier reads that field. The current runtime audit's misleading snapshot exit receipts warrant controlled event-order reproduction. This is a lead, not an admitted cause or fix yet.
- A3 owns artifact CSV/TSV keyboard panning in viewer/client test/docs only; no B file overlap. Both shipped B exact heads remain untouched.
