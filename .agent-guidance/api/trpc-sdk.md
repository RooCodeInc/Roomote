---
title: SDK tRPC Router (Backend-to-Backend)
status: active
last_reviewed: 2026-07-03
owner: engineering
summary: Technical documentation of the SDK tRPC router covering sub-router inventory, auth middleware, cloud job operations, and client configuration.
---

# SDK tRPC Router (Backend-to-Backend)

## Overview

The SDK tRPC router (`@roomote/sdk`) provides Stack A of Roomote's two-tier tRPC architecture: backend-to-backend communication between the API server and worker processes. Unlike the web tRPC stack (browser ↔ Next.js), this stack handles authenticated service-to-service calls with specialized JWT token types and job-scoped authorization.

**Key characteristics:**

- **Server**: Hono API (`apps/api`) at `/trpc` endpoint
- **Clients**: Worker processes, controller service, other backend services
- **Transport**: HTTP batch link with superjson transformer
- **Auth**: ES256 JWT tokens (job tokens and auth tokens)
- **Pattern**: Public wrapper modules delegate to typed tRPC client

## Architecture

### Router Structure

Main router definition at `packages/sdk/src/server/routers/app.ts`:

```typescript
export const appRouter = router({
  auth: authRouter,
  githubInstallations: githubInstallationsRouter,
  slackInstallations: slackInstallationsRouter,
  linearInstallations: linearInstallationsRouter,
  repositories: repositoriesRouter,
  cloudJobs: cloudJobsRouter,
  environments: environmentsRouter,
  featureFlags: featureFlagsRouter,
  mcpConnections: mcpConnectionsRouter,
  userApiKeys: userApiKeysRouter,
});
```

Type exports enable compile-time guarantees for inputs/outputs:

```typescript
export type AppRouter = typeof appRouter;
export type AppRouterInput = inferRouterInputs<AppRouter>;
export type AppRouterOutput = inferRouterOutputs<AppRouter>;
```

## Sub-Router Inventory

| Router                  | File                      | Domain                             | Key Procedures                                                                                                                                   |
| ----------------------- | ------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **auth**                | `auth.ts`                 | Authentication                     | `me`, `createJobToken`, `createAuthToken`                                                                                                        |
| **cloudJobs**           | `cloud-jobs.ts`           | Job lifecycle                      | `findFirstById`, `enqueue`, `dequeue`, `resume`, `update`, `done`, `recordMessageEnvelope`, `createSnapshot`                                     |
| **environments**        | `environments.ts`         | Environment config                 | `list`, `byId`, `findEnvironment`, `updateSnapshotStatus`                                                                                        |
| **featureFlags**        | `feature-flags.ts`        | Org-scoped feature flag evaluation | `evaluate`                                                                                                                                       |
| **repositories**        | `repositories.ts`         | GitHub repos                       | `listRepositories`, `findRepository`                                                                                                             |
| **githubInstallations** | `github-installations.ts` | GitHub App installs                | `findFirst`                                                                                                                                      |
| **slackInstallations**  | `slack-installations.ts`  | Slack workspace installs           | `findFirst`, `drainSlackMessages`                                                                                                                |
| **linearInstallations** | `linear-installations.ts` | Linear workspace installs          | `findFirst`, `hasActiveInstallation`, `emitAction`, `emitThought`, `emitResponse`, `emitElicitation`, `updateSessionPlan`, `drainLinearMessages` |
| **mcpConnections**      | `mcp-connections.ts`      | MCP connection lookups             | `hasValidTokens`, `getMcpServerConfigs`                                                                                                          |
| **userApiKeys**         | `user-api-keys.ts`        | User API key access                | `hasKey`, `getDecryptedKey`                                                                                                                      |

## Authentication Middleware

Defined in `packages/sdk/src/server/trpc.ts`, the SDK server exports four procedure builders with different authorization behavior:

### authenticatedProcedure

Requires any valid token (auth or job). Used for endpoints accessible by both workers and authenticated users.

