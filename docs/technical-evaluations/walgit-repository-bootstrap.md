# Walgit for repository bootstrap

- Status: experiment only
- Decision date: 2026-08-25
- Reviewed upstream: [`tobi/walgit@a71c592`](https://github.com/tobi/walgit/tree/a71c592b251306303f43e8dfe48076ee347f825f)

## Decision

Do not adopt walgit as a Roomote source-control provider, primary Git host, or
push path. Consider one isolated A/B experiment using walgit's blobless
`bundle-uri` output as a cold-clone bootstrap accelerator only after production
timings show repository cloning is a material part of setup latency for a
representative large repository.

The upstream provider remains the source of truth, `origin`, credential
authority, fetch target, and push destination. Every treatment clone must
reconcile with the upstream provider before task work begins and fall back to
the current clone path on any accelerator failure.

## Existing work and current path

The open pull request audit found no walgit, bundle-URI, Git mirror, or shared
object-cache implementation. [PR #934](https://github.com/RooCodeInc/Roomote/pull/934)
is adjacent but distinct: it changes timeout/retry behavior for large clones,
not how repository objects are delivered. This evaluation must not absorb or
depend on that branch.

Fresh repository preparation currently:

1. Resolves the provider repository and clone URL in
   [`WorkspaceManager.prepareRepository`](../../apps/worker/src/workspace/workspace-manager.ts).
2. Runs `git clone --filter=blob:none` with four retries and a 300-second
   timeout when no worktree exists.
3. Runs `git fetch --all --tags --prune --force`, resolves `origin/HEAD`, and
   resets/checks out the requested branch and optional SHA.
4. Reuses the worktree only when it already exists in the same sandbox or a
   resumed filesystem snapshot. There is no cross-sandbox Git mirror, bundle
   cache, alternates store, LFS bootstrap, or submodule bootstrap.

Repository clone, fetch, and checkout/reset stages already emit durations via
the worker's setup phase recorder. Multi-repository preparation is capped at
five concurrent repositories in
[`initializeRepositories`](../../apps/worker/src/commands/setup/workspace/repositories.ts).
This makes the worker clone command the narrow experiment seam and avoids a
database, API, provider, or UI change.

## Fit

Walgit is relevant because it serves smart HTTP Git while storing its durable
write-ahead log and immutable packs in S3-compatible storage or GCS. Its local
disks are disposable caches, and its scheduled bundle chains can move clone
bytes through static object storage or a CDN instead of generating the full
response on a Git host. It also has an
[upstream-follow/mirror path](https://github.com/tobi/walgit/blob/a71c592b251306303f43e8dfe48076ee347f825f/crates/walgit-cli/src/mirror.rs)
for repositories whose writes continue elsewhere.

That shape could help repeated cold clones of the same large, active repository
when Roomote sandboxes are created in regions close to the bundle store. It is
not automatically faster: walgit's own
[bundle design measurements](https://github.com/tobi/walgit/blob/a71c592b251306303f43e8dfe48076ee347f825f/docs/BUNDLE_URI_DESIGN.md#7-numbers-to-keep-honest)
show client-side `index-pack` can dominate wall time, and a bundled fetch was
slower than a plain fetch in one warm-origin comparison.

Roomote's clone is blobless. Stock Git must therefore use walgit's explicit
`?filter=blob:none` bundle list. Walgit documents that enabling only
`transfer.bundleURI` can make a blobless clone download the full bundle because
the protocol advertisement cannot select a filtered family. The experiment
must not use that configuration.

## Non-fit

- Repository ingestion metadata and provider discovery do not improve; Roomote
  still needs the existing provider APIs and repository records.
- LFS support, browsing APIs, webhooks, and push policies duplicate provider
  responsibilities and do not shorten the first experiment's critical path.
- Making walgit authoritative would require migration, durability operations,
  backup/restore, provider parity, webhook delivery, and incident ownership.
- Full checkout still needs the current revision's blobs. Bundle acceleration
  cannot remove that cost when a task needs most of a very large worktree.
- Walgit's public repository had no tagged release and only three commits when
  reviewed. Its MIT license permits evaluation, but its operational maturity is
  not yet sufficient for Roomote's source-of-truth path.

## Security and tenancy requirements

Walgit keeps bucket credentials server-side, which is preferable to putting
object-store credentials in sandboxes. Its current auth model, however, resolves
a principal to global `write` and `admin` booleans; the documented static-token
and OIDC configuration does not provide repository-scoped read authorization.
Per-repository push policy protects refs, not repository visibility.

An experiment must therefore use a non-production repository and an isolated
bucket/prefix. A production design would require either a dedicated deployment
and bucket namespace per tenant or a verified repository-aware authorization
layer in front of walgit. It must also provide:

- a read-only, short-lived sandbox credential scoped to one repository
- a host-scoped Git credential helper or credential proxy that supplies the
  walgit bearer token without placing it in a URL, command argument, or log
- separate mirror credentials, held outside the sandbox, for reading upstream
  and writing walgit
- tenant-qualified cache keys and logs with no clone URLs or tokens
- short-lived signed URLs, if enabled, and a tested revocation path
- deletion and cache-purge procedures for rewritten history or exposed secrets
- integrity verification and a clean upstream fallback on stale, missing, or
  corrupt bundles

The treatment must never accept an arbitrary bundle URI from task input. Only a
control-plane allowlisted HTTPS origin may supply bundle lists.

## Incremental experiment

### Entry gate

Use existing setup phase events first. Proceed only if at least one
representative repository has 30 or more fresh-sandbox samples and clone time is
at least 20% of repository preparation p95. Otherwise there is no evidence that
a Git-hosting experiment attacks the current bottleneck.

### Shape

Mirror one non-production repository to an isolated walgit deployment. Enable
the weekly/daily blobless bundle family and keep walgit off every Roomote write
path. Use 30 fresh sandboxes per arm only as a harness pilot. A decision run
needs at least 300 fresh sandboxes per arm in the same region and machine class,
alternating arms to reduce time-of-day bias.

Control:

```sh
git clone --filter=blob:none "$UPSTREAM_URL" "$WORKTREE"
```

Treatment:

```sh
git clone --filter=blob:none \
  --bundle-uri="$WALGIT_REPO_URL/bundles/list?filter=blob:none" \
  -c fetch.bundleURI="$WALGIT_REPO_URL/bundles/catchup?filter=blob:none" \
  "$UPSTREAM_URL" "$WORKTREE"
```

`WALGIT_REPO_URL` is an allowlisted URL ending in `<owner>/<repo>.git`.
Cloning from `UPSTREAM_URL` keeps the provider as `origin`; the bundles only
seed the object database. After either command, run Roomote's existing upstream
fetch, default-branch resolution, checkout/reset, and optional SHA pin without
modification. On any treatment failure, remove the partial directory and run the
control command once.

Provide the read-only walgit bearer through a Git credential helper scoped to
the walgit HTTPS origin. Do not interpolate it into either URL or the command.
Before timing runs, verify that the credential can read the experiment
repository but cannot list or clone a second repository in the same service. If
walgit's native auth cannot enforce that negative case, retain the one-repository
isolated deployment for the benchmark and treat production authorization as an
unmet decision gate.

Capture repository preparation, clone, fetch, checkout/reset, and time-to-usable
worktree durations; bytes served by upstream and walgit; object-store requests
and egress; client CPU and peak RSS; lazy-blob fetch count/latency during one
fixed task; and fallback/failure reason. Report cold and warmed bundle-store
results separately at p50, p95, and worst case, with bootstrap 95% confidence
intervals for each percentile.

### Success criteria

Advance to a production design only if the treatment:

- improves time-to-usable-worktree p50 by at least 30% and p95 by at least 20%
- has a one-sided 95% confidence lower bound of at least 99% for successful
  bootstrap or clean fallback (300 of 300 treatment runs is the minimum)
- adds no more than 10% to p95 latency of the fixed post-clone task
- reduces upstream bytes enough to offset bundle storage, requests, and egress
- passes a forced stale mirror, unavailable walgit, invalid token, corrupt
  bundle, and upstream history-rewrite test
- demonstrates repository-scoped authorization without sandbox bucket
  credentials

Stop if gains require unrealistic warm caches, client `index-pack` erases the
transfer benefit, the mirror must enter the push path, or tenant isolation
requires broad read credentials.

## Recommendation

**No-go for adoption now. Conditional go for the bounded experiment only after
the entry gate is met.** Walgit's architecture is directionally aligned with
disposable sandboxes and very large repositories, but Roomote has not yet shown
that clone transfer is the dominant startup cost, and walgit's filtered-bundle
client caveat, broad authorization model, and early maturity are material risks.

## Sources

- [walgit README at the reviewed commit](https://github.com/tobi/walgit/blob/a71c592b251306303f43e8dfe48076ee347f825f/README.md)
- [walgit bundle-URI design](https://github.com/tobi/walgit/blob/a71c592b251306303f43e8dfe48076ee347f825f/docs/BUNDLE_URI_DESIGN.md)
- [walgit integrity and repair model](https://github.com/tobi/walgit/blob/a71c592b251306303f43e8dfe48076ee347f825f/docs/INTEGRITY.md)
- [Git `clone --bundle-uri` documentation](https://git-scm.com/docs/git-clone#Documentation/git-clone.txt---bundle-uriuri)
- [Git bundle-URI design documentation](https://git-scm.com/docs/bundle-uri)
