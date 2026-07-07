---
title: Monorepo Structure
status: active
last_reviewed: 2026-07-05
owner: engineering
summary: Technical documentation of the pnpm monorepo layout covering apps, packages, Turborepo orchestration, ESM conventions, and tool management.
---

# Monorepo Structure

Roomote uses a **pnpm monorepo** with **Turborepo** orchestration. Workspaces live in `apps/` and `packages/`, configured via `pnpm-workspace.yaml`. Most runtime-facing packages use ESM, while some tooling/config packages omit an explicit `"type": "module"` field. Workspace packages are private.

## Tool Versions

Defined in `.tool-versions` and managed via [mise](https://mise.jdx.dev/):

- **Node.js**: 22.17.1
- **pnpm**: 10.29.3

Package manager is enforced via `packageManager` field in root `package.json`: `"pnpm@10.29.3"`.

Supported Node.js versions: `22.x || 24.x` (engines field in root package.json).

## Workspace Configuration

### pnpm-workspace.yaml

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
minimumReleaseAge: 10080
blockExoticSubdeps: true
```

Defines two workspace directories:

- **apps/**: User-facing applications and services
- **packages/**: Shared libraries and utilities

The workspace also sets `minimumReleaseAge: 10080`, which tells pnpm to avoid
resolving package versions published within the last 7 days. The policy applies
to dependency resolution across the whole workspace, including transitive
dependencies, unless a package is added to an explicit allowlist later. The
workspace also enables `blockExoticSubdeps: true` as an additional pnpm
supply-chain guard.

External upstream mirrors that are intentionally not pnpm workspaces can still
live inside app-owned subdirectories when needed, but they are not part of the
direct workspace inventory unless the repo explicitly maintains them as a
first-class surface.

For the canonical docs owner of each direct `apps/*` and `packages/*` workspace, see [Workspace Surface Ownership](./workspace-surface-ownership.md).

### turbo.json

Turborepo pipeline configuration defining tasks:

- **format**: Auto-format code with Prettier
- **format:check**: Verify Prettier formatting
- **lint**: ESLint validation (max warnings: 0)
- **check-types**: TypeScript type checking
- **test**: Run Vitest tests
- **build**: Production builds
- **clean**: Remove build artifacts

**Global pass-through environment variables** (available to all tasks):

- `MISE_DATA_DIR`, `MISE_CACHE_DIR`
- `SKIP_ENV_VALIDATION`

## Apps

Application-level services that run as independent processes. Located in `apps/`.

| App               | Port  | Purpose                                                                                  |
| ----------------- | ----- | ---------------------------------------------------------------------------------------- |
| **web**           | 13000 | Next.js 16 frontend dashboard (React 19, Tailwind, tRPC client)                          |
| **docs**          | -     | Self-contained Mintlify public docs site (`@roomote/docs`), published at docs.roomote.dev |
| **api**           | 13001 | Hono API server - tRPC backend + webhook handlers (GitHub, Slack, Linear)                |
| **controller**    | -     | Job orchestrator - dequeues from Redis, spawns workers on Docker, Modal, Daytona, or E2B |
| **worker**        | -     | Task execution runtime - runs in containers, spawns VSCode with AI extension via IPC     |
| **bullmq**        | 13002 | BullMQ queue dashboard + scheduled jobs (heartbeat, snapshot refresh)                    |
| **preview-proxy** | 18081 | Routes HTTP/WebSocket to sandbox preview ports via stable URLs                           |
| **dev**           | -     | Local dev CLI - database seeding, local seeding, GitHub bootstrap                        |

### App Details

#### web (@roomote/web)

**Framework**: Next.js 16 with React 19
**UI**: Tailwind CSS, Radix UI components, shadcn/ui patterns
**Data Fetching**: tRPC via `@trpc/tanstack-react-query`
**Auth**: Better Auth/local admin
**Key Features**:

- Task dashboard and job monitoring
- Real-time terminal output (xterm.js)
- Storybook component library (`pnpm storybook`)

**Path Alias**: `@/*` maps to `./src/*`

#### docs (@roomote/docs)

**Framework**: [Mintlify](https://mintlify.com) (`mint` CLI)
**Purpose**: The public, user-facing product documentation site published at [docs.roomote.dev](https://docs.roomote.dev).
**Key Points**:

- Self-contained: no dependency on `@roomote/web`, its routes, MDX compilation, or docs assets. Content, navigation, branding, and fonts all live in `apps/docs`.
- `docs.json` is the navigation, theme, and branding source of truth; pages are top-level MDX files.
- Scripts: `dev` (`mint dev`) and `check-links` (`mint broken-links`).
- See [Public Docs Site](../features/public-docs-site.md) for the full ownership and content-boundary policy.

#### api (@roomote/api)

**Framework**: Hono v4
**Server**: `@hono/node-server`
**Responsibilities**:

- tRPC backend router (served at `/trpc`)
- Webhook handlers for GitHub, Slack, Linear
- Job authentication via JWT tokens

**Build**: `tsup` → outputs to `dist/`

#### controller (@roomote/controller)

**Job Orchestration Engine**

Dequeues jobs from Redis (BullMQ) and spawns worker processes on configured compute providers:

- Docker (local dev and single-host self-host default)
- Modal, Daytona, E2B (hosted)

**No HTTP server** - runs as background process.

#### worker (@roomote/worker)

**Task Execution Runtime**

Runs inside containers (Docker or a hosted provider sandbox). Key responsibilities:

- Claims cloud jobs from database
- Prepares workspace (git clone, install dependencies)
- Spawns VSCode server with Roomote extension
- Communicates via IPC (Agent Client Protocol)
- Streams task state, logs, and callbacks through the Roomote runtime stack

**Exports**: `"./sandbox-router"` for the in-sandbox server tRPC router

#### bullmq (@roomote/bullmq)

**Queue Dashboard + Scheduler**

- BullBoard UI for monitoring Redis queues (port 13002)
- Scheduled jobs: heartbeat checks, snapshot refresh
- Uses `@bull-board/hono` adapter

#### preview-proxy (@roomote/preview-proxy)

**Preview URL Router**

Proxies HTTP/WebSocket traffic to worker preview ports using stable URLs. Enables accessing `localhost:3000` running inside a worker sandbox via a public URL.

#### dev (@roomote/dev)

**Local Development Utilities**

CLI commands:

- `pnpm dev` - Starts PM2 process manager with all services
- Local seed creates the built-in user and organization
- `bootstrap:github-installation` - Configures GitHub App
- `seed:tasks`, `seed:preview` - Test data generators

## Packages

Shared libraries consumed by apps. Located in `packages/`. All use TypeScript source imports (no build step required for internal consumption).

### Core Packages

| Package               | Purpose                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------- |
| **db**                | Drizzle ORM schema, PostgreSQL access, fixtures, and migrations                         |
| **auth**              | JWT token generation and validation for job/auth/preview flows                          |
| **sdk**               | tRPC routers for cloudJobs, environments, repositories, and integrations                |
| **cloud-agents**      | Cloud-agent workflows, job queueing, and LLM routing logic                              |
| **compute-providers** | Abstracts execution targets (Docker, Modal, Daytona, E2B) - factory pattern             |
| **types**             | Shared TypeScript types (CloudTaskType, CloudTaskStatus, EnvironmentConfig)             |
| **redis**             | Connection factory for BullMQ, socket.io adapter, job queue                             |
| **env**               | Zod-validated env vars via `@t3-oss/env-nextjs`; application code should prefer `Env.X` |
| **feature-flags**     | Redis-backed feature flag evaluation with caching; has `/server` sub-export             |

### Integration Packages

| Package    | External Service                         |
| ---------- | ---------------------------------------- |
| **github** | GitHub API wrapper using Octokit         |
| **slack**  | Slack Web API wrapper (`@slack/web-api`) |
| **linear** | Linear SDK wrapper (`@linear/sdk`)       |
| **email**  | Email delivery via Loops                 |

### Config Packages

| Package               | Purpose                                                           |
| --------------------- | ----------------------------------------------------------------- |
| **config-eslint**     | Shared ESLint configuration                                       |
| **config-typescript** | Shared TypeScript configuration (strict mode, bundler resolution) |

### Package Exports

Many packages use **sub-exports** for code splitting:

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./server": "./src/server.ts"
  }
}
```

**Examples**:

- `@roomote/db` - client-safe subset
- `@roomote/db/server` - full server API (db client, schema, factories, operators)
- `@roomote/sdk/client` - tRPC client
- `@roomote/sdk/server` - tRPC router definitions
- `@roomote/feature-flags/server` - server-side flag evaluation
- `@roomote/cloud-agents/server` - server-only job queue operations
- `@roomote/auth/client` - worker-safe token validation helpers
- `@roomote/slack/client` - worker-safe Slack helpers
- `@roomote/linear/client` - worker-safe Linear helpers

For `apps/worker`, treat these export splits as a hard runtime boundary:

- prefer safe roots or explicit worker-safe subpaths
- do not import workspace `./server` entrypoints
- if a helper only exists on a mixed or server-only surface, add a safe export
  or route the operation through `@roomote/sdk`

The worker is a Roomote-managed task runtime, not a Roomote app runtime. It is
supposed to stay focused on sandbox preparation, workspace and service setup,
runtime env construction, harness startup, task callbacks, MCP wiring, and
snapshot or sandbox control. That means some Roomote platform coupling is
expected for cloud jobs, auth tokens, preview URLs, task state, Slack or Linear
callbacks, and similar runtime concerns, but direct coupling to Roomote's
server-only internals is a design smell.

When changing `apps/worker`, follow these additional rules:

- prefer `@roomote/types`, `@roomote/sdk/client`, and other explicit
  worker-safe root or `./client` exports
- do not import `@roomote/env`, `@roomote/db/server`, `@roomote/redis`, or any
  workspace `./server` entrypoint into worker runtime code
- do not add direct database or Redis access just because the data is
  convenient upstream; use the existing task payload or an SDK call instead
- keep worker-only secrets out of child-process environments and keep nested
  sandbox behavior in mind when touching env propagation
- if the worker needs a new shared helper, add a worker-safe export or route
  the operation through `@roomote/sdk/client` instead of reaching across the
  runtime boundary

### Key Package Details

#### @roomote/db

**ORM**: Drizzle v0.45
**Database focus**: PostgreSQL schema/client utilities and encrypted-column helpers
**Schema**: Single flat file at `packages/db/src/schema.ts`
**Exports**:

- `.` - Client-safe (types, schemas)
- `./server` - Full API (db client, factories, migrations)

**Encrypted columns**: Custom Drizzle types `encryptedJson()` and `encryptedText()` - decrypt via `decryptSecrets()`/`decryptText()`

**Test Factories**: fishery + faker - `userFactory`, `orgFactory`, `taskFactory`, `cloudJobFactory`, etc.

**Migration workflow**:

```bash
pnpm db:generate  # Generate migration from schema changes
pnpm db:migrate   # Apply pending migrations
pnpm db:push      # Push schema directly (dev only, bypasses migrations)
```

#### @roomote/sdk

**tRPC Backend API**

Server router: `packages/sdk/src/server/routers/app.ts`
Client: `packages/sdk/src/client/index.ts` (httpBatchLink + superjson)

**Authentication middleware**:

- `authenticatedProcedure` - requires valid auth token
- `nonJobProcedure` - requires non-job auth token
- `jobScoped(schema, extractJobId)` - enforces job-token ID matching and auth-token same-org scoping for cloud-job resources

**Public API wrappers**: Each router gets a typed module in `packages/sdk/src/<domain>.ts` using `AppRouterInput`/`AppRouterOutput`.

#### @roomote/cloud-agents

**AI Integration Layer**

- LLM router for task and follow-up routing
- MCP (Model Context Protocol) policy definitions
- Redis-backed cloud-job queue operations
- Vercel AI SDK integration (`ai` package)

**Exports**:

- `.` - Client-safe types
- `./server` - Job queue, routing/workflow server utilities
- `./router-mcp-policy` - MCP policy schema

**Evaluation**: Includes promptfoo-based LLM router evals (`pnpm eval:router`)

#### @roomote/compute-providers

**Worker Deployment Abstraction**

Factory pattern for spawning workers on supported compute targets:

- `ModalClient` (`provider: 'modal'`) and `E2bClient` (`provider: 'e2b'`) - ephemeral sandboxes with snapshot/resume support
- `DaytonaClient` (`provider: 'daytona'`) - hosted fresh-run sandboxes
- `DockerClient` (`provider: 'docker'`) - local/single-host containers

#### @roomote/env

**Environment Variable Validation**

Uses `@t3-oss/env-nextjs` with Zod schemas. Roomote local development reads unencrypted `.env.local` overrides; package test commands still use dotenvx for `.env.test`.

**Usage**: Always import `Env` from `@roomote/env`:

```typescript
import { Env } from '@roomote/env';
// ✅ Correct: Env.DATABASE_URL
// ⚠ Prefer avoiding direct process.env reads in app/package code.
```

Verify setup: `pnpm --filter @roomote/env test`

#### @roomote/auth

**JWT Token Management**

Two token types (ES256 signed with `JOB_AUTH_PRIVATE_KEY`):

1. **Job Token** (`t: 'cj'`): Per cloud job, `sub` = `cloudJobId`
2. **Auth Token** (`t: 'auth'`): Per user session, contains `userId`

**Utilities**:

- `createJobToken({ cloudJobId, userId, timeoutMs })` - Generate worker job token
- `createAuthToken({ userId, timeoutMs })` - Generate user auth token
- `validateJobToken(token)` - Decode + validate job token

#### @roomote/feature-flags

**Redis-backed Feature Flags**

- Cached evaluation (TTL: 5 minutes)
- Deployment-level and user-level flags
- Flag values resolved from cached `metadata` on `deployment_settings` and `users`

**Usage**:

```typescript
import {
  FeatureFlag,
  getFeatureFlagEvaluator,
} from '@roomote/feature-flags/server';
import { getRedis } from '@roomote/redis';

const evaluator = getFeatureFlagEvaluator(getRedis());
const enabled = await evaluator.evaluate(FeatureFlag.PrPreviewLink, {
  isDeploymentContext: true,
});
```

## ESM Modules

Most workspace packages declare `"type": "module"`.

Current notable exceptions include `apps/web` and `packages/config-typescript`, which omit an explicit `"type"` field.

- TypeScript source imports are generally extensionless (bundler resolution)
- CommonJS is not used in runtime package source
- Top-level `await` is available in ESM contexts

## Internal Package Conventions

### No Build Step for Consumption

Internal packages generally expose TypeScript source through `exports` (and in many cases `main`/`types`) without requiring a prebuild for workspace consumption:

```json
{
  "main": "./src/index.ts",
  "types": "./src/index.ts"
}
```

This means:

- Consuming apps import TypeScript directly
- No separate build/dist directory needed
- Changes are instantly visible (no rebuild required)

**Exception**: Apps like `api`, `worker`, `controller` build via `tsup` for deployment.

### Import Conventions

**Web app** (`@roomote/web`):

- Use `@/*` path alias for internal imports
- Maps to `./src/*` via tsconfig `paths`

**Other packages**:

- Relative imports: `import { foo } from './lib/foo'`
- Workspace imports: `import { db } from '@roomote/db/server'`

**Sub-exports**: Always specify the sub-export when available:

- ✅ `import { db } from '@roomote/db/server'`
- ❌ `import { db } from '@roomote/db'` (may not expose server API)

## Process Management

Local development uses **PM2** (process manager).

### Starting All Services

```bash
pnpm dev  # Runs @roomote/dev which spawns PM2
```

This starts (via `ecosystem.config.js`):

- roomote-api (port 13001)
- roomote-web (port 13000)
- roomote-preview-proxy (port 18081)
- roomote-bullmq (port 13002)
- roomote-controller (15s startup delay)
- roomote-worker-release-watcher (monitors worker release builds)

The BullMQ and controller processes are local runtime plumbing for executing
tasks. They do not imply that Roomote exposes the hosted product work-queue
route.

**Ngrok mode**: If `NGROK_ENABLED=true`, also starts ngrok tunnels for `roomote-api`, `roomote-web`, and `roomote-preview-proxy`.

### PM2 Commands

```bash
pm2 status              # List all processes
pm2 logs [name]         # Tail logs for a service
pm2 restart [name]      # Restart a service
pm2 delete roomote-api roomote-web roomote-preview-proxy roomote-bullmq roomote-controller roomote-worker-release-watcher
```

**Logs location**: `./logs/` directory (e.g., `logs/web.log`, `logs/api-error.log`)

### ecosystem.config.js

PM2 app definitions:

```javascript
const app = (name, opts = {}) => ({
  name,
  script: 'pnpm',
  args: `--filter @roomote/${name} dev`,
  log_file: `./logs/${name}.log`,
  error_file: `./logs/${name}-error.log`,
  out_file: `./logs/${name}-out.log`,
  watch: false,
  autorestart: true,
  max_restarts: 5,
  min_uptime: '10s',
  env,
  ...opts,
});
```

**Environment injection**: Dynamically builds `env` object with ngrok URLs if `NGROK_ENABLED=true`.

## Key Configuration Files

| File                                   | Purpose                                                |
| -------------------------------------- | ------------------------------------------------------ |
| `pnpm-workspace.yaml`                  | Workspace package definitions                          |
| `turbo.json`                           | Turborepo pipeline tasks and cache config              |
| `.tool-versions`                       | Repo-local tool version pinning (Node.js, pnpm)        |
| `package.json` (root)                  | Workspace scripts, package manager, engine constraints |
| `ecosystem.config.js`                  | PM2 process definitions                                |
| `.env.local`                           | Local development overrides and integration secrets    |
| `.env.test`                            | Test environment variables (written by env setup)      |
| `packages/config-typescript/base.json` | Base TypeScript config used by workspace packages      |
| `tsconfig.json` (root)                 | Root TypeScript config for repository scripts          |
| `.prettierrc.json`                     | Code formatting rules (single quotes, trailing commas) |
| `eslint.config.mjs`                    | Root ESLint configuration (uses shared config package) |

## TypeScript Configuration

**Base config**: `packages/config-typescript/base.json`

Key settings:

- `strict: true` - All strict checks enabled
- `noUncheckedIndexedAccess: true` - Array/object index access may return `undefined`
- `moduleResolution: "Bundler"` - Modern bundler-compatible resolution
- `target: "ES2022"` - Modern JavaScript features
- `module: "ESNext"` - ESM modules

**Per-package tsconfig.json**: Extends base config and adds `paths` for workspace dependencies.

## Dependency Management

### Workspace Protocol

Internal packages use `workspace:^` protocol:

```json
{
  "dependencies": {
    "@roomote/db": "workspace:^",
    "@roomote/env": "workspace:^"
  }
}
```

This ensures:

- Always uses local workspace version
- Hot reloading in dev (no rebuild needed)
- Version bumps don't require updates

### pnpm Overrides

Root `package.json` keeps `pnpm.overrides` as a narrow exception surface for dependency fixes that cannot be held by a direct-owner upgrade or by refreshing the lockfile against the owner's existing semver range.

Before adding a new override for a security cleanup:

1. Upgrade the direct dependency owner when the vulnerable package is reached from a manifest we control.
2. If the owning package already declares a safe semver range, remove the candidate override and regenerate the lockfile to confirm pnpm still resolves the patched version naturally.
3. Add or keep a root override only when the current owner range cannot land the safe version by itself. Path-specific selectors should stay rare and point at the exact owner that still needs help.

The current durable exception is `jayson>uuid`, which stays pinned at the root because the `@solana/web3.js` chain still pulls `jayson` on a `uuid` range that cannot reach the patched major on its own.

Typical overrides look like this:

```json
{
  "pnpm": {
    "overrides": {
      "esbuild": ">=0.25.0",
      "vite": ">=7.3.2 <8",
      "jayson>uuid": "11.1.1",
      "zod": "^3.25.76"
    }
  }
}
```

### Peer Dependency Rules

```json
{
  "pnpm": {
    "peerDependencyRules": {
      "allowAny": ["@smithy/node-http-handler", "google-auth-library"]
    }
  }
}
```

Suppresses warnings for transitive peer dependencies.

## Code Quality Tools

### Prettier

**Auto-format**: `pnpm format`
**Check only**: `pnpm format:check`

**Style**:

- Single quotes
- Trailing commas
- No tabs
- Line width: 80

**Integration**: Runs via `lint-staged` on pre-commit hook.

### ESLint

**Run**: `pnpm lint` (runs `pnpm format:check` first, then lint across all workspaces via Turbo)
**Plugin**: `eslint-plugin-only-warn` - all rules are warnings, but CI fails with `--max-warnings=0`

### Knip

**Unused code detection**: `pnpm knip`

Excludes: `exports`, `nsExports`, `types`, `nsTypes`

### Husky Pre-commit Hooks

**pre-commit**:

1. Blocks direct commits to `main`
2. Runs `lint-staged` (Prettier)
3. Runs `pnpm lint` (which rechecks formatting before linting)

**pre-push**:

1. Blocks direct pushes to `main`
2. Runs `pnpm lint:fast`
3. Runs `pnpm check-types:fast`
4. Runs `pnpm knip`

**IMPORTANT**: Do not use `--no-verify` to bypass hooks. Fix the root cause instead (run `pnpm format`, fix lint errors, resolve type errors).

## Testing

**Framework**: Vitest with globals mode
**Test files**: `*.test.ts`, `*.client.test.ts`
**Database**: `pnpm test` pushes schema to the test DB first via `@roomote/db db:push:test`; individual tests manage their own fixture/state needs

**Run all tests**:

```bash
pnpm test  # Includes db:push:test + turbo test --concurrency=1
```

**Run package-specific tests**:

```bash
pnpm --filter @roomote/db test
pnpm exec dotenvx run -f .env.test -- pnpm --filter @roomote/worker exec vitest run src/path/to/file.test.ts
```

**Test environments** (web app only):

- `server`: Node.js (default for `*.test.ts`)
- `client`: jsdom (for `*.client.test.ts` and `hooks/`/`components/`)

## Build Commands

### Development

```bash
mise install              # Install tool versions
pnpm install             # Install dependencies
pnpm infra:up            # Start Postgres + Redis + MinIO + run migrations
pnpm db:up               # Start Postgres + Redis + MinIO + run migrations
pnpm dev                 # Start all services (PM2)
```

### Production Builds

```bash
pnpm build               # Build all apps via Turbo
```

Individual app builds:

```bash
pnpm --filter @roomote/api build
pnpm --filter @roomote/web build
```

### Cleanup

```bash
pnpm clean               # Remove Turbo/build artifacts plus logs, worker data, and cached release archives
pnpm db:down             # Stop database and artifact storage containers
```

## Common Workflows

### Adding a New Package

1. Create directory in `packages/<name>/`
2. Add `package.json`:
   ```json
   {
     "name": "@roomote/<name>",
     "private": true,
     "type": "module",
     "main": "./src/index.ts",
     "types": "./src/index.ts"
   }
   ```
3. Add `tsconfig.json` extending `@roomote/config-typescript/base.json`
4. Run `pnpm install` to register workspace

### Adding a New App

1. Create directory in `apps/<name>/`
2. Add `package.json` with appropriate build scripts
3. Add PM2 entry to `ecosystem.config.js` (if needed)
4. Update README with port allocation (if applicable)

### Filtering by Package

```bash
pnpm --filter @roomote/web dev
pnpm --filter @roomote/db db:push
pnpm --filter @roomote/api test
```

**Multiple filters**:

```bash
pnpm --filter @roomote/web --filter @roomote/api build
```

**Filter patterns**:

- `--filter './packages/*'` - All packages
- `--filter './apps/*'` - All apps
- `--filter '...@roomote/web'` - web + all dependencies

## References

- **pnpm workspaces**: https://pnpm.io/workspaces
- **Turborepo**: https://turbo.build/repo/docs
- **mise**: https://mise.jdx.dev/
- **PM2**: https://pm2.keymetrics.io/docs/usage/quick-start/