```typescript
export const authenticatedProcedure = t.procedure.use(async (opts) => {
  const { ctx } = opts;

  if (!ctx.auth) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to access this resource.',
    });
  }

  return opts.next({
    ctx: { ...ctx, auth: ctx.auth },
  });
});
```

**Example usage:**

```typescript
// repositories.ts
listRepositories: authenticatedProcedure.query(({ ctx }) =>
  listRepositories(ctx.auth),
);
```

### nonJobProcedure

Blocks job tokens entirely. Used for endpoints that workers should never access (e.g., creating new jobs, managing installations).

```typescript
export const nonJobProcedure = t.procedure.use(async (opts) => {
  if (!opts.ctx.auth) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to access this resource.',
    });
  }

  if (isJobToken(opts.ctx.auth)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This endpoint is not available to job tokens',
    });
  }

  return opts.next({
    ctx: { ...opts.ctx, auth: opts.ctx.auth as AuthTokenContext },
  });
});
```

**Example usage:**

```typescript
// auth.ts
me: nonJobProcedure.query(({ ctx }) => me(ctx.auth))

// cloud-agents.ts
findMany: nonJobProcedure.query(({ ctx }) => { ... })
```

### jobScoped(schema, extractJobId)

Enforces cloud-job resource isolation. Job tokens must present their own
`cloudJobId`, while auth tokens can only access jobs that belong to their own
organization.

**Signature:**

```typescript
function jobScoped<T extends z.ZodType>(
  schema: T,
  extractJobId: keyof z.infer<T> | ((input: z.infer<T>) => number),
);
```

**Parameters:**

- `schema`: Zod schema for the procedure input
- `extractJobId`: Field name (e.g., `'cloudJobId'`) or extractor function to get the job ID from input

**Example usage:**

```typescript
// Direct field name
update: jobScoped(
  z.object({
    id: z.number(),
    status: z.nativeEnum(CloudTaskStatus).optional(),
    taskPhase: z.string().nullish(),
  }),
  'id', // Field name
).mutation(({ input: { id, ...values } }) => updateCloudJob(id, values));

// Extractor function
findFirstById: jobScoped(
  z.number(),
  (id) => id, // Extract ID from primitive input
).query(({ input }) => findCloudJob(input));
```

**Authorization logic:**

```typescript
.use(async ({ ctx, input, next }) => {
  const targetId =
    typeof extractJobId === 'function'
      ? extractJobId(input)
      : (input as Record<string, unknown>)[extractJobId as string];

  if (isJobToken(ctx.auth)) {
    if (targetId !== ctx.auth.cloudJobId) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Cannot access resources from a different job',
      });
    }

    return next({ ctx: { ...ctx, cloudJobId: ctx.auth.cloudJobId } });
  }

  const scopedJob = await findCloudJobForAccess(targetId, ctx.auth);

  if (!scopedJob) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Cannot access resources from another user's job',
    });
  }

  return next({ ctx: { ...ctx, cloudJobId: targetId } });
});
```

### optionalAuthProcedure

Passes through `ctx.auth` without requiring it. This helper is exported from the SDK server surface for procedures that may personalize when auth is present but still need to admit anonymous callers.

```typescript
export const optionalAuthProcedure = t.procedure.use(async (opts) => {
  const { ctx } = opts;
  return opts.next({ ctx: { ...ctx, auth: ctx.auth } });
});
```

The current root `appRouter` mostly uses the stricter builders above, but `optionalAuthProcedure` is part of the shipped server toolkit and should be preferred over ad hoc nullable-auth handling when a future router truly supports both anonymous and authenticated access.

## Key Router: cloudJobs

The `cloudJobs` router (`packages/sdk/src/server/routers/cloud-jobs.ts`) is the most critical router, handling the complete job lifecycle for worker processes.

### Job Lifecycle Procedures

#### dequeue

Claim a job from the queue and prepare workspace.

```typescript
dequeue: jobScoped(z.object({ cloudJobId: z.number() }), 'cloudJobId').mutation(
  ({ ctx, input }) => dequeueCloudJob(ctx.auth, input),
);
```

