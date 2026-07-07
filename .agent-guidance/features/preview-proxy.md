---
title: Preview Proxy
status: active
last_reviewed: 2026-07-03
owner: engineering
summary: Technical documentation of the preview proxy service that routes HTTP and WebSocket traffic to Roomote-managed sandbox surfaces and named preview ports via stable URLs.
---

# Preview Proxy

The preview proxy (`apps/preview-proxy`) is a Node.js HTTP/WebSocket reverse proxy that provides stable, authenticated URLs for Roomote-managed sandbox surfaces such as the sandbox server plus any named preview ports configured on an environment. It sits between users and sandbox instances across Docker-, Modal-, Daytona-, and E2B-backed jobs, handling authentication, routing, and preview widget injection.

## Architecture

### Request Flow

```
User Browser
    ↓
Preview Proxy (preview.roomote.run)
    ↓ [authentication + routing]
    ↓
Sandbox Instance (Modal/Docker/Daytona/E2B)
    ↓
Roomote Surface (SANDBOX_SERVER, named preview ports, optional WEB/API, legacy EDITOR)
```

### Core Components

- **Main Server** (`src/index.ts`): HTTP/WebSocket server on port 8081 (configurable via `PORT`)
- **URL Parser** (`src/lib/url-parser.ts`): Extracts taskId and port name from subdomain
- **Resolver** (`src/services/resolver.ts`): Maps taskId+port → sandbox URL, resolves auth requirements
- **Auth Service** (`src/services/auth.ts`): Validates preview tokens (JWT) against organization/user scope
- **HTTP Handler** (`src/handlers/http.ts`): Processes HTTP requests with auth checks and proxying
- **WebSocket Handler** (`src/handlers/websocket.ts`): Handles WebSocket upgrades with auth validation
- **Proxy** (`src/lib/proxy.ts`): http-proxy wrapper for forwarding requests/connections

## URL Scheme

### Standard Format

```
https://{taskId}-{portName}.{domain}
```

- **taskId**: 13-character base36 identifier (e.g., `20imtw24sm6hv`)
- **portName**: URL-safe surface slug (lowercase, hyphens), e.g., `web`, `sandbox-server`
- **domain**: Base domain (e.g., `preview.roomote.run`)

**Example**: `https://20imtw24sm6hv-web.preview.roomote.run`

### Port Name Mapping

Port names in URLs are lowercase with hyphens. They map to uppercase-underscore storage keys:

| URL Slug         | Storage Key      | Description                                             |
| ---------------- | ---------------- | ------------------------------------------------------- |
| `sandbox-server` | `SANDBOX_SERVER` | Sandbox control API                                     |
| `web`            | `WEB`            | Ordinary named port slug when an environment uses `WEB` |
| `api`            | `API`            | Ordinary named port slug when an environment uses `API` |

Conversion uses `slugToPortKey()` from `@roomote/types`.

### Nested URLs (Recursive Preview-Proxy)

When a sandbox runs its own preview-proxy instance (for previewing apps that themselves deploy sandboxes), nested URLs are supported:

```
https://{inner-id}-{inner-port}-{outer-id}-{outer-port}.preview.roomote.run
```

**Example**: `https://abc123def4567-web-20imtw24sm6hv-preview.preview.roomote.run`

- **Outer sandbox** (`20imtw24sm6hv-preview`) runs a preview-proxy
- **Inner sandbox** (`abc123def4567-web`) is proxied through the outer one

The outer preview-proxy must have `wildcard_prefix: true` on its port config to accept nested requests.

### Inner Mode (Suffix Stripping)

When a preview-proxy runs inside a sandbox (inner mode), it operates with `PREVIEW_PROXY_SUBDOMAIN_SUFFIX` set:

```bash
PREVIEW_PROXY_SUBDOMAIN_SUFFIX=20imtw24sm6hv-preview
PREVIEW_AUTH_COOKIE_NAME=preview_auth_inner
```

The suffix is stripped from incoming hostnames before parsing:

```
20imtw24sm6hv-web-r4nje6w8ab123-preview.preview.roomote.run
→ strips "-r4nje6w8ab123-preview"
→ parses as "20imtw24sm6hv-web.preview.roomote.run"
```

