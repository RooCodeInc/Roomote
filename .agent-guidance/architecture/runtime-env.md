---
title: Runtime Environment Handling
status: active
last_reviewed: 2026-07-06
owner: engineering
summary: Technical documentation of Roomote runtime environment loading covering the shared env schema, the web runtime's dotenvx-backed resolver, and the target Vercel-safe architecture for web-reachable packages.
---

# Runtime Environment Handling

Roomote uses one shared environment schema, but not every runtime can safely
read environment values the same way.

For most long-lived Node services, `process.env` is the source of truth and the
shared `@roomote/env` singleton is sufficient. `apps/web` is different:
preview and Vercel-style web runtimes decrypt dotenvx-managed values at startup
and can continue resolving values through a web-owned runtime resolver after
modules have already been loaded.

This document describes the current split, the target end state, and the
phased migration path to a fully Vercel-safe model for `apps/web`.

## Core Pieces

### Shared env schema

[`packages/env/src/index.ts`](../../packages/env/src/index.ts) owns the Zod
schema for Roomote environment variables via `createRoomoteEnv()`.

It currently exposes three related APIs:

- `createRoomoteEnv(processEnv, resolve?)` - build a validated env object from
  the shared schema
- `Env` - a module-level singleton proxy over `createRoomoteEnv(process.env)`
- `rehydrateEnv()` - rebuild the shared singleton after `process.env` changes

That shared schema is still the right contract for the repository. The
important boundary is that the exported singleton `Env` is not automatically a
safe runtime authority for every host.

The shared schema includes the deployment-level task model runtime controls:
`ROOMOTE_MODEL`, `ROOMOTE_SMALL_MODEL`, `ROOMOTE_VISION_MODEL`,
`ROOMOTE_CODE_REVIEW_MODEL`, `ROOMOTE_EXPLORE_MODEL`,
`ROOMOTE_PLANNING_MODEL`, and the matching per-role
`ROOMOTE_*_REASONING_EFFORT` variables. Persisted model settings and runtime
env overrides are merged later by
[`resolveEffectiveModelRuntimeEnv()`](../../packages/db/src/lib/model-runtime-config.ts),
so feature code should resolve effective model env through that helper before
launching workers instead of reading only the shared `Env` singleton.

The public docs page
[`apps/docs/environment-variables.mdx`](../../apps/docs/environment-variables.mdx)
is the operator-facing inventory of supported deployment env vars. When adding,
renaming, removing, or changing the precedence/meaning of an operator-supported
env var in the shared schema, provider setup catalogs, deployment scripts, or
service-specific monitoring config, update that public table in the same
change. Do not add task-scoped worker internals such as per-task auth tokens or
workspace paths to the public table unless operators are expected to configure
them directly.

For local Roomote development, the schema supplies defaults for the core
runtime surface when `NODE_ENV` is not `production` and `APP_ENV` resolves to
`development`. A blank checkout can therefore boot with local Postgres, Redis,
MinIO artifact storage, web, API, and preview-proxy defaults without encrypted
env files or hosted service credentials. Integration credentials such as Slack,
GitHub, OpenCode provider keys, and Loops are non-blocking at env validation
time; feature code must still fail explicitly when an unconfigured integration
is used. Roomote's shared schema omits hosted Pylon support-chat identity
verification and non-production widget override env keys.

Artifact storage is part of the core runtime surface. Local development uses
`S3_ENDPOINT=http://localhost:19000` and
`S3_PRESIGN_ENDPOINT=http://localhost:19000` for host-local MinIO access; local
Docker workers call the API through `host.docker.internal`, so the API signs
worker-requested artifact URLs with that host rather than mutating signed URLs
after the fact. Compose-based self-hosting sets both endpoints to
`http://minio:9000` because app containers and Docker workers share the Compose
network. Production or hosted-worker deployments must provide an S3-compatible
endpoint and should set `S3_PRESIGN_ENDPOINT` to a URL reachable from whichever
runtime performs artifact uploads or downloads.

