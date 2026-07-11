# Changelog

This file tracks product releases for Roomote (single monorepo version). Automated release entries are prepended by `pnpm run version`.

## 0.1.0 (2026-07-11)

### Minor changes

- Plan mode is now always on: the `PlanMode` feature flag has been removed entirely, so planning turns run read-only for every deployment with no opt-out. The model role that powers it is now called "Advisor" in the settings UI and docs — it keeps backing the planning workflow, and it also backs a new `advisor` subagent that the coding agent consults when it is stuck or needs a second opinion. The advisor uses the configured Advisor model when one is set and otherwise falls back to the active coding model at the advisor reasoning level, which defaults to high.
- Bitbucket Cloud is a first-class source-control provider in Settings: workspace connect, repository sync, webhooks, PR review automation, task git credentials, and SDK pull-request operations. Auth and sync use Atlassian API tokens with scopes and per-workspace repository listing, matching today's Bitbucket Cloud APIs (app passwords and cross-workspace listing are going away).
- Task analytics can switch the chart between Tasks, Tokens, and Cost. The selected metric is stored in the URL (`metric=`), drives server aggregation from inference usage for tokens and cost, and updates axis, tooltip, details, and export formatting. Pull request analytics stays count-based and does not show the control.
- Zero is available as a deployment-scoped workspace wallet integration. Admins connect one Zero account under Settings/Integrations; agents use the official Zero MCP connector for auth and funding and the packaged `zero` skill for search → get → fetch → review. The Zero CLI installs on demand when the integration is enabled rather than being baked into every worker image.

### Patch changes

- The `/auth/dev-login` development login route now requires an explicit `WEB_DEV_LOGIN_ENABLED=true` opt-in on top of the existing development-app-env and loopback-bind guards, so a deployment that implicitly resolves to a development app env never exposes the unauthenticated admin backdoor by accident. `pnpm dev` and the in-repo Roomote sandbox environment definition set the flag automatically, so local development and dogfood sandboxes keep working unchanged.
- Slack-started tasks can now create and update environments. Environment writes previously required the run token's mint-time user claim, but chat-started runs are dequeued as the deployment service principal before an acting user is attached, so they always got 403 "User context required". The handlers now resolve the live task actor (`task_runs.actingUserId`, written only by trusted server-side writers) the same way MCP credential resolution does, falling back to the mint-time claim. Runs with no resolvable human actor are still rejected.
- Fix Slack (and Telegram) cancel of active sandbox tasks when the run has no live acting user. Sandbox stop no longer rejects a missing user claim; it mints a deployment-principal run token the same way other automation RPCs do, and Slack cancel prefers the linked clicker when available.
- Tasks no longer hang forever or drop follow-ups when a model stream stalls mid-turn. OpenCode harness watchdogs bound stalled streams and recover so subsequent messages are processed instead of waiting for the multi-hour sandbox deadline.
- Surface worker base-image provisioning on Settings → Sandboxes: the save button now reads "Provisioning..." while a run is in flight (matching the setup wizard), a failed run shows its error inline with a "Retry provisioning" action, and a note explains that provisioning can take a few minutes. Previously the page kept a generic "Saving..." spinner during the run and never displayed provisioning failures.
- Slack-started tasks can use external integration MCPs again. Auto-routed launches (channel auto-start, automated app mentions, Slack workflow functions, `!eval`) now seed the mapped human initiator as the acting user when available, and deployment-scoped integrations (for example Supermemory, Linear, Sentry) no longer require a human actor at connect time. User-scoped integrations still need a human actor for that user's credentials.
- The Teams bot works again for deployments that only set Microsoft app env vars (`R_MICROSOFT_CLIENT_ID` / `R_MICROSOFT_CLIENT_SECRET` and tenant) without a dedicated `R_TEAMS_BOT_*` pair. The runtime credential path restores that single-Entra-app fallback; dedicated bot credentials still take precedence when set.
- Worker sandboxes no longer inject the hosting deployment's app env (`APP_ENV`/`R_APP_ENV`) into user-facing task processes and the sandbox shell env. That value describes the Roomote deployment's own deploy context and was clobbering per-command `R_APP_ENV=development` overrides via the unconditional exports in `~/.roomote/env.sh`, which disabled dev login in Roomote-on-Roomote sandboxes. The worker keeps the value internally for keepalive and monitoring, also scrubs the legacy `ROOMOTE_APP_ENV` alias from its process env, and the in-repo sandbox environment definition drops its now-unnecessary `sed` export-guard workaround.
- Enabling the Zero integration no longer breaks later tasks by pruning sandbox runtime packages. The Zero CLI install uses its own npm prefix instead of reifying into `/sandbox/node_modules`, so shared tools such as `opencode` stay available when Zero is turned on.

## 0.0.4 (2026-07-11)

### Patch changes

- Ship the post-0.0.3 develop backlog toward production, including Daytona environment/task snapshot resume with legacy env aliases, default-deny API authorization, R_* public env canonicalization, CI status in PR review feedback replies, sandbox provider UX fixes, and other already-merged fixes.

## 0.0.3 (2026-07-11)

### Patch changes

- Fix the release image publish gate so the first production release can ship: resolve the upgrade baseline from the latest GitHub release safely instead of leaking a 404 error into the image tag, and skip upgrade validation when no previous published release exists (fresh-install validation still runs).

## 0.0.2 (2026-07-10)

### Patch changes

- Seed the product version lineage so the first automated release becomes 0.0.2 above the existing v0.0.1 tag.