This allows inner proxies to handle their own routing without conflicting with the outer proxy's URL namespace.

## Surface Mapping and Resolution

### Resolution Process

`resolveRequest(identifier, portName)` in `src/services/resolver.ts`:

1. **Lookup CloudJob** by `taskId` (most recent if multiple resumes exist)
2. **Validate the requested surface** against the Roomote-managed surface set
3. **Extract Sandbox URL** from `cloudJob.machineDomains[portKey]`
4. **Return Resolution** with auth requirements, sandbox URL, and proxy status

### System and Named Ports

`SANDBOX_SERVER` is always a supported preview-proxy surface. It is proxied so
networked Docker workers can keep internal Docker DNS names in
`cloudJob.machineDomains` while browsers use a public preview-proxy URL. It
does not require preview-cookie auth because sandbox RPCs authenticate with the
task job token. `EDITOR` remains
routable only as a legacy compatibility surface for older cloud jobs.

Environment-defined `config.ports` are also routable through preview-proxy,
including ports named `WEB` or `API`. Those names no longer carry built-in
system semantics.

Human-facing preview ports only publish when live previews are effectively
available for the deployment:

- runtime preview environment variables validate successfully
- `deployment_settings.metadata.previews_enabled !== false`
- `environment.config.previews_enabled !== false`

Environment-defined `config.ports` are also routable through preview-proxy.
Unlike the system ports, these named ports are meant for human-facing app
previews and can opt into more flexible auth/routing rules:

- `unauthenticated: true` skips preview-proxy auth entirely for that port
- `proxied: false` returns a post-auth redirect to the sandbox's direct domain
- `auth_bypass_paths` allows selected paths to skip the preview auth check
- `wildcard_prefix: true` allows nested preview-proxy host prefixes
- `subdomain` overrides the default slug derived from the port name

When the cloud job records a `primaryPortName`, the web dashboard uses that
named port as the default `Live Preview` target and as the default external
preview URL.

## Authentication

### Token-Based Auth (JWT)

Preview auth uses ES256 signed JWTs validated with `PREVIEW_AUTH_PUBLIC_KEY`. Tokens are user-scoped and valid for the current deployment, not job-specific.

**Token Structure** (`@roomote/types` - PreviewTokenContext):

```typescript
{
  userId: string;
  tokenType: 'pt';
  version: 1;
}
```

### Auth Flow

1. **Unauthenticated Request** → redirect to `/api/auth/preview` on main app
2. **User Authenticates** with Better Auth on main app
3. **Main App** generates preview token, redirects to `/auth/callback?token=...&state=...`
4. **Callback Handler** (`src/handlers/auth-callback.ts`):
   - Validates state from Redis (prevents CSRF)
   - Validates token signature
   - Sets `preview_auth` cookie (httpOnly, Secure, SameSite=None, Partitioned)
   - Redirects to original URL
5. **Subsequent Requests** include `preview_auth` cookie → validated against the current authenticated deployment context and requested job

### Cookie Configuration

```typescript
Set-Cookie: preview_auth={token};
  HttpOnly;
  Secure;
  SameSite=None;
  Max-Age=3600;
  Path=/;
  Domain=.<derived from PREVIEW_PROXY_BASE_URL hostname>;
  Partitioned
```

- **Partitioned**: Chrome CHIPS support for cross-site iframes
- **SameSite=None**: Required for iframes from app.roomote.dev
- **Domain**: Derived from `PREVIEW_PROXY_BASE_URL` (`undefined` on localhost)

### Auth Bypass Mechanisms

1. **Header Bypass** (`x-bypass-roomote-auth: {cloudJob.authBypassValue}`) → custom header/cookie bypass. The controller only generates and stores `cloudJob.authBypassValue` for jobs with an eligible exposed preview port, so jobs without those surfaces have no header/cookie bypass value to present.

### Auth-Proxy Defense-in-Depth

Roomote-managed surfaces receive the `preview_auth` cookie for validation at the sandbox level. The cookie is stripped before proxying to non-Roomote backends.