**Auth**: Job tokens must match `cloudJobId`; auth tokens must target a job in
their own organization

#### resume

Claim a job for resumption from a snapshot.

```typescript
resume: jobScoped(z.object({ cloudJobId: z.number() }), 'cloudJobId').mutation(
  ({ ctx, input }) => dequeueResumeCloudJob(ctx.auth, input),
);
```

**Auth**: Job tokens must match `cloudJobId`; auth tokens must target a job in
their own organization

#### update

Update job status, phase, or result.

```typescript
update: jobScoped(
  z.object({
    id: z.number(),
    status: z.nativeEnum(CloudTaskStatus).optional(),
    taskPhase: z.string().nullish(),
    taskId: z.string().optional(),
    actingUserId: z.string().optional(),
    result: z.record(z.unknown()).optional(),
  }),
  'id',
).mutation(({ input: { id, ...values } }) => updateCloudJob(id, values));
```

**Auth**: Job tokens must match `id`; auth tokens must target a job in their
own organization

#### done

Mark job as complete or failed.

```typescript
done: jobScoped(
  z.object({
    id: z.number(),
    status: z.enum(doneCloudTaskStatuses),
    error: z.string().optional(),
  }),
  'id',
).mutation(({ input }) => finishCloudJob(input));
```

**Auth**: Job tokens must match `id`; auth tokens must target a job in their
own organization
**Status values**: `'completed'`, `'failed'`, `'canceled'`, `'idle'`

### Logging & Observability

#### recordMessageEnvelope

Record a Roomote runtime message envelope for task execution history.

```typescript
recordMessageEnvelope: jobScoped(
  z.object({
    cloudJobId: z.number(),
    taskId: z.string(),
    envelope: runtimePersistedEnvelopeSchema, // Roomote runtime protocol envelope
  }),
  'cloudJobId',
).mutation(({ ctx, input }) => {
  const userId = 'userId' in ctx.auth ? ctx.auth.userId : undefined;

  return recordTaskMessageEnvelope({
    cloudJobId: input.cloudJobId,
    taskId: input.taskId,
    userId,
    envelope: input.envelope,
  });
});
```

**Envelope schema**:

```typescript
{
  ts: number;
  eventType: string;  // Must start with "roomote_runtime."
  role: 'user' | 'assistant' | 'system' | 'tool' | null;
  protocol: 'roomote_runtime';
  contentBlocks: unknown[];
  metadata: Record<string, unknown> | null;
  payload: Record<string, unknown>;
}
```

#### setHarnessSessionId

Link job to harness session for debugging.

```typescript
setHarnessSessionId: jobScoped(
  z.object({
    cloudJobId: z.number(),
    harnessSessionId: z.string(),
  }),
  'cloudJobId',
).mutation(({ input }) => setTaskHarnessSessionId(input));
```

### Snapshot Management

#### createSnapshot

Create a provider snapshot of the running machine for fast resumption.

```typescript
createSnapshot: jobScoped(
  z.object({ cloudJobId: z.number(), sandboxId: z.string() }),
  'cloudJobId',
).mutation(async ({ input }) => {
  const enqueued = await createSnapshot(input);
  return { enqueued };
});
```

Returns `{ enqueued: boolean }` indicating if snapshot job was queued.

#### fetchSnapshotEnv

Retrieve environment variables from a snapshot.

```typescript
fetchSnapshotEnv: jobScoped(
  z.object({ cloudJobId: z.number() }),
  'cloudJobId',
).query(({ ctx, input }) => fetchSnapshotEnv(ctx.auth, input));
```

### Integration Data

#### getMessageSources

Get Slack/Linear message sources for job context.

```typescript
getMessageSources: jobScoped(
  z.object({ cloudJobId: z.number() }),
  'cloudJobId',
).query(({ input }) => getMessageSources(input.cloudJobId));
```

#### getSlackMessages

Fetch queued Slack thread follow-up messages for a job. This remains as the Slack compatibility route; new providers should use `getCommunicationMessages`.

