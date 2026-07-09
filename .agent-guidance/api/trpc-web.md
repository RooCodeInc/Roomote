---
title: Web tRPC Router (Browser-to-Next.js)
status: active
last_reviewed: 2026-07-09
owner: engineering
summary: Technical documentation of the Web tRPC router covering sub-router inventory, commands pattern, client hooks, and route-handler usage.
---

# Web tRPC Router (Browser-to-Next.js)

This document describes **Stack B** of Roomote's tRPC architecture: the browser-to-Next.js tRPC router that powers the Web app's frontend-backend communication.

## Overview

The Web tRPC router provides type-safe API access for the Next.js dashboard. Unlike the SDK tRPC stack (backend-to-backend), this router is optimized for browser-to-server communication with React Query integration and client-side state management.

**Key characteristics:**

- **Location**: `apps/web/src/trpc/routers/_app.ts`
- **Served at**: `/api/trpc` (Next.js route handler)
- **Transport**: HTTP batch link with superjson transformer
- **Client integration**: `useTRPC()` hook for React components with React Query helpers
- **Auth**: Better Auth-based user authentication via `protectedProcedure`

## Router Structure

### Main Router

The root router is defined in `apps/web/src/trpc/routers/_app.ts` and exports the `appRouter` with all sub-routers inline. Each sub-router groups procedures by domain.

```typescript
// apps/web/src/trpc/routers/_app.ts
export const appRouter = createRouter({
  analytics: createRouter({
    /* ... */
  }),
  tasks: createRouter({
    /* ... */
  }),
  cloudJobs: createRouter({
    /* ... */
  }),
  environments: createRouter({
    /* ... */
  }),
  backgroundAgents: automationsRouter,
  automations: automationsRouter,
  // ... more sub-routers
});

export type AppRouter = typeof appRouter;
```

### Sub-Router Inventory

The Web tRPC router contains the following domain-specific sub-routers:

