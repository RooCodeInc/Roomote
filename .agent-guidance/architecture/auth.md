---
title: Authentication & Authorization
status: active
last_reviewed: 2026-07-07
owner: engineering
summary: Technical documentation of the auth system covering Better Auth browser sessions, single-deployment identity, setup-driven provider configuration, JWT token types, sandbox OIDC identity, API middleware, and tRPC procedure guards.
---

# Authentication & Authorization

Roomote is local-first and self-hosted. The web app uses Better Auth for the browser auth boundary. Users must sign in before using the product app, and the local runtime creates or updates the signed-in user plus the singleton deployment settings row.

## Overview

Authentication has three active mechanisms:

1. **Browser auth context** — `apps/web/src/lib/server/auth-context.ts` resolves the current Better Auth session and maps it into the single-deployment product identity.
2. **Job tokens** (`t: 'cj'`) — per cloud job, scoped to task execution and validated by `@roomote/auth`. The user claim (`r.u`) is optional: a token without it authenticates as the **deployment service principal**, the non-human identity for automation-initiated jobs with no human driver. `JobTokenContext` carries `principal: 'user' | 'deployment'` and a nullable `userId`. Token/job matching is `(cloudJob.userId ?? null) === token.userId`, so a deployment token is valid exactly for ownerless jobs. There is no first-user or placeholder-owner fallback anywhere (`resolveUserIdForCloudJob` was deleted); operations that genuinely require a human actor return a 403 naming the service principal, and MCP credential lookups for deployment-principal jobs use deployment-scoped `mcp_connections` rows (`user_id IS NULL`).
3. **Auth tokens** (`t: 'auth'`) — user bearer tokens for API access and worker-to-app calls.

The deployment identity is intentionally flat:

- `deployment_settings.id = 'default'` stores deployment-wide setup and feature metadata.
- Signed-in allowed users are operators in that deployment; there is no local Roomote org, workspace, membership, invite, or role-assignment flow.
- The seeded `local-user` development record does not replace the signed-in operator identity.

## Web Auth

`authorize()` from `@/lib/server` is the canonical server-side gate for product code. It returns `UserAuthSuccess` with the user, admin bit, and deployment-level feature flags with user-scoped overrides applied. Roomote no longer has org billing account records, workspace memberships, legacy unmetered auth state, or billing-state access gates. `authorizeOrThrow()` is the throwing variant for callers that prefer exception flow.

`getSignedInAuthContext()` is the lower-level helper that reads the Better Auth session and ensures the local `users` row plus singleton `deployment_settings` row exist. In local development it still requires a browser login.

Sign-in access is membership-based. Because every signed-in user is an admin in the single-tenant model, who can complete sign-in is the deployment's only membership boundary. Sign-in is allowed when any of these hold (`evaluateSignInAccess()` in `apps/web/src/lib/server/access-policy.ts`):

- **Existing member** — an app-level `users` row already exists for the auth user. Admission decisions happen at join time; revocation means removing the user.
- **Provider organization membership** — for Slack this compares the `https://slack.com/team_id` claim decoded from the signing-in account's stored ID token against the `slackTeamId` anchored in `deployment_settings.access_policy` (falling back to active `slack_installations` team ids when no anchor exists). Microsoft Entra sign-in already proves tenant membership because the provider is registered with a single tenant id.
- **Invite** — the visitor presents a usable invite token (see below).
- **Bootstrap (the system invite)** — initial deployment setup is still open (`deployment_settings.setup_completed_at` is null) and the visitor presents a valid `SETUP_TOKEN`. The installer's printed setup link is therefore the operator's invite link, and it keeps working across retries: saving bootstrap auth config creates the system `setup-bootstrap-user` audit row, and an earlier aborted attempt can leave a real account behind, so bootstrap admission must not depend on an empty `users` table while setup remains incomplete (bootstrap admissions join as admins, see below — so keep `SETUP_TOKEN` secret and complete setup promptly). Only local development admits a bootstrap sign-in without a setup token; every other environment requires `SETUP_TOKEN` (`isSetupTokenValid()`/`isTokenlessBootstrapAllowed()` in `setup-token.ts`), so an attacker who reaches an exposed deployment before the operator cannot claim the founding-admin slot. Tokenless bootstrap fails closed: it is allowed only when `NODE_ENV !== 'production'` **and** the app env resolves to `development`, so a deployment that sets `NODE_ENV=production` but leaves `APP_ENV` unset (which `resolveAppEnv()` would otherwise fall back to `development`) still requires the token. On a non-local deployment with no `SETUP_TOKEN` set, `/setup` shows the setup-token step and bootstrap stays closed until one is configured. Once `setup_completed_at` is written, the bootstrap path closes entirely.