`PREVIEW_PROXY_BASE_URL` and `PREVIEW_DOMAINS` are not boot-blocking outside
development: they default to empty strings, live previews are opt-in, and the
env → persisted → default resolution in
[`packages/db/src/lib/preview-runtime-config.ts`](../../packages/db/src/lib/preview-runtime-config.ts)
lets operators configure previews later from **Settings → Live Previews**
without env changes. Consumers must keep tolerating empty values by treating
them as "previews not configured".

### Auto-generated auth keypairs

The base64-encoded P-256 keypairs (`JOB_AUTH_PRIVATE_KEY`/`JOB_AUTH_PUBLIC_KEY`
and `PREVIEW_AUTH_PRIVATE_KEY`/`PREVIEW_AUTH_PUBLIC_KEY`) are required at boot
outside development, but the schema enforces them through
`assertAuthKeypairEnv()` rather than per-field Zod constraints so deployments
can opt out with `ROOMOTE_AUTO_GENERATE_KEYS=true`.

When that flag is set and a keypair is missing from the env,
[`packages/db/src/lib/deployment-auth-keypairs.ts`](../../packages/db/src/lib/deployment-auth-keypairs.ts)
resolves it at boot: it loads the persisted keypair from the
`deployment_secrets` table (encrypted with `ENCRYPTION_KEY`), generates and
persists a new P-256 keypair under a Postgres advisory lock when none exists,
writes the resolved values into `process.env`, and rebuilds the shared `Env`
singleton. Env-provided values always win and are never overwritten, and a
half-configured pair (private without public, in env or in the database) fails
fast instead of guessing.

Every long-lived service calls `bootstrapGeneratedAuthKeypairs()` before its
first token signing or verification: the API in
[`apps/api/src/bootstrap.ts`](../../apps/api/src/bootstrap.ts), the controller
and BullMQ entrypoints before their module-scope startup work, the
preview-proxy before `server.listen`, and the web app inside
[`bootstrapWebRuntimeEnv()`](../../apps/web/src/lib/server/bootstrap-runtime-env.ts)
after DB initialization (followed by `rehydrateWebEnv()` so the web-owned
resolver observes the resolved keys). This flow exists for PaaS-style
deployments (Railway, Render, and similar) that can generate random string
secrets but cannot run the `openssl` provisioning from `deploy/install.sh`.