| Sub-router               | Purpose                                                    | Example procedures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **analytics**            | Analytics data and charts                                  | `pullRequestOverview`, `chart`, `filters`, `details`, `export`                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **tasks**                | Task management and queries                                | `list`, `byId`, `messageEnvelopes`, `generateSummary`, `recentPullRequests`, `delete`, `updateTitle`, `search`, `pins`, `setPinned`. Task reads are deployment-scoped single-table initiator reads: `list` defaults to a current-user filter on `tasks.initiatorUserId` (creator filter values encode `initiatorUserId` / `automation:<key>` / external actors), applies `visibility = 'visible'`, and excludes soft-deleted rows; `delete` is a soft delete (`tasks.deletedAt`) that any deployment member may perform |
| **artifacts**            | Task artifact access                                       | `byPath`, `versions`, `forTask`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **cloudJobs**            | Task launch and routing helpers                            | `routeHomeTask`, `createStandardTask` (launches with an explicit `{ kind: 'user', userId }` initiator and `workflow: 'standard'` / `surface: 'web'` / `trigger: 'manual'`, accepts an optional top-level `model`, and returns the immediate `{ id, taskId }` task result), `cancel`                                                                                                                                                                                                                                     |
| **github**               | GitHub integration queries and mutations                   | `installations`, `repositories`, `branches`, `pullRequest`, `executeRevertCommit`, `enableApp`, `syncInstallations`                                                                                                                                                                                                                                                                                                                                                                                                     |
| **gitlab**               | GitLab repository sync                                     | `syncRepositories`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **gitea**                | Gitea repository sync                                      | `syncRepositories`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **ado**                  | Azure DevOps repository sync                               | `syncRepositories`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **slack**                | Slack installation and OAuth                               | `installation`, `connectApp`, `disconnectApp`, `exchangeOAuthCode`, `finishAuthenticateAccount`, `completePendingAuth`                                                                                                                                                                                                                                                                                                                                                                                                  |
| **linear**               | Linear installation helpers                                | `installation`, `disconnectApp`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **teams**                | Teams deployment integration status                        | `integrationStatus`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **linkedAccounts**       | User OAuth connections                                     | `github`, `unlinkGitHub`, `linear`, `unlinkLinear`, `slack`, `unlinkSlack`, `microsoftTeams`, `telegram`                                                                                                                                                                                                                                                                                                                                                                                                                |
| **preferences**          | Personal UI and narration preferences                      | `getPersonal`, `updatePersonal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **environments**         | Environment configuration and definition-task lifecycle    | `list`, `namesByIds`, `byId`, `activeDefinitionTask`, `create`, `update`, `startDefinitionTask`, `cancelDefinitionTask`, `duplicate`, `validateConfig`                                                                                                                                                                                                                                                                                                                                                                  |
| **snapshots**            | Workspace snapshots                                        | `createEnvironment`, `clearEnvironment`, `createCloudJob`, `restoreCloudJob`                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **mcpConnections**       | MCP server management                                      | `deploymentEnablements`, `setDeploymentEnabled`, `userConnections`, `listTools`, `connect`, `disconnect`, `saveSnowflakeConnection`                                                                                                                                                                                                                                                                                                                                                                                     |
| **auth**                 | Token generation for browser and sandbox callers           | `token`, `sandboxToken`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **environmentVariables** | Org env var management                                     | `list`, `create`, `delete`, `update`, `saveSentry`, `disconnectSentry`                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **taskEnvVarRequests**   | Task-scoped env var fulfillment                            | `fulfill`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **previewSettings**      | Deployment live-preview runtime + per-environment settings | `get`, `setDeploymentEnabled`, `updateRuntimeConfig`, `updateEnvironmentPreview`                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **sandboxSession**       | Sandbox session state and browser handoff                  | `byTaskId`, `saveDraftPrompt`, `takeOverBrowserControl`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **filters**              | Filter dropdown options                                    | `users`, `environments`, `repositories`, `pullRequests`, `models`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **deployment**           | Public pre-auth deployment diagnostics                     | `assessBrowserOrigin` (public; powers the origin-mismatch warning on `/setup` and `/sign-in`)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **setup**                | Shared setup status + completion                           | `status`, `batchCreateEnvironments`, `autoCreateAgents`, `recordAlternative`, `complete`                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **setupNew**             | Persisted admin `/setup` flow                              | `status`, `saveComputeProviderChoice`, `saveComputeConfig`, `saveSelection`, `saveQueuedTasks`, `startOnboardingTask`, `cancelOnboardingTask`, `resetSelection`, `ensureDefaultAgents`                                                                                                                                                                                                                                                                                                                                  |
| **onboarding**           | User onboarding flow                                       | `status`, `complete`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **taskSuggestions**      | Suggested Tasks generation for `/setup`                    | `list`, `trigger`, `dismiss`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **featureRequests**      | User-submitted product ideas                               | `create`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **backgroundAgents**     | Alias of the automations router for older callers          | `getSettings`, `listSlackChannels`, `updateSettings`, `triggerAutomation` (synchronous "Run now" — invokes the shared runner inline via `runAutomationNow` and returns the launched task id or a skip/error reason)                                                                                                                                                                                                                                                                                                       |
| **automations**          | Automation and reviewer settings; synchronous manual "Run now" | `getSettings`, `listSlackChannels`, `updateSettings`, `triggerAutomation` (synchronous — invokes the shared `runAutomationNow` runner inline and returns the launched task id or skip/error reason; there is no BullMQ producer coupling in `apps/web`)                                                                                                                                                                                                                                                                    |
| **agentBehavior**        | Org-level agent instruction settings                       | `get`, `update`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **taskModels**           | Deployment task-model allow-list and launch options        | `get`, `update`, `launchOptions`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **vibes**                | Org tone and Slack emoji settings                          | `get`, `update`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **customSkills**         | Marketplace skill search + availability                    | `list`, `search`, `setAvailability`, `saveManual`, `remove`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Commands Pattern

### `previewSettings` Procedures

The `previewSettings` router backs the authenticated `Settings > Environments > Live Previews` surface.

Key procedures:

- `previewSettings.get`
  - returns the editable persisted deployment preview config stored in deployment env vars
  - returns the effective resolved preview runtime config actually in use after applying runtime-env overrides and local defaults
  - returns override metadata so the UI can warn when runtime env is masking the saved deployment values
- `previewSettings.updateRuntimeConfig`
  - validates a single preview origin input before saving and rejects path-based URLs
  - derives and persists `PREVIEW_DOMAINS` plus `ROOMOTE_PREVIEW_DOMAIN` from the saved base URL hostname so downstream services stay compatible
  - writes through the shared deployment env-var upsert path instead of adding a preview-specific settings blob
- `previewSettings.updateEnvironmentPreview`
  - continues to manage per-environment preview-port exposure and `previews_enabled` flags

Procedure handlers delegate business logic to **command functions** organized by domain in `apps/web/src/trpc/commands/<domain>/`.

`tasks.byId` returns `TaskWithAssociations.inferenceUsage` for task-detail surfaces. The summary currently includes event count and cost in micro-USD, computed on read from raw `task_inference_usage_events` rows. `sandboxSession.byTaskId` reuses the same task lookup, so the sandbox task info sidebar gets the running inference cost through the existing session payload and polling cadence without a stored rollup column.

### Pattern Structure

Each sub-router's procedures follow this pattern:

```typescript
// Router definition in _app.ts
tasks: createRouter({
  delete: protectedProcedure
    .input(z.object({ taskIds: z.array(z.string()).min(1) }))
    .mutation(({ ctx: { auth }, input }) => deleteTasksCommand(auth, input)),
}),
```

The command implementation lives in a separate file:

```typescript
// apps/web/src/trpc/commands/tasks/delete.ts
export async function deleteTasksCommand(
  auth: UserAuthSuccess,
  input: { taskIds: string[] },
) {
  // Business logic: DB queries, S3 operations, validation
  const result = await db.transaction(async (tx) => {
    // ... implementation
  });

  return { success: true, deletedCount: result.count };
}
```

### Command Organization

Commands are organized in domain folders with barrel exports:

```
apps/web/src/trpc/commands/
├── ado/
├── analytics/
│   ├── chart.ts
│   ├── details.ts
│   ├── export.ts
│   ├── filters.ts
│   └── index.ts           # Re-exports all commands
├── tasks/
│   ├── by-id.ts
│   ├── delete.ts
│   ├── generate-summary.ts
│   ├── list.ts
│   ├── message-envelopes.ts
│   ├── pins.ts
│   ├── recent-pull-requests.ts
│   ├── search.ts
│   ├── update-title.ts
│   ├── index.ts
│   └── __tests__/         # Command unit tests
├── cloud-jobs/
├── artifacts/
├── auth/
├── automations/
├── agent-behavior/
├── custom-skills/
├── environment-variables/
├── environments/
├── feature-requests/
├── filters/
├── gitea/
├── github/
├── gitlab/
├── linear/
├── linked-accounts/
├── mcp-connections/
├── onboarding/
├── preferences/
├── sandbox-session/
├── setup/
├── setup-new/
├── slack/
├── snapshots/
├── task-env-var-requests/
├── task-suggestions/
└── vibes/
```

Each `index.ts` barrel file re-exports all commands:

```typescript
// apps/web/src/trpc/commands/tasks/index.ts
export { getTaskByIdCommand } from './by-id';
export { deleteTasksCommand } from './delete';
export { generateTaskSummaryCommand } from './generate-summary';
export { getTasksCommand } from './list';
// ... etc
```

The secure task env-var flow is intentionally split across two domains:

- The pending request state comes from Roomote runtime task history and live sandbox events, not from a dedicated web-router query.
- `taskEnvVarRequests` now owns only the admin-only fulfillment mutation.
- `environmentVariables` remains the canonical encrypted persistence layer for organization secrets.

### `setupNew` Procedures

The `setupNew` router backs the current `/setup` admin onboarding route. Unlike the older `setup` router, it persists deployment-scoped selection state plus Slack handoff metadata so the flow can survive refreshes and OAuth redirects without replaying the welcome step. `/setup` now stays as the durable setup console while the actual environment-setup conversation runs through Slack, then resumes the remaining in-product onboarding checklist once the environment is ready.

Key procedures:

- `setupNew.status`
  - returns GitHub / Slack / Linear connection state
  - returns the persisted `setupNewState`
  - resolves the current onboarding task status by task ID
  - resolves whether a matching environment was created after onboarding started
  - includes the persisted Slack DM metadata (`slackChannel`, `slackThreadTs`) used by the setup console
  - includes `computeSetup`, the per-provider compute setup status (Docker, Modal, Daytona, E2B) built from the runtime env, saved deployment env vars, and the persisted default compute provider
- `setupNew.saveComputeProviderChoice`
  - records the wizard choice on `setupNewState.computeProvider` only
  - deliberately does not touch `runtime_compute_config`: the config step always follows the picker, and confirming it (`saveComputeConfig`) is the single commit point for the runtime default, so browsing a provider never switches the deployment onto it
- `setupNew.saveComputeConfig`
  - persists the chosen compute provider as `deployment_settings.runtime_compute_config.defaultProvider` and records the wizard choice on `setupNewState.computeProvider`
  - encrypts any submitted provider credentials (e.g. `MODAL_TOKEN_ID`, `DAYTONA_API_KEY`, `E2B_API_KEY`) into deployment environment variables
  - rejects the save when a required credential for the chosen provider is not satisfied by the runtime env, saved env vars, or submitted values
  - for provisionable providers (E2B without `E2B_TEMPLATE_ID`, Daytona without `DAYTONA_SNAPSHOT_NAME`), records the run as pending on `setupNewState.e2bTemplateBuild` / `setupNewState.daytonaSnapshotBuild` and starts a detached worker base-image provisioning run in the operator's provider account after the transaction commits; the wizard polls `setupNew.status` (which presents stale in-flight runs as failed) until the artifact ref is persisted as an encrypted deployment env var
- `setupNew.saveSelection`
  - validates that the selected repo IDs belong to the current org
  - normalizes and persists the repo selection as a deterministic set
  - clears any previous onboarding task pointer
  - clears any previous Slack handoff metadata so a retry starts from a clean state
  - clears any persisted onboarding-suggestion batch when the selected repos or setup guidance change so Home does not reuse stale suggestions
- `setupNew.startOnboardingTask`
  - reuses the existing `$environment-setup` kickoff prompt
  - resolves the Slack DM target from `slack_user_mappings`, preferring the current installer mapping and falling back to the workspace installer when needed
  - opens or reuses a Slack DM, posts the kickoff message, and starts a real `TaskPayloadKind.SlackAppMention` run with a synthetic Slack event payload
  - launches with an explicit `{ kind: 'user', userId }` initiator and `workflow: 'setup_onboarding'`, so onboarding analytics, admin history, and task detail views classify the kickoff by workflow instead of any attribution override
  - sets `webPath: '/setup'` on the Slack onboarding payload so thread replies can deep-link back to the setup console
  - launches a single-repo workspace when one repo is selected, or a scoped multi-repo workspace when several repos are selected
  - only checks out the validated selected repos for the onboarding task instead of every active org repo
  - persists the immediate onboarding task ID, plus started-at timestamp and Slack handoff metadata
  - rolls back the Slack kickoff message if task creation fails so `/setup` stays recoverable

Slack setup thread follow-up behavior:

- setup-onboarding completion posts a thread reply with an `Open setup` link to `/setup`
- setup-onboarding failure posts a thread reply with an `Open setup` link to `/setup`
- successful `request_environment_variables` tool results in the setup task now auto-post a standardized Slack thread reply linking back to `/setup`, accompanying any agent-authored explanation of the requested variable keys
- secret/private `request_user_input` fallbacks in the setup thread now point to `/setup` instead of `/task/:id`
- `setupNew.cancelOnboardingTask`
  - cancels the current onboarding task by its persisted task ID
- `setupNew.resetSelection`
  - clears the selected repo set, onboarding task metadata, and Slack handoff metadata
  - clears any persisted onboarding-suggestion batch for the org
- `setupNew.ensureDefaultAgents`
  - runs the additive default-agent bootstrap used after onboarding succeeds

The `/setup` page combines `setupNew.status` with the existing `setup.complete` mutation. Slack becomes the primary setup conversation after repo selection, while `/setup` stays responsible for route gating, status visibility, secure env-var fulfillment, and final completion once the first environment exists.

This router lives in the same main web router file as the existing domains (`apps/web/src/trpc/routers/_app.ts`) and delegates its implementation to `apps/web/src/trpc/commands/setup-new/index.ts`.

### `taskSuggestions` Procedures

The `taskSuggestions` router backs Suggested Tasks generation for `/setup`.

Key procedures:

- `taskSuggestions.trigger`
  - explicitly launches Suggested Tasks generation for the current `/setup` repository selection
  - returns whether a new task was triggered plus the current generation status and tracked suggestion task ID
- `taskSuggestions.list`
  - reads the selected repository IDs and setup guidance from `setupNewState`
  - launches a hidden suggester task (`TaskPayloadKind.Scan` with `workflow: 'scan'`, `visibility: 'hidden'`, initiated by the requesting user) when the org does not already have a batch or in-flight task for the current setup selection
  - reads the suggester automation's saved instructions from its `automations` row `settings` and injects those preferences into the suggester prompt alongside the setup-specific guidance
  - returns an explicit generation state (`pending`, `empty`, or `ready`) so the onboarding UI can distinguish in-flight generation from a finished empty batch
  - reads the persisted batch from PostgreSQL `work_items` (the suggested-task kind) after the task submits it through the task-scoped `submit_task_suggestions` MCP tool
  - persisted suggestion rows now keep per-idea launch metadata (`target_repository_full_name`, optional `target_environment_id`, workspace readiness, and an optional readiness message) in addition to the batch-level `repository_ids` provenance column
  - onboarding-triggered runs keep the existing setup-DM posting flow, while scheduled runs use the same submission contract to persist per-idea launch targets before optionally posting an org-channel Slack summary when their payload sets `notifySlack: true`
- `taskSuggestions.dismiss`
  - records a dismissal for a single suggestion row (legacy compatibility; the primary setup flow now uses Slack reactions instead of UI dismissal/selection)

### `featureRequests` Procedures

The `featureRequests` router backs the dashboard-wide feature-idea prompt dialog surfaced from desktop and mobile navigation.

Key procedures:

- `featureRequests.create`
  - accepts a trimmed prompt with the same 50-character minimum enforced by the UI
  - requires a fully qualified `sourceUrl` captured from the page where the user opened the dialog
  - persists the request in PostgreSQL `feature_requests` with the current org ID, user ID, prompt body, source URL, and creation timestamp

### `setupNew` Follow-Up Task Procedures

The `setupNew` router owns the setup-page list of follow-up tasks tied to the active setup onboarding task. This is a local pending selection for the setup flow, not the removed Work Queue product surface.

Additional procedures:

- `setupNew.saveQueuedTasks`
  - supports explicit web-driven follow-up task saves
  - validates the selected suggestion IDs against the deployment-scoped persisted suggestion batch
  - stores the selected suggestion briefs plus an optional custom prompt against the active onboarding task
  - replaces any previous unlaunched follow-up list for that onboarding task so the setup flow always reflects the latest setup-page selections
  - auto-launches the saved queue immediately when the environment already exists, otherwise leaves it pending for the status flow to launch once setup succeeds
- `setupNew.status`
  - now also returns the persisted queued-task rows for the active onboarding task
  - launches any pending queued tasks exactly once when setup has succeeded and a matching environment exists
  - setup now also launches selected follow-up tasks from Slack `reaction_added` events (`+1` or `thumbsup`) on setup suggestion thread replies
  - when a setup-suggestion reaction launches a task immediately, the Slack thread also gets a confirmation reply: `Starting on {suggestion.title}. Follow here`

### `environments` Environment-Definition Procedures

The `environments` router still owns the CRUD and validation procedures for environments, and it now also exposes the agent-backed environment-definition launch path used by the settings pages.

Additional environment-definition procedures:

- `environments.startDefinitionTask`
  - validates the selected repo IDs against the current org
  - ensures the Standard Task / Generalist launch path is available
  - launches a Standard Task with an explicit `$environment-setup` kickoff prompt
  - returns an immediate task ID; queued environment-definition results are treated as launch errors in the web path
  - launches a single-repo workspace when one repo is selected, or a scoped multi-repo workspace when several repos are selected
  - switches the prompt into update mode when an `environmentId` is supplied so the agent revises the existing environment definition instead of creating a duplicate
- `environments.cancelDefinitionTask`
  - cancels the active cloud jobs for a previously launched environment-definition task

### `customSkills` Procedures

The `customSkills` router backs the admin-only `/settings/skills` page and stays intentionally YAML-first by treating each environment `config.skills` plus `config.manualSkills` block as the source of truth.

Key procedures:

- `customSkills.list`
  - reads org-owned environments and derives installed skills as the union of all marketplace `config.skills` entries plus inline `config.manualSkills`
  - groups manual skills by exact `SKILL.md` content so environments with the same manual-skill name but different bodies stay separate in the installed list
  - returns per-skill environment assignments for the availability editor
- `customSkills.search`
  - executes CLI marketplace lookup through `npx skills find <query>`
  - strips ANSI output and parses at most 20 distinct results
- `customSkills.setAvailability`
  - updates one marketplace skill's environment selection by patching each environment's `config.skills`
  - requires at least one selected environment to keep a skill installed
  - runs updates transactionally across all affected environments
- `customSkills.saveManual`
  - accepts pasted `SKILL.md` content plus the selected environment IDs
  - validates YAML frontmatter, requires a `name` and `description`, and keeps the record keyed by that frontmatter `name`
  - patches each selected environment's `config.manualSkills` map and only removes the previously edited manual-skill variant from environments that were already using that exact variant
- `customSkills.remove`
  - removes either a marketplace skill or one exact manual-skill variant from the environments currently using it
  - also runs as a transactional multi-environment update

### Why Commands?

The commands pattern provides:

- **Testability**: Commands can be unit tested independently of tRPC middleware
- **Reusability**: Commands keep reusable domain logic in one place and also export shared types used by hooks/components
- **Separation of concerns**: Router definitions stay declarative; business logic lives in focused modules
- **Type safety**: Commands receive typed `auth` context and validated `input`

## Client Usage

### React Components: `useTRPC()` Hook

React components use the `useTRPC()` hook to build typed React Query options and query keys:

```typescript
'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/trpc/client';