The web dashboard's task-side preview panel still starts from a same-origin auth
endpoint on the main app, but it now uses the generic preview-session
trampoline and named preview ports only. Preview-proxy no longer has any
special-case live-browser or control-handoff logic beyond the standard preview
auth and named-port routing rules.

## HTTP Request Handling

### Request Processing (`src/handlers/http.ts`)

1. **Parse Host** → extract taskId and portName
2. **Resolve Request** → get sandbox URL, auth requirements, port config
3. **Handle Special Cases**:
   - `gone` → sandbox completed, no snapshot → 410 page
   - `resumable` → auto-resume from snapshot → progress page
   - `sandbox_unavailable` → job queued/processing → 503 page
   - `redirect_to_direct` → unproxied port → auth check, then 302 to sandbox URL
   - `not_found` → invalid task/port → try nested fallback (outer mode), else 404
4. **Inline Token** (`?__preview_token=...`) → set cookie, redirect to clean URL
5. **Auth Check** → validate cookie if required
6. **Cookie Filtering**:
   - **Has auth-proxy**: Forward `preview_auth` cookie
   - **No auth-proxy**: Strip `preview_auth` to prevent leakage
7. **Set Forwarding Headers**:
   - `x-roomote-forwarded-host`: Original host (suffix stripped in inner mode)
   - `x-roomote-public-host`: Full public host (nested mode only)
   - `x-roomote-forwarded-proto`: Request protocol (https/http)
   - `x-forwarded-for`, `x-forwarded-proto=https`, `x-forwarded-host`: Standard headers
   - `x-request-id`, `traceparent`: Observability headers
8. **Proxy Request** → forward to `sandboxUrl` via http-proxy

### Nested URL Fallback

When `parseHost()` fails (outer mode only), `tryNestedFallback()` attempts nested URL parsing:

1. Parse host with `parseHostNested()` → extract `outerTaskId` and `outerPortName`
2. Resolve outer sandbox URL for outer port
3. Check if outer port has `wildcard_prefix: true`
4. If yes, proxy to outer sandbox (which will handle inner routing)

This enables multi-level preview topologies without manual configuration.

## WebSocket Proxying

### WebSocket Upgrade (`src/handlers/websocket.ts`)

WebSocket connections follow the same auth and routing logic as HTTP, but with constraints:

- **Cannot redirect** (no HTTP 302 for WebSocket upgrades) → 503 for unproxied ports
- **All async operations complete before proxying** to avoid corrupting WebSocket frames
- **Inline preview tokens** (`?__preview_token=...`) can authenticate ordinary
  preview WebSocket upgrades. Preview-proxy validates the token, injects it
  into the forwarded `preview_auth` cookie for downstream auth-proxy checks,
  and strips the query parameter before proxying upstream
- **Auth failures** → 401, destroy socket
- **Header manipulation**:
  - Strip incoming `x-forwarded-*` headers so downstream layers rebuild forwarding semantics from `x-roomote-*`
  - Origin policy:
    - Preserve browser `origin` for direct auth-proxy WS routes
    - Preserve the preview host for inline-token auth-proxy WebSocket handshakes so strict public-host checks still pass
    - Use sandbox `origin` for wildcard-prefix nested PREVIEW hops
    - In inner suffix mode, restore `origin` to the forwarded public host before proxying to downstream auth-proxy routes
    - For routes without auth-proxy, set `origin` to sandbox URL
  - Add `x-roomote-forwarded-host`, `x-roomote-public-host` (inner mode), and `x-roomote-forwarded-proto` for routing and redirects

### WebSocket Error Handling

- **Non-101 responses** from upstream → log, write HTTP status, destroy socket
- **Socket errors** → log, prevent unhandled exceptions
- **Proxy errors** → destroy socket to avoid 1006 close codes

## HTML Injection (Preview Widget)

### Script Injection (`src/lib/html-injector.ts`)

HTML responses get a preview widget script injected before `</head>`, `</body>`, or at end:

```html
<script src="/rooproxy/inject.js"></script>
```

**Served at** `/rooproxy/inject.js` with `Cache-Control: public, max-age=300`.

### Injection Rules