```typescript
getSlackMessages: jobScoped(
  z.object({ cloudJobId: z.number() }),
  'cloudJobId',
).query(async ({ input }) => getSlackMessages(input.cloudJobId));
```

#### getCommunicationMessages

Fetch queued provider-neutral chat follow-up messages for a job.

```typescript
getCommunicationMessages: jobScoped(
  z.object({
    cloudJobId: z.number(),
    provider: communicationProviderSchema,
  }),
  'cloudJobId',
).query(async ({ input }) =>
  getCommunicationMessages(input.provider, input.cloudJobId),
);
```

#### queueCommunicationMessage

Queue a provider-neutral chat follow-up message for an active job. This route is job-token-only, matching Slack and Linear follow-up enqueue routes.

```typescript
queueCommunicationMessage: jobTokenOnlyScoped(
  z.object({
    cloudJobId: z.number(),
    provider: communicationProviderSchema,
    message: queuedCommunicationMessageSchema,
  }),
  'cloudJobId',
).mutation(async ({ input }) =>
  queueCommunicationMessage(input.provider, input.cloudJobId, input.message),
);
```

#### getLinearMessages

Fetch Linear issue comments for job.

```typescript
getLinearMessages: jobScoped(
  z.object({ cloudJobId: z.number() }),
  'cloudJobId',
).query(async ({ input }) => getLinearMessages(input.cloudJobId));
```

### GitHub Operations

#### refreshGitHubTokenWithMetadata

Refresh GitHub installation token with metadata.

```typescript
refreshGitHubTokenWithMetadata: jobScoped(
  z.object({ cloudJobId: z.number() }),
  'cloudJobId',
).mutation(({ ctx, input }) =>
  refreshGitHubTokenWithMetadata(ctx.auth, input.cloudJobId),
);
```

#### revertPrCommit

Revert a commit in a pull request.

```typescript
revertPrCommit: nonJobProcedure
  .input(
    z.object({
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'Invalid repository format'),
      prNumber: z.number().int().positive(),
      commitSha: z
        .string()
        .regex(/^[0-9a-f]{40}$/, 'Invalid commit SHA - must be 40 characters'),
    }),
  )
  .mutation(async ({ ctx, input }) => revertPrCommit(ctx.auth, input));
```

**Auth**: `nonJobProcedure` — job tokens cannot revert commits

### Scheduled Jobs

#### enqueueSlackPrInactivityCheck

Queue delayed check for PR inactivity in Slack threads.

```typescript
enqueueSlackPrInactivityCheck: jobScoped(
  z.object({
    cloudJobId: z.number(),
    completionText: z.string().optional(),
  }),
  'cloudJobId',
).mutation(({ input }) => enqueueSlackPrInactivityCheck(input));
```

### Job Creation

#### enqueue

Create new work from an auth-token backend caller.

```typescript
enqueue: nonJobProcedure
  .input(cloudTaskSchema)
  .mutation(async ({ ctx, input }) => {
    const launchResult = await enqueueCloudTask(input);
    return { id: launchResult.id, taskId: launchResult.taskId };
  });
```

**Auth**: `nonJobProcedure` — job tokens cannot create new jobs
**Schema**: `cloudTaskSchema` from `@roomote/types`
**Scope**: auth-token callers enqueue work into the single deployment as their user
**Compute provider overrides**: explicit `computeProvider` values are passed through to the cloud job; omitted providers fall through to `DEFAULT_COMPUTE_PROVIDER`
**Launch behavior**: SDK callers use the direct cloud-job enqueue path and receive the immediate response shape `{ id, taskId }`.

## Client Configuration

### Factory Function

`packages/sdk/src/client/index.ts` exports `createClient()` for custom client instances:

```typescript
function resolveApiUrl(baseUrl: string, path: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  return `${normalizedBaseUrl}${normalizedPath}`;
}

export function createClient(options: CreateClientOptions = {}) {
  const { url = process.env.TRPC_URL ?? 'http://localhost:3001', headers } =
    options;

  return createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchLink({
        url: resolveApiUrl(url, '/trpc'),
        transformer: superjson,
        headers: headers ?? (() => ({})),
      }),
    ],
  });
}
```

**Options:**

- `url`: API base URL (defaults to `TRPC_URL` env var or `http://localhost:3001`)
- `headers`: Function returning headers for each request (for auth tokens)

**Example:**

```typescript
const client = createClient({
  url: 'https://app.example.com/_roomote-api',
  headers: async () => {
    const token = await getAuthToken();
    return { Authorization: `Bearer ${token}` };
  },
});

const result = await client.cloudJobs.createSnapshot.mutate({
  cloudJobId: 123,
  sandboxId: 'sandbox-abc',
});
```

### Worker Client

Pre-configured client for worker processes using `AUTH_TOKEN` env var:

```typescript
export const workerClient = createTRPCProxyClient<AppRouter>({
  links: [
    httpBatchLink({
      url: resolveApiUrl(
        process.env.TRPC_URL ?? 'http://localhost:3001',
        '/trpc',
      ),
      transformer: superjson,
      headers: () =>
        process.env.AUTH_TOKEN
          ? { Authorization: `Bearer ${process.env.AUTH_TOKEN}` }
          : {},
    }),
  ],
});
```

Workers import this as `client`:

```typescript
import { client } from '@roomote/sdk/client';

const job = await client.cloudJobs.dequeue.mutate({ cloudJobId: 456 });
```

### Package Exports

`@roomote/sdk` currently publishes these entry points:

- `@roomote/sdk` — aggregate `sdk` object and shared types
- `@roomote/sdk/client` — client helpers (`createClient`, `workerClient`)
- `@roomote/sdk/server` — server router and server-side utilities

There are no published `@roomote/sdk/<domain>` subpath exports.

### Superjson Transformer

Both client and server use `superjson` transformer for serializing:

- `Date` objects
- `undefined` values
- `Map`, `Set`, `BigInt`

This enables passing complex types between backend services without manual serialization.

## Public API Pattern

Source-level wrapper modules in `packages/sdk/src/<domain>.ts` typically provide one or more of:

1. **Type exports**: Infer output types from router procedures
2. **Convenience functions**: Named exports wrapping tRPC client calls
3. **Re-exported client**: Uses `workerClient` by default (via `packages/sdk/src/client.ts`)

### Example: packages/sdk/src/cloud-jobs.ts

```typescript
import { type AppRouterInput, type AppRouterOutput, client } from './client';

// Type exports
export type CloudJob = NonNullable<
  AppRouterOutput['cloudJobs']['findFirstById']
>;

export type DequeuedCloudJob = NonNullable<
  AppRouterOutput['cloudJobs']['dequeue']
>;

// Convenience functions
export const findFirstById = (
  cloudJobId: AppRouterInput['cloudJobs']['findFirstById'],
) => client.cloudJobs.findFirstById.query(cloudJobId);

export const update = (options: AppRouterInput['cloudJobs']['update']) =>
  client.cloudJobs.update.mutate(options);

export const dequeue = (options: AppRouterInput['cloudJobs']['dequeue']) =>
  client.cloudJobs.dequeue.mutate(options);

export const done = (options: AppRouterInput['cloudJobs']['done']) =>
  client.cloudJobs.done.mutate(options);
```

### Usage in Worker Processes

```typescript
import { CloudTaskStatus } from '@roomote/types';
import { sdk } from '@roomote/sdk';

// Type-safe with inferred input/output
const job = await sdk.cloudJobs.dequeue({ cloudJobId: 123 });

if (!job) {
  throw new Error('No job available to dequeue');
}

await sdk.cloudJobs.update({
  id: job.id,
  status: CloudTaskStatus.IN_PROGRESS,
  taskPhase: 'cloning-repository',
});

await sdk.cloudJobs.done({
  id: job.id,
  status: CloudTaskStatus.Completed,
});
```