Admission is additionally subject to the deployment **seat limit**: inside the user-insert transaction, `ensureDeploymentIdentity()` locks the `deployment_settings` row `FOR UPDATE`, counts active users, and throws `SeatLimitExceededError` when the deployment is at its licensed limit (free tier 10 seats; a valid license key stored in `deployment_settings.license_key` raises it). The same check guards restores of soft-deleted rows. New sign-ups are rejected earlier for UX: the `user.create.before` hook throws an `APIError` with the seat-limit message when the deployment is at capacity (`hasSeatAvailable()`, advisory read-only check), so the sign-up form shows the error inline and no auth user is created. If a session holder is blocked at admission anyway, `getSignedInAuthContext()` maps the error to an `AuthError` with `reason: 'seat_limit'` and the `/sign-in` page — re-running the evaluation server-side — shows the same notice above the form. See [Licensing & Seat Limits](../features/licensing.md).

Invites live in the `invites` table (`apps/web/src/lib/server/invites.ts`): only a SHA-256 hash of the token is stored, with label, inviter, `maxUses`/`usedCount`, expiry, and revocation. Invite links land on `/invite/<token>` (`apps/web/src/app/invite/[token]/route.ts`), which moves the token into the `roomote-invite` cookie and redirects to sign-in; the cookie survives OAuth redirects so an invite authorizes sign-up through any method. `handleAuthRequest` exposes the cookie to Better Auth database hooks through AsyncLocalStorage (`apps/web/src/lib/server/invite-context.ts`); outside that scope the token is read from request cookies.

Email/password auth is now enabled, with sign-up gated by the same access checks: `isNewAuthUserEmailAllowed()` runs in the `user.create.before` hook and admits invite/system-invite holders and empty deployments (`canVisitorSignUp()`). Email/password sign-ups (`/sign-up/email`) stop there — they strictly require an invite because there is no provider organization to defer to. OAuth sign-ins from an org-scoped provider configuration (Slack/Microsoft) are additionally admitted at user-create time so the full org-membership evaluation can run in `session.create.before` (via `isSignInAllowedByAccessPolicy()`) once the provider account row exists. The `/sign-in` page reads the invite cookie server-side through `canVisitorSignUp()` and only offers email/password account creation to invite (or bootstrap) holders — everyone else sees sign-in only plus a prompt to ask an admin for an invite. `getSignedInAuthContext()` repeats the full evaluation per request, and for invite-admitted visitors performs the redemption: `redeemInvite()` atomically increments `used_count` (failing closed when a concurrent redemption exhausted the invite) and the accepted invite id is recorded on `users.invited_by_invite_id`. There is no password-reset email flow; recovery is a fresh invite from an admin.

`deployment_settings.access_policy` now stores only the Slack workspace anchor. `seedDeploymentAccessPolicyIfNeeded()` captures it from the first signed-in user's Slack account, guarded by `IS NULL` against concurrent first sign-ins. Admins manage invites, roles, removals, and the deployment license key in Settings → Users (`accessPolicy` tRPC router: `get`, `createInvite`, `revokeInvite`, `updateUserRole`, `removeUser`, `createPasswordResetLink`, `setLicenseKey`); the raw invite URL is only available at creation time. Invites carry a role (`invites.role`, default `member`) granted to users they admit.

Users carry a deployment-level role (`users.role`, `admin` or `member`). `isAdmin` on the auth context is derived from that role — for sessions in `getSignedInAuthContext()` and for API-key tokens in `authorize-tokens.ts`; job tokens are never admin. The deployment's first user is promoted to admin inside the user-insert transaction — as is any later bootstrap-admitted user while setup is still open, since setup-token holders are deployment operators — everyone else joins as a member, and users that predate roles were backfilled as admins by migration `0017_user_roles`. Role changes and removals go through `updateUserRole()` / `removeUser()` (`apps/web/src/lib/server/user-management.ts`), which serialize on the `deployment_settings` row lock and refuse self-changes, self-removal, and demoting or removing the last active admin, so a deployment can never reach zero admins through the app. If that state is ever reached externally, recovery is a direct database update (see SELF_HOSTING.md).

