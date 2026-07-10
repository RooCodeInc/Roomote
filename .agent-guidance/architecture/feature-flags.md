---
title: Feature Flags
status: active
last_reviewed: 2026-07-10
owner: engineering
summary: Current database-backed feature flag system, evaluation order, the admin Experimental settings page, and the active Roomote flag catalog.
---

# Feature Flags

Roomote feature flags are code-defined controls backed by database metadata
`metadata`, mirrored into PostgreSQL, and evaluated through a
Redis-backed cache. They gate product surfaces and runtime behavior at the
deployment or user level.

## Storage Boundaries

| Concern             | Canonical storage                                                                        | Example keys                                   | Notes                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| Feature flags       | database `deployment_settings.metadata` (deployment-wide) or `users.metadata` (per-user) | `slack_eval_launcher`, `slack_proof_auto_post` | Defined by `FeatureFlag` and `FEATURE_FLAG_CONFIG`.                    |
| User preferences    | database `users.metadata`                                                                | `color_theme`, `show_debug_ui`                 | Preferences may be gated by flags but are not feature flags themselves |
| Browser-local state | `localStorage`                                                                           | navigation expansion, local onboarding state   | Disposable per-browser convenience state                               |

Do not introduce a feature flag when a persisted preference already represents
the same user choice. If a feature flag around an existing setting is removed,
remove the gate first and only remove the underlying preference if the setting
itself is being deleted.

## Architecture

| File                                                        | Purpose                                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/feature-flags/src/types.ts`                       | `FeatureFlag`, config types, metadata shapes                   |
| `packages/feature-flags/src/config.ts`                      | `FEATURE_FLAG_CONFIG`, descriptions, metadata keys, groups     |
| `packages/feature-flags/src/evaluator.ts`                   | Database/cache-backed evaluator                                |
| `packages/feature-flags/src/cache.ts`                       | Redis metadata cache                                           |
| `packages/feature-flags/src/server/index.ts`                | Server-only export surface                                     |
| `apps/web/src/trpc/commands/feature-flags/index.ts`         | Admin-gated read/update commands backing the Experimental page |
| `apps/web/src/components/settings/ExperimentalSettings.tsx` | Admin-only Experimental settings UI                            |

Client-safe code may import the base package. Server code that evaluates flags
against mirrored metadata should import `@roomote/feature-flags/server`.

## Admin Experimental Settings Page

Deployment-wide flags are managed by admins from the **Experimental** settings
page at `/settings/experimental`. It is `adminOnly` in the settings navigation
and both the read and update tRPC commands assert `auth.isAdmin` before
running.

- The read command (`featureFlags.getExperimental`) returns every configured
  flag with its current effective value, whether it is explicitly overridden in
  `deployment_settings.metadata`, and its resolved default.
- The update command (`featureFlags.setExperimental`) merges the boolean into
  `deployment_settings.metadata` under the flag's primary `metadataKey`,
  then calls `getFeatureFlagEvaluator(redis).invalidateDeploymentCache()` so
  the worker/api SDK evaluator observes the change on its next evaluation
  instead of serving the stale Redis-cached value.
- The web auth context reads flags directly from
  `deployment_settings.metadata` on every request, so admin changes take
  effect for the web app without a cache invalidation; the invalidation only
  matters for the SDK `featureFlags.evaluate` path used by workers and API
  handlers.

Flags that are defined in `FEATURE_FLAG_CONFIG` but not yet consumed by any
product code are still surfaced on the page so admins can pre-enable them
ahead of a rollout.

## Evaluation Order

1. If the config has an `override`, use it.
2. If the primary `metadataKey` exists in mirrored `metadata`, use it.
3. If a configured older metadata key exists, use it only when the primary key
   is absent.
4. Fall back to `defaultValue`.

Values are coerced with `coerceToBoolean()` for boolean flags. Structured
metadata controls such as `queue_parallel_task_limit` are consumed directly by
their owning runtime path instead of being modeled as boolean feature flags.

## Active Flag Catalog

The active enum in `packages/feature-flags/src/types.ts` is:

```typescript
export enum FeatureFlag {
  PlanMode = 'PlanMode',
  SlackEvalLauncher = 'SlackEvalLauncher',
  ShowDebugUISetting = 'ShowDebugUISetting',
  SlackProofAutoPost = 'SlackProofAutoPost',
  SuggestionRouting = 'SuggestionRouting',
  VisualProofAutoScreencast = 'VisualProofAutoScreencast',
  AuthorshipRules = 'AuthorshipRules',
  BackgroundSubagents = 'BackgroundSubagents',
}
```

When adding or removing a flag, update the enum, `FEATURE_FLAG_CONFIG`,
metadata descriptors/tests, and any guidance or UI copy that names the flag.

## Runtime Notes

- `SlackEvalLauncher` gates the internal Slack `!eval` launcher. Its harness
  flag accepts only `opencode-server`; model overrides must be from the
  supported OpenCode catalog, and reasoning overrides are rejected.
- `PlanMode` gates whether planning-workflow turns switch onto Roomote's
  generated read-mostly `architect` primary agent (see
  [Workflow System](./workflow-system.md#plan-mode-enforcement)). When
  disabled, planning still runs, but it stays on the default `build` agent;
  the configured planning-model fields still override the architect agent's
  model in the generated config either way.
- `SlackProofAutoPost` controls whether trusted visual-proof artifacts are
  auto-posted back into the originating Slack thread.
- `VisualProofAutoScreencast` lets `capture-visual-proof` classify applicable
  visual proof as screencast evidence when the claim needs temporal proof.
- `AuthorshipRules` gates deployment-level effective-author and PR-owner rule
  resolution.
- `BackgroundSubagents` (default off; the metadata key is an explicit opt-in)
  gates the background subagents
  feature, letting the Task tool launch subagents asynchronously via its
  `background` flag instead of blocking the parent agent. The worker sets
  `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1` in the opencode-server
  subprocess env when this flag is enabled. When enabled it also switches the
  standard-task delivery flow to non-blocking background proof
  (`backgroundProofCaptureEnabled` in `standardTask`): autonomous
  repository-changing runs finish delegated delivery first, launch the
  `capture-visual-proof` delegation with `background: true`, and consume the
  background completion notification by refreshing the PR body with the proof
  artifacts and sharing them in the conversation thread; Interactive mode
  keeps the foreground proof flow either way. With the flag off (the
  default), proof capture runs foreground and before delivery, so the judge
  pass and the PR ship with the screenshots already verified — background
  delivery proved unreliable in dogfood (models repeatedly failed to use the
  Task tool's `background` flag), and the subagent watchdog's inactivity
  deadline now bounds foreground capture cost. The `metadataKey` is
  `background_subagents`, with `opencode_background_subagents` retained as a
  legacy key; note an explicit `background_subagents: true` in deployment
  metadata still enables the flag over the off default.

## Admin Metadata Descriptors

`FEATURE_FLAG_CONFIG` descriptions are reused by internal admin metadata
surfaces. If a flag is removed from the enum, also remove any admin grouping or
descriptor expectations tied to it so stale no-op controls do not remain
writable.

The admin boolean metadata flow should only expose current flags and current
org controls. Historical names should be removed rather than preserved as hidden
compatibility toggles for new-project behavior.