### Unified SDK Export

`packages/sdk/src/index.ts` aggregates all wrapper modules:

```typescript
const sdk = {
  auth,
  githubInstallations,
  slackInstallations,
  linearInstallations,
  repositories,
  cloudJobs,
  environments,
  mcpConnections,
  userApiKeys,
};

export { sdk };
```

**Usage:**

```typescript
import { sdk } from '@roomote/sdk';

const environments = await sdk.environments.listEnvironments();
const job = await sdk.cloudJobs.dequeue({ cloudJobId: 123 });
```

## Key Files Reference

### Router Layer

- `packages/sdk/src/server/routers/app.ts` — Main router aggregation
- `packages/sdk/src/server/routers/cloud-jobs.ts` — Job lifecycle router (most critical)
- `packages/sdk/src/server/routers/cloud-agents.ts` — Agent management
- `packages/sdk/src/server/routers/environments.ts` — Environment configuration
- `packages/sdk/src/server/routers/repositories.ts` — Repository access
- `packages/sdk/src/server/routers/auth.ts` — Token creation and validation
- `packages/sdk/src/server/routers/github-installations.ts` — GitHub App management
- `packages/sdk/src/server/routers/slack-installations.ts` — Slack integration
- `packages/sdk/src/server/routers/linear-installations.ts` — Linear integration
- `packages/sdk/src/server/routers/mcp-connections.ts` — MCP server connections
- `packages/sdk/src/server/routers/user-api-keys.ts` — API key management

### Middleware & Infrastructure

- `packages/sdk/src/server/trpc.ts` — tRPC setup, context, auth middleware
- `packages/sdk/src/client/index.ts` — Client factory and worker client
- `packages/sdk/src/types.ts` — Type re-exports (AppRouter, AppRouterInput, AppRouterOutput)

### Public API Wrappers

- `packages/sdk/src/cloud-jobs.ts` — CloudJob types and convenience functions
- `packages/sdk/src/environments.ts` — Environment types and functions
- `packages/sdk/src/repositories.ts` — Repository types and functions
- `packages/sdk/src/cloud-agents.ts` — CloudAgent convenience functions
- `packages/sdk/src/auth.ts` — Auth convenience functions
- `packages/sdk/src/github-installations.ts` — GitHub integration wrapper
- `packages/sdk/src/slack-installations.ts` — Slack integration wrapper
- `packages/sdk/src/linear-installations.ts` — Linear integration wrapper
- `packages/sdk/src/mcp-connections.ts` — MCP connection wrapper
- `packages/sdk/src/user-api-keys.ts` — API key wrapper
- `packages/sdk/src/index.ts` — Unified SDK export

### Server Integration

- `apps/api/src/index.ts` — Hono server serving tRPC at `/trpc`

## Authorization Summary

| Procedure Type             | Job Tokens | Auth Tokens | Scope Enforcement                                                                                                                                                                                   |
| -------------------------- | ---------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authenticatedProcedure`   | ✅ Allowed | ✅ Allowed  | None                                                                                                                                                                                                |
| `nonJobProcedure`          | ❌ Blocked | ✅ Allowed  | N/A                                                                                                                                                                                                 |
| `jobScoped(schema, field)` | ✅ Allowed | ✅ Allowed  | Job tokens: extracted input ID must match token `cloudJobId` and the token's `userId` claim must match the persisted `cloud_jobs` row<br>Auth tokens: target job must be readable by the token user |

**Token Types:**

- **Job Token** (`t: 'cj'`): Scoped to a single `cloudJobId`, used by worker processes
- **Auth Token** (`t: 'auth'`): User/org session token, used by API consumers

All tokens signed with ES256 using `JOB_AUTH_PRIVATE_KEY`. SDK routes must not
trust signed job-token claims by themselves for cloud-job ownership. Any route
using `jobScoped()` or a job-token-only guard must bind the token back to the
persisted job row before returning metadata, environment variables, GitHub
tokens, runtime env, Slack/Linear message queues, or any other job-scoped data.