Removal soft-deletes the app `users` row (task attribution history stays) and hard-deletes the Better Auth user row, which cascades away sessions (immediate sign-out) and OAuth account links and frees the unique email — so a removed person can sign up again with the same email, arriving as a brand-new user who must pass the sign-in access checks like anyone else. Soft-deleted users no longer count as existing members in `evaluateSignInAccess()`, and their API-key tokens are rejected in `authorize-tokens.ts`; job tokens for their still-running tasks keep working.

Operators can additionally set `ROOMOTE_ALLOWED_EMAILS` to a comma- or whitespace-separated allowlist. It is enforced as an AND-gate on top of membership checks in the same hooks. Keep the hook layer and `getSignedInAuthContext()` in sync when changing local access rules.

Development deployments (`NODE_ENV !== 'production'` and `APP_ENV === 'development'` — hosted preview/staging envs are excluded) additionally expose **`/auth/dev-login`** (`apps/web/src/app/auth/dev-login/route.ts`), which mints a Better Auth session directly without any provider round-trip so automated agents can start signed in — including when the repo itself runs inside a sandbox preview. One GET creates the auth user, upserts the app `users` row as an active admin (bypassing `evaluateSignInAccess()`, which would otherwise reject a non-member once any user — such as the seeded `local-user` — exists), sets the session cookie, and 307-redirects to a same-origin `redirect_url`. The cookie name and Secure flag are derived from the request origin (forwarded headers included) to match Better Auth's per-request dynamic base URL resolution, so sessions survive the https preview proxy even when `ROOMOTE_APP_URL` is plain http. `WEB_DEV_LOGIN_EMAIL` overrides the default `local@roomote.dev` identity, and `ROOMOTE_ALLOWED_EMAILS` is still enforced. Dev login only authenticates — it does not bootstrap deployment state, so on a deployment where setup is incomplete (`setupCompletedAt` null or no GitHub connection) the signed-in admin lands on `/setup` as usual and completes setup from there.

Client components should read auth state through `useUser()` and the `AuthProvider`. The provider receives the server auth result from `RootLayout`; while initial setup is still open, signed-out routes that would normally force `/sign-in` now redirect into `/setup` instead so the deployment can bootstrap its first auth provider before any operator session exists. After `setupCompletedAt` is written, those same guards fall back to the normal `/sign-in` redirect.

The unauthenticated app routes render sign-in for the configured methods. Better Auth handles Slack through a first-party social provider and Microsoft Entra ID through the generic OAuth/OIDC plugin.

Initial provider setup now happens inside the admin `/setup` flow instead of requiring every sign-in provider env var to exist before the first operator can continue. `/setup` persists the chosen provider only after the operator actually saves provider details, and the runtime auth resolver reads both real runtime env vars and saved deployment env vars when deciding which sign-in methods are available.

When `deployment_settings.setup_completed_at` is still null, `/setup` is intentionally reachable without an existing Better Auth session. That public bootstrap phase is limited to:

- selecting the first sign-in provider
- entering the provider configuration required to enable it
- immediately starting provider sign-in from inside `/setup`

The remaining GitHub, Slack, repository-selection, and environment steps still run only after the operator signs in.

During that phase the setup token travels two ways: the `?token=` query param on the installer's setup link, and the `roomote-invite` cookie the `/setup` page writes from it (the same cookie invites use, so it reaches the Better Auth hooks during OAuth). Provider sign-in round-trips return to `/setup` without the query param, so the `/setup` page restores the token from the cookie (`readInviteTokenFromDocumentCookie()`) and the `setupBootstrap` tRPC commands fall back to `getRequestInviteToken()` when no explicit token is passed — otherwise the operator would be bounced back to the setup-token gate after signing in.

- `ROOMOTE_AUTH_SLACK_CLIENT_ID` / `ROOMOTE_AUTH_SLACK_CLIENT_SECRET`
- `ROOMOTE_AUTH_MICROSOFT_CLIENT_ID` / `ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET` / `ROOMOTE_AUTH_MICROSOFT_TENANT_ID`