- **Only HTML responses** (`Content-Type: text/html`)
- **Skip system ports** (SANDBOX_SERVER, legacy EDITOR) → system UIs don't need widgets
- **Skip when suppressed** (`roomote_hide_preview_widget` cookie) → automation clients
- **Handle compression** (gzip, brotli, deflate) → decompress, inject, recompress

### Widget Script (`src/lib/preview-widget.ts`)

Provides:

- **API Base URL** injection (`__ROOMOTE_APP_URL__` placeholder)
- **User-facing controls** (resume sandbox, view logs, etc.)

## Auto-Resume

### Snapshot Auto-Resume (`src/handlers/auto-resume.ts`)

When a sandbox completes but has a valid snapshot, preview-proxy triggers automatic resume:

1. **User requests** completed job URL → `status: 'resumable'`
2. **Auth check** required before resume
3. **Check for existing resume job** (prevent duplicate resumes)
4. **Create SnapshotResume job** via `enqueueCloudTask()`:
   - `sourceSnapshotId` → snapshot to restore
   - `sourceCloudJobId` → original job reference
   - source task/workspace metadata → target task context for the resumed job
5. **Return progress page** with polling endpoint

### Resume Status Endpoint

`/rooproxy/resume-status/{cloudJobId}` provides job status polling:

- **Auth required** (org/user match)
- **Returns** `{ status, error, ready }`
- **Used by** resuming progress page to detect when sandbox is ready

### Snapshot Expiry

Snapshots expire after 7 days (`SANDBOX_SNAPSHOT_EXPIRY_MS`). Expired snapshots return `status: 'gone'` instead of `resumable`.

## Configuration

### Environment Variables (`src/config.ts` + shared `@roomote/env` schema)

| Variable                         | Default                       | Description                                        |
| -------------------------------- | ----------------------------- | -------------------------------------------------- |
| `NODE_ENV`                       | `development`                 | Environment mode                                   |
| `PORT`                           | `8081`                        | Server listen port                                 |
| `ROOMOTE_APP_URL`                | `https://app.roomote.dev`     | Main app URL (for auth redirects)                  |
| `PREVIEW_PROXY_BASE_URL`         | (optional)                    | Base preview URL used for cookie-domain derivation |
| `PREVIEW_AUTH_PUBLIC_KEY`        | (required via `@roomote/env`) | ES256 public key for preview token validation      |
| `JOB_AUTH_PUBLIC_KEY`            | (required via `@roomote/env`) | Shared auth key required by workspace env schema   |
| `PREVIEW_TOKEN_TTL_SECONDS`      | `3600`                        | Preview auth cookie TTL (1 hour)                   |
| `DATABASE_URL`                   | (required)                    | PostgreSQL connection string                       |
| `REDIS_URL`                      | (required)                    | Redis connection string                            |
| `PREVIEW_PROXY_SUBDOMAIN_SUFFIX` | (none)                        | Inner mode suffix (e.g., `20imtw24sm6hv-preview`)  |
| `PREVIEW_AUTH_COOKIE_NAME`       | `preview_auth`                | Cookie name (inner proxies use different name)     |
| `LOG_LEVEL`                      | `info`                        | Pino log level                                     |
| `SENTRY_DSN`                     | (optional)                    | Sentry error tracking                              |

### Domain Validation

The main app's `/api/auth/preview` endpoint validates `redirect_uri` against `PREVIEW_DOMAINS` env var. The preview-proxy itself does NOT perform domain validation — security is enforced at the OAuth callback level.

### Sandbox Dev-Server Origin Allowlisting

Dev servers running inside sandboxes (notably Next.js) block cross-origin requests to internal dev resources (fonts, HMR, overlay assets) unless the preview hostname is allowlisted via `allowedDevOrigins`, which apps derive from `PREVIEW_DOMAINS` (`getAllowedDevOrigins` in `packages/env/src/app-env.ts`). Deployment env vars only include `PREVIEW_DOMAINS` when the deployment persisted preview settings, so the worker's `injectEnvVars` (`apps/worker/src/commands/utils/env-vars.ts`) derives it from the preview-proxy base URL hostname when it is not already provided and writes it into the sandbox shell env alongside the `ROOMOTE_<NAME>_HOST` values. Without this, preview pages load the HTML shell but guarded subresources return 403 and the page renders blank.