export function MyComponent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const tasksQuery = useQuery(
    trpc.tasks.list.queryOptions({
      limit: 20,
      filters: [],
    }),
  );

  const deleteTask = useMutation(
    trpc.tasks.delete.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.tasks.list.queryKey(),
        });
      },
    }),
  );

  if (tasksQuery.isLoading) {
    return <div>Loading…</div>;
  }

  return (
    <button onClick={() => deleteTask.mutate({ taskIds: ['task_123'] })}>
      Delete
    </button>
  );
}
```

The `useTRPC()` hook is defined in `apps/web/src/trpc/client.tsx`:

```typescript
export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();
```

It wraps React Query with tRPC type inference and provides helpers for:

- `queryOptions()` / `infiniteQueryOptions()` - typed query configs
- `mutationOptions()` - typed mutation configs
- `queryKey()` - cache invalidation and refetch targeting

### Server-Side Caller

The web app now ships a checked-in server-side caller helper at `apps/web/src/trpc/server.ts`:

```typescript
import { createContext } from './init';
import { appRouter } from './routers/_app';

export async function createServerCaller() {
  return appRouter.createCaller(await createContext());
}
```

Route handlers and selected server components can use `createServerCaller()` when they should go through the same procedures as the browser. Direct server utilities and `@roomote/db/server` are still appropriate for lower-level reads or logic that should stay below the web-router boundary.

## Route Handler

The tRPC router is exposed via a Next.js route handler at `/api/trpc`:

```typescript
// apps/web/src/app/api/trpc/[trpc]/route.ts
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { createContext } from '@/trpc/init';
import { appRouter as router } from '@/trpc/routers/_app';

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router,
    createContext,
  });