Slack auth prefers the shared integration-level `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` so the same Slack app can power both sign-in and the later Slack integration setup step. The `/setup` provider configuration step defaults Slack to a guided manifest-prefill flow: `StepAuthEnvVars` builds a manifest with `/api/auth/oauth2/callback/slack`, `/api/slack/callback`, and `/api/webhooks/slack`, then opens Slack's `https://api.slack.com/apps?new_app=1&manifest_json=...` create-app URL. Operators still use **Enter values manually** for existing apps and for pasting Slack's generated Client ID, Client Secret, and Signing Secret back into Roomote. V1 does not use Slack app configuration access tokens or `apps.manifest.create`; runtime environment variables continue to take precedence over saved setup values. The `/setup` provider configuration step also collects Slack integration fields such as `SLACK_SIGNING_SECRET`. It does not ask for `SLACK_APP_ID` because the later Slack workspace installation saves Slack's `app_id` from `oauth.v2.access`; `SLACK_APP_ID` remains an optional manual-env fallback. `SLACK_REDIRECT_URI` is derived from `ROOMOTE_APP_URL` plus `/api/slack/callback` when not explicitly configured. `ROOMOTE_AUTH_SLACK_CLIENT_ID` and `ROOMOTE_AUTH_SLACK_CLIENT_SECRET` remain valid fallback compatibility keys for auth-only compatibility. Microsoft Teams sign-in uses Better Auth's `microsoftEntraId` generic OAuth helper with provider id `microsoft-entra-id`; it is enabled only when the client ID, client secret, and explicit tenant ID are all configured.

Signing in with any Better Auth provider creates an `auth_accounts` row for that provider. The Settings > Linked Accounts surface reads Microsoft Teams auth account rows directly so those sign-ins automatically appear as linked accounts. Users can also explicitly link Microsoft Teams after signing in with another provider through Better Auth's generic OAuth `/oauth2/link` flow, and unlink them through Better Auth's `/unlink-account` flow. When a Microsoft Entra auth account is deleted, Roomote also removes Teams chat user mappings tied to the same user, tenant, and AAD object ID so Teams messages do not stay authorized through stale `teams_user_mappings` rows.

## Better Auth

Better Auth is configured in `apps/web/src/lib/server/auth.ts` with the Drizzle adapter and custom table names:

- `auth_users`
- `auth_sessions`
- `auth_accounts`
- `auth_verifications`

The Next.js route handler lives at `apps/web/src/app/api/auth/[...all]/route.ts`.

In non-production environments, Better Auth resolves its `baseURL` dynamically from the incoming request host with a guarded allowlist that includes localhost and configured preview domains. This keeps provider callbacks on the same origin that initiated sign-in so state cookies survive local Slack and other social auth flows even when developers switch between `localhost` and the public ngrok URL.

`apps/web/src/lib/server/browser-origin-trust.ts` mirrors that acceptance decision (strict canonical origin in production, allowlisted host patterns otherwise) for the public `deployment.assessBrowserOrigin` tRPC procedure. The setup wizard and sign-in page render `OriginMismatchAlert` from it, so operators browsing an origin the auth layer will reject — typically a custom domain attached without updating `ROOMOTE_APP_URL` — see the fix before requests fail with 403 "Invalid origin". Keep the mirror in lockstep with `getBetterAuthBaseUrlConfig` when the origin rules change.

Provider enablement for both Better Auth and the `/sign-in` page now flows through the shared server helper `apps/web/src/lib/server/auth-provider-config.ts`. That helper merges:

- current runtime env vars
- saved deployment env vars from the encrypted `environment_variables` table

This keeps sign-in availability, Better Auth provider wiring, and `/setup`'s deferred credential collection in sync.
Server render paths that read setup state or provider availability must bootstrap the web runtime before touching `@roomote/db/server`, so `isSetupBootstrapOpen()` and the default provider-config resolver initialize `bootstrapWebRuntimeEnv()` before querying deployment state.

## API Auth

The Hono API does not depend on browser auth middleware. Public health and sandbox OIDC discovery routes bypass token auth. Non-public API routes run `tokenAuthMiddleware()` and expect a valid job token or auth token where required by the mounted handler.

## Sandbox OIDC

Sandbox OIDC endpoints expose machine-consumed discovery and JWKS documents for sandbox identity:

- `/.well-known/openid-configuration`
- `/api/oidc/jwks`

Only those exact public documents bypass token auth.

## Authorization Rules

- Product server routes and tRPC procedures should call `authorize()` unless they explicitly accept job/auth bearer tokens.
- Local development should require local Better Auth sign-in through a configured provider. Local callback and event delivery uses `ROOMOTE_PUBLIC_URL` when set, otherwise `pnpm dev` auto-starts an ngrok web tunnel; it should not require hosted auth, preview, Stripe, or production credentials.
- Personal preferences and feature flag metadata are stored in the database (`users.metadata` and `deployment_settings.metadata`).
- Multi-user management is deliberately limited to allowed Better Auth users sharing one deployment. There is no in-product organization switching, workspace switching, or membership management surface.