### Runtime Config Resolution

Preview-proxy no longer treats `PREVIEW_PROXY_BASE_URL` as a startup-only static setting for cookie scoping. It now reads the shared effective preview runtime config through a short-lived cached loader backed by the deployment env-var store:

- runtime `process.env` still wins when operators set an override directly on the service
- saved deployment preview config is admin-managed through a single preview origin/base URL, and the deployment env store keeps the derived compatibility values (`PREVIEW_DOMAINS`, `ROOMOTE_PREVIEW_DOMAIN`) alongside it for downstream consumers
- preview-proxy keeps a small in-process cache for those resolved values so cookie-domain reads do not hit Postgres on every request

That same resolver is also used by the web app's preview auth/session routes and controller-side preview env construction so the deployment-level Live Previews settings apply consistently across the stack without requiring a redeploy in the common case.

## Key Files Reference

### Core Routing

- `src/index.ts` — HTTP/WebSocket server, top-level request routing
- `src/handlers/http.ts` — HTTP request handler with auth and proxying logic
- `src/handlers/websocket.ts` — WebSocket upgrade handler
- `src/lib/url-parser.ts` — Subdomain parsing (standard, nested, suffix stripping)

### Resolution and Auth

- `src/services/resolver.ts` — TaskId+port → sandbox URL resolution, auth requirements
- `src/services/auth.ts` — Token validation, state management (Redis), auth cookie validation

### Proxying

- `src/lib/proxy.ts` — http-proxy wrapper (HTTP + WebSocket)
- `src/lib/html-injector.ts` — Script tag injection into HTML responses

### Nested Routing

- `src/lib/nested-routing.ts` — Nested URL fallback logic for recursive preview-proxy topologies

### Auto-Resume

- `src/handlers/auto-resume.ts` — Snapshot auto-resume trigger and status polling
- `src/handlers/resume-status.ts` — Resume status endpoint (`/rooproxy/resume-status/{id}`)

### Utilities

- `src/lib/cookies.ts` — Cookie domain calculation, Set-Cookie header builder
- `src/lib/error-pages.ts` — HTML error pages (404, 410, 503, resuming)
- `src/lib/access-log.ts` — Request/response logging for observability
- `src/lib/request-context.ts` — AsyncLocalStorage context for request tracking
- `src/lib/request-correlation.ts` — Distributed tracing correlation (traceparent, tracestate)

### Configuration

- `src/config.ts` — Environment variable schema (Zod validation)
- `Dockerfile` — Container image for local/self-hosted packaging

## Error Handling

### HTTP Status Codes

| Code | Scenario                                                      |
| ---- | ------------------------------------------------------------- |
| 200  | Successful proxy or static resource                           |
| 302  | Auth redirect, inline token redirect, unproxied port redirect |
| 400  | Invalid host format, missing auth params                      |
| 401  | Auth required (non-navigation requests)                       |
| 404  | Task/port not found                                           |
| 410  | Sandbox completed, no snapshot available                      |
| 502  | Proxy error (upstream connection failed)                      |
| 503  | Sandbox unavailable (queued, processing)                      |

### WebSocket Status Codes

| Code | Scenario                              |
| ---- | ------------------------------------- |
| 101  | Successful WebSocket upgrade          |
| 400  | Invalid host format                   |
| 401  | Auth failed                           |
| 503  | Sandbox unavailable or unproxied port |

### Special Pages

- **404** (`render404Page`) — Task or port not found
- **410** (`renderCompletedPage`) — Sandbox completed, no snapshot
- **503** (`renderUnavailablePage`) — Sandbox not ready yet
- **Resuming** (`renderResumingPage`) — Auto-resume in progress with polling script
- **Cookie Blocked** (`renderCookieBlockedPage`) — Browser rejected third-party cookie

## Testing

### Test Structure

- `src/__tests__/integration.test.ts` — End-to-end HTTP/WebSocket flow tests
- `src/lib/__tests__/*.test.ts` — Unit tests for utilities (URL parser, cookies, HTML injection, etc.)