export { handler as GET, handler as POST };
```

All tRPC requests from the browser are sent to `/api/trpc` and handled by this route.

## Initialization & Context

### Context Creation

The tRPC context is created in `apps/web/src/trpc/init.ts`:

```typescript
export const createContext = async () => {
  const auth = await authorize();
  return { auth };
};

export type Context = Awaited<ReturnType<typeof createContext>>;
```

The `authorize()` helper from `@/lib/server` uses the app auth context to extract the current user's authentication state.

### Procedures

Two procedure types are available:

- **`protectedProcedure`**: Requires authentication, throws `UNAUTHORIZED` if auth fails

```typescript
export const protectedProcedure = t.procedure.use(
  async function isAuthed(opts) {
    const auth = opts.ctx.auth;

    if (!auth.success) {
      throw new TRPCError({ code: 'UNAUTHORIZED' });
    }

    return opts.next({ ctx: { auth } });
  },
);
```

Protected procedures guarantee that `ctx.auth` is a `UserAuthSuccess` object containing `userId`, `isAdmin`, user identity fields, and resolved feature flags. Roomote has no local organization or workspace auth scope.

## Provider Setup

The `TRPCReactProvider` wraps the app and provides React Query + tRPC context:

```typescript
// apps/web/src/trpc/client.tsx
export function TRPCReactProvider({ children }: { children: React.ReactNode }) {
  const queryClient = getQueryClient();

  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: '/api/trpc', transformer: superjson })],
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
```

Key features:

- **Batch link**: Multiple queries in a single HTTP request
- **superjson transformer**: Preserves Date, Map, Set, BigInt across serialization
- **Singleton query client**: Shared React Query cache across renders

## Key Files Reference

| File                                        | Purpose                                                     |
| ------------------------------------------- | ----------------------------------------------------------- |
| `apps/web/src/trpc/routers/_app.ts`         | Main router definition with all sub-routers                 |
| `apps/web/src/trpc/init.ts`                 | tRPC initialization, context, procedures                    |
| `apps/web/src/trpc/client.tsx`              | `useTRPC()` hook and `TRPCReactProvider`                    |
| `apps/web/src/trpc/server.ts`               | Server-side caller for route handlers and server components |
| `apps/web/src/trpc/commands/<domain>/`      | Command implementations organized by domain                 |
| `apps/web/src/app/api/trpc/[trpc]/route.ts` | Next.js route handler at `/api/trpc`                        |
| `apps/web/src/trpc/query-client.ts`         | React Query client configuration                            |

## Comparison with SDK tRPC Router

| Aspect         | Web Router (Stack B)                                               | SDK Router (Stack A)                      |
| -------------- | ------------------------------------------------------------------ | ----------------------------------------- |
| **Purpose**    | Browser ↔ Next.js                                                  | Backend ↔ Backend                         |
| **Location**   | `apps/web/src/trpc/routers/_app.ts`                                | `packages/sdk/src/server/routers/app.ts`  |
| **Endpoint**   | `/api/trpc` (Next.js route)                                        | `/trpc` (Hono API server)                 |
| **Auth**       | Better Auth user sessions                                          | JWT tokens (job + auth)                   |
| **Client**     | React Query `queryOptions()` / `mutationOptions()` via `useTRPC()` | Direct tRPC client (`httpBatchLink`)      |
| **Middleware** | `protectedProcedure`                                               | `authenticatedProcedure`, `jobScoped()`   |
| **Pattern**    | Commands in `commands/<domain>/`                                   | Direct database/SDK calls in router files |
| **Consumers**  | Web dashboard React components                                     | Worker, controller, API                   |

## Testing

Commands are unit tested in `apps/web/src/trpc/commands/<domain>/__tests__/`:

```typescript
// Example: apps/web/src/trpc/commands/tasks/__tests__/delete.test.ts
import { db, tasks, userFactory, taskFactory } from '@roomote/db/server';
import { deleteTasksCommand } from '../delete';

describe('deleteTasksCommand', () => {
  it('soft-deletes tasks', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({ initiatorUserId: user.id });

    const result = await deleteTasksCommand(
      { success: true, userId: user.id, isAdmin: false },
      { taskIds: [task.id] },
    );

    expect(result.deletedCount).toBe(1);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.deletedAt).not.toBeNull();
  });
});
```

Tests use a mixed strategy: some command tests hit the test database with factories, while others mock external dependencies for focused unit coverage.

## Related Documentation

- [SDK tRPC Router](./trpc-sdk.md) — Backend-to-backend tRPC stack (Stack A)
- [Authentication](../architecture/auth.md) — Better Auth auth flow and shared auth patterns
- [Database](../architecture/database.md) — Drizzle schema and query patterns