On fresh multi-service deployments those services boot in parallel with the
api's `db-migrate` pre-deploy step, so `deployment_secrets` may not exist yet.
`bootstrapGeneratedAuthKeypairs()` treats Postgres 42P01 ("relation does not
exist", including when drizzle wraps it in a `DrizzleQueryError` cause chain)
as a pending-migration signal and retries with bounded backoff (~90s total,
one `[auth-keypairs]` waiting-for-migrations log line per retry) before
rethrowing; every other error still fails fast.

Do not extend those defaults to `preview` or `production` as part of local
setup work. `getDefaultRoomoteAppUrl()`, `getDefaultTrpcUrl()`, and
`getDefaultPreviewProxyBaseUrl()` intentionally throw for non-development
app environments. Public web/API/preview URLs for preview, production, or
shared self-hosted deployments must come from operator config, not baked-in
Roomote-owned domains.

Worker and integration callback code follows the same rule. Slack links,
request-user-input links, and worker env builders use
the configured `ROOMOTE_APP_URL`, `TRPC_URL`, and `PREVIEW_PROXY_BASE_URL`
values. Missing or invalid URL config should fail explicitly instead of
falling back to hosted Roomote or Newmote endpoints.

### Secret provider

Secret material for encryption-at-rest, artifact-URL signing, and the ops
dashboard is read through a small `SecretProvider` seam in
[`packages/env/src/secrets.ts`](../../packages/env/src/secrets.ts) rather than
directly off `Env`. Call sites use the typed accessors (`getEncryptionKey()`,
`getArtifactSigningKey()`, `getArtifactSigningKeyPrevious()`,
`getDashboardPassword()`); `setSecretProvider()` swaps the backend once at boot,
so a future KMS/Vault provider can be added without touching call sites. The
interface is synchronous — a remote-backed provider must warm and cache during
boot and serve from memory.

The default `EnvSecretProvider` reads the shared `@roomote/env` singleton, which
is correct for the API/BullMQ/controller processes where `process.env` is the
authority. Because that singleton snapshots `process.env` (see
[Why `apps/web` Is Special](#why-appsweb-is-special)), the web app installs a
web-owned provider via `installWebSecretProvider()` inside
`bootstrapWebRuntimeEnv()`, so request-time secret reads in the web process
resolve through the dotenvx resolver instead of a possibly-stale snapshot.

### Control-plane env var names

`CONTROL_PLANE_ENV_VAR_NAMES` in
[`packages/types/src/control-plane-env-vars.ts`](../../packages/types/src/control-plane-env-vars.ts)
is the single source of truth for env var names that are **control-plane /
provider / instance secrets, never generic user task environment**. Two
consumers derive from it so they cannot drift apart:

- the environment-variables editor
  ([`apps/web/src/trpc/commands/environment-variables/index.ts`](../../apps/web/src/trpc/commands/environment-variables/index.ts))
  reserves these names on create and hides them from the generic list, and
- the job env-injection denylist (`redactControlPlaneEnvVars` in
  [`dequeue-helpers.ts`](../../packages/sdk/src/server/lib/cloud-jobs/dequeue-helpers.ts))
  strips them from the agent sandbox.

The set is assembled from the compute-provider, sign-in-auth, and
source-control-secret catalogs (the last derived from the `secret` fields, minus
the per-repo access tokens a task legitimately needs), plus hand-maintained
sets for bot integrations (Telegram/Teams/Linear) and instance/infra secrets.

**Keep it current when adding a secret.** If the new secret is a field in the
compute, auth, or source-control setup catalog, mark it `secret` and it flows in
automatically. Otherwise (a new bot integration or instance/infra secret) add it
to the corresponding hand-listed set in `control-plane-env-vars.ts`. A missed
entry leaks the secret into task sandboxes and lets operators set it through the
generic editor. Model-provider API keys are intentionally excluded — the agent
harness needs them.

### Web runtime env

[`apps/web/src/lib/server/env.ts`](../../apps/web/src/lib/server/env.ts)
defines the web-owned runtime env accessor. It uses the same shared schema, but
resolves raw values through `dotenvx.get(...)` instead of relying only on the
already-populated contents of `process.env`.

The web startup path in
[`apps/web/src/instrumentation.ts`](../../apps/web/src/instrumentation.ts)
now delegates bootstrap to
[`apps/web/src/lib/server/bootstrap-runtime-env.ts`](../../apps/web/src/lib/server/bootstrap-runtime-env.ts):

1. decrypts the app-env dotenvx files,
2. calls `rehydrateEnv()` for the shared singleton,
3. calls `rehydrateWebEnv()` for the web-owned runtime resolver, and
4. configures web-auth runtime inputs for `@roomote/auth`.

`bootstrapWebRuntimeEnv()` memoizes a successful bootstrap for the lifetime of
the process and only clears the in-flight promise on failure so callers can
retry. Per-request callers (for example the auth entrypoints) therefore do not
re-run env file loading or database initialization after the first success.
The env file loader also checks that the dotenvx-managed files exist on disk
before invoking dotenvx: when none exist (for example hosted deploys configured
purely through `process.env`), it skips dotenvx and falls back to `process.env`
directly instead of letting dotenvx print `MISSING_ENV_FILE` errors to stderr
on every bootstrap.

That bootstrap is intentionally Node-only. The web runtime adapter now fails
fast if `NEXT_RUNTIME === 'edge'`, because the current dotenvx runtime loading
path depends on Node.js APIs and local env files. For `NEXT_RUNTIME ===
'nodejs'`, dotenvx bootstrap is strict: if the runtime env file cannot be read
or decrypted, startup throws instead of silently continuing with partial state.
The current route-handler entrypoints in `apps/web/src/app/**/route.ts` also
declare `export const runtime = 'nodejs'` so Next.js does not silently switch
those serverless functions onto Edge.

`apps/web/src/lib/server/env.ts` also self-initializes on the first web-owned
`Env` access when `NEXT_RUNTIME` is unset, so test and tooling contexts can
still load the correct dotenvx-backed values without going through Next's
startup lifecycle. In the real Next.js Node runtime, the web env proxy now
fails fast if code reaches `Env` before `register()` has completed, because
that would mean the request path is executing before the intended bootstrap
contract. The one exception is Next's production build phase
(`NEXT_PHASE=phase-production-build`): `next build` legitimately evaluates app
routes and other server code while collecting build output, before the runtime
startup hook exists, so the proxy still allows lazy initialization in that
build-only context.

That bootstrap step reduces drift, but it does not make ambient shared `Env`
reads safe by construction inside every web-reachable package.

## Why `apps/web` Is Special

The risk is not dotenvx by itself. The risk is mixing multiple runtime
authorities in the same request path.

Today there are two distinct sources:

- the shared `@roomote/env` singleton, which snapshots values from
  `process.env`
- the web-owned resolver in `apps/web/src/lib/server/env.ts`, which resolves
  through dotenvx at read time

That becomes brittle when `apps/web` imports shared packages that read env
implicitly. The package may believe `Env` is authoritative even though the host
runtime has a different env-resolution model.

## Current Safe And Unsafe Patterns

### Good current patterns

#### 1. Host-owned runtime adapter

[`packages/auth/src/client-runtime.ts`](../../packages/auth/src/client-runtime.ts)
exposes runtime accessors plus `configureAuthClientEnv(...)`. The web host can
configure auth runtime values from its own resolver, and auth token code reads
from those accessors instead of hardcoding direct singleton access in every
call site.

This is the preferred pattern for shared packages that are imported by
`apps/web` and need secrets or request-time config.

#### 2. Web-owned resolver

[`apps/web/src/lib/server/env.ts`](../../apps/web/src/lib/server/env.ts)
keeps the shared schema while moving raw value resolution into the host that
actually understands dotenvx-backed web runtime behavior.

#### 3. Explicit compatibility fallback

[`packages/redis/src/index.ts`](../../packages/redis/src/index.ts) already
contains a narrow compatibility fallback that prefers `process.env.REDIS_URL`
before `Env.REDIS_URL`. That is not the final architectural shape, but it is an
example of acknowledging that the web runtime may have fresher values than the
singleton snapshot.

### Unsafe patterns for web-reachable code

#### 1. Ambient singleton reads in shared packages

Examples:

- [`packages/db/src/lib/encryption.ts`](../../packages/db/src/lib/encryption.ts)
- multiple `@roomote/cloud-agents` server modules that still import `Env`

These are unsafe when the package is called from `apps/web` request handling,
because the package is silently coupling itself to the shared singleton instead
of the host runtime.

#### 2. Reconstructing env from `process.env` inside a shared package

[`packages/db/src/db.ts`](../../packages/db/src/db.ts) currently calls
`createRoomoteEnv(process.env)` directly. That bypasses both the shared
singleton and the web-owned resolver and assumes that `process.env` itself is
the authoritative raw source.

#### 3. Diagnostics that hide the real missing key

When env lookups fail inside crypto or `Buffer.from(...)` call sites, callers
can get generic Node errors instead of an explicit missing-key error. The DB
decryption path in
[`packages/db/src/lib/encryption.ts`](../../packages/db/src/lib/encryption.ts)
is the clearest example: missing `ENCRYPTION_KEY` can surface later as a
generic hashing error.

## Target End State

The end state for `apps/web` is:

1. `apps/web` owns request-time env resolution.
2. Web request paths have one authoritative runtime env source.
3. Shared packages used by web do not read ambient `Env` for request-time
   secrets or config.
4. Shared packages receive env through explicit inputs or narrow host-configured
   runtime adapters.
5. Missing env values fail with explicit, key-specific errors instead of
   generic crypto or buffer exceptions.

In that model:

- `createRoomoteEnv()` remains the canonical schema builder for the repository.
- The exported singleton `Env` remains acceptable for runtimes where
  `process.env` is the real authority, such as CLI scripts, background
  services, and workers that do not have a separate host-owned env backend.
- `apps/web` does not treat the shared singleton as its request-time authority.

## Preferred Patterns For Web-Reachable Packages

### Pattern A: explicit parameters

Use this when the value is naturally local to one operation.

Examples:

- passing a DB URL into a constructor
- passing an encryption key into a decryption helper
- passing a callback base URL into a client factory

This is the simplest and safest option because the dependency is visible at the
call site.

### Pattern B: host-configured runtime adapter

Use this when a package has many internal helpers that need the same small set
of runtime values.

Examples:

- auth signing and validation keys
- preview-auth settings
- provider client configuration that is shared across several helpers

The adapter should be:

- narrow in scope,
- configured once by the host runtime, and
- explicit about missing keys.

### Pattern C: ambient singleton

Use this only in runtimes where `process.env` is the actual runtime authority.
Do not introduce new ambient `Env` reads for code that is expected to be
imported by `apps/web` request handling.

## Phased Migration Path

### Phase 1: low-hanging fruit

Move web-auth token signing and validation onto runtime accessors configured by
the web host.

This branch does that by:

- extending `@roomote/auth` runtime overrides to include private signing keys,
- configuring those values from
  [`apps/web/src/instrumentation.ts`](../../apps/web/src/instrumentation.ts),
- and keeping auth token code on accessor functions instead of direct singleton
  reads.

### Phase 2: DB and secret handling

Move the web-reachable DB env surface off ambient singleton reads.

Priority targets:

- [`packages/db/src/lib/encryption.ts`](../../packages/db/src/lib/encryption.ts)
  for `ENCRYPTION_KEY`
- [`packages/db/src/db.ts`](../../packages/db/src/db.ts) for `DATABASE_URL`

Target shape:

- explicit runtime accessors or explicit constructor inputs
- explicit missing-key errors
- no request-time `createRoomoteEnv(process.env)` inside web-reachable code

### Phase 3: remaining web-reachable shared packages

Audit and migrate the remaining `Env` imports that matter to `apps/web`
execution paths, especially:

- `@roomote/redis`
- web-reachable `@roomote/cloud-agents/server` paths
- any other package imported from web route handlers or tRPC commands that
  still reads request-time config ambiently

### Phase 4: guardrails

Add repository guardrails so the architecture stays stable after cleanup:

- lint or static-analysis rules that ban `import { Env } from '@roomote/env'`
  in `apps/web` request-time code and in approved web-reachable package paths
- code review guidance that new shared packages for web must use explicit
  parameters or host-configured runtime adapters
- explicit tests for missing-key failures in runtime adapters and env-dependent
  package entrypoints

## Rules Of Thumb

- In `apps/web`, prefer the web-owned runtime env over ambient shared `Env`.
- In `apps/web` route handlers, auth helpers, and tRPC procedures, auth entry
  points such as `authorize()`, `authorizeOrThrow()`, and `authorizeAdmin()`
  remain the normal bootstrap boundary because they call
  [`bootstrapWebRuntimeEnv()`](../../apps/web/src/lib/server/bootstrap-runtime-env.ts).
- If a route handler or other server-only helper intentionally bypasses auth
  but still reads `db` or `Env`, it must call
  [`bootstrapWebRuntimeEnv()`](../../apps/web/src/lib/server/bootstrap-runtime-env.ts)
  before its first runtime-dependent access.
- In shared packages imported by `apps/web`, do not add new request-time reads
  from `Env` unless the package is intentionally limited to non-web runtimes.
- `rehydrateEnv()` is a compatibility bridge, not the final safety model.
- If a package is consumed by more than one host runtime, keep the shared schema
  but let the host provide the raw runtime values.
- Missing env keys should fail at the highest-level env boundary possible, with
  an error message that names the missing key directly.

## Related Documentation

- [Authentication & Authorization](./auth.md)
- [Deployment & Release](../operations/deployment.md)
- [Environment Management](../features/environment-management.md)