### Test Database

Tests use real PostgreSQL database (via `DATABASE_URL` in `.env.test`). Global setup truncates tables before each run.

### Running Tests

```bash
# All tests (with env vars)
pnpm exec dotenvx run -f .env.test -- pnpm --filter @roomote/preview-proxy exec vitest

# Specific test file
pnpm exec dotenvx run -f .env.test -- pnpm --filter @roomote/preview-proxy exec vitest run src/lib/__tests__/url-parser.test.ts
```

## Deployment

### Local Development

```bash
# Start via PM2 (ecosystem.config.js)
pnpm dev

# Direct run
pnpm --filter @roomote/preview-proxy dev
```

### Dependencies

- **PostgreSQL** — cloudJobs, environments table access
- **Redis** — State storage (OAuth state, redirect nonces)
- **Main App** (`ROOMOTE_APP_URL`) — Auth redirects, preview token issuance

## Security Considerations

### Cookie Security

- **Partitioned cookies** (CHIPS) prevent cross-site tracking while enabling iframe access
- **HttpOnly** prevents JavaScript access to auth tokens
- **Secure** flag required for HTTPS (enforced by SameSite=None)
- **SameSite=None** enables cross-site iframe access from app.roomote.dev

### Token Validation

- **ES256 signature** prevents token forgery
- **Organization scope** prevents cross-org access
- **State nonces** (Redis) prevent CSRF on auth callbacks
- **Redirect nonces** (Redis) prevent forged `__preview_token_redirect` params

### Cookie Filtering

- **Auth-proxy ports**: Forward `preview_auth` for defense-in-depth validation
- **Non-auth-proxy ports**: Strip `preview_auth` to prevent leakage to app backends

### Origin Validation

- **Redirect URI validation** performed by main app (`PREVIEW_DOMAINS` allowlist)
- **WebSocket origin header** rewritten to sandbox URL for upstream origin validation

### Session Fixation Prevention

- **Set-Cookie headers from sandboxes** are filtered to prevent overwriting `preview_auth`
- **Only preview-proxy sets auth cookies** (sandboxes cannot hijack sessions)

## Observability

### Logging

- **Pino** structured logging with configurable `LOG_LEVEL`
- **Request correlation** via `x-request-id` and W3C `traceparent` headers
- **Access logs** track request lifecycle (auth_redirect, proxied, error, etc.)

### Metrics

- **Outcome tracking** (`accessLog.outcome`) per request
- **Upstream status codes** logged for proxied requests
- **Duration tracking** for WebSocket upgrades

### Tracing

- **W3C Trace Context** propagation (`traceparent`, `tracestate`)
- **Request context** (AsyncLocalStorage) for structured log correlation
- **Upstream target** logged for all proxied requests

## Common Patterns

### Adding a New Port

1. **Environment config** (`packages/db/src/schema.ts` - environments.config.ports):
   ```typescript
   { name: "MY_SERVICE", proxied: true, unauthenticated: false }
   ```
2. **Worker setup** — Expose port from sandbox, add to `machineDomains`
3. **Access** via `https://{taskId}-my-service.preview.roomote.run`

### Making a Port Public

```typescript
{ name: "WEB", proxied: true, unauthenticated: true }
```

No preview auth required on that proxied route.

### Bypassing Auth for Specific Paths

```typescript
{
  name: "API",
  proxied: true,
  unauthenticated: false,
  auth_bypass_paths: ["/health", "/api/public"]
}
```

Paths matching prefixes skip auth checks.

### Enabling Nested Preview-Proxy

```typescript
{ name: "PREVIEW", proxied: true, wildcard_prefix: true }
```

Allows inner preview-proxies to accept nested subdomains.

### Using Inner Mode

Set on inner preview-proxy instance:

```bash
PREVIEW_PROXY_SUBDOMAIN_SUFFIX=20imtw24sm6hv-preview
PREVIEW_AUTH_COOKIE_NAME=preview_auth_inner
```

Strips outer suffix from incoming requests, uses separate cookie namespace.
