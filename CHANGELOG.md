# Changelog

This file tracks product releases for Roomote (single monorepo version). Automated release entries are prepended by `pnpm run version`.

## 0.3.1 (2026-07-12)

### Patch changes

- Route Amazon Bedrock API keys through the Mantle endpoint and clarify Mantle key setup in model settings.
- GitHub app @mention detection requires word boundaries so longer lookalike logins and emails containing the configured slug no longer falsely trigger agent replies.
- Task filter PR-repo labels left-align correctly in the mobile filter sheet instead of sitting awkwardly centered.
- Materialize pasted Google Vertex service-account credentials before OpenCode starts so Vertex models work across worker paths without exposing credential JSON in provider errors.
- Visual-proof auto-post to Slack is actually gated by the SlackProofAutoPost experimental flag; when the flag is off, proof is no longer auto-posted and agents must share uploaded screenshots through explicit chat replies.
- Task history records when a linked pull request is merged or closed as an out-of-band status message agents can resurface (GitHub, GitLab, Gitea, Bitbucket, and Azure DevOps), using provider-native PR references.

## 0.3.0 (2026-07-12)

### Minor changes

- Local Docker tasks now retain idle containers and resume them in place with bounded cleanup (default 10 retained containers, 24-hour max age; max count `0` disables retention). Blaxel standby retention is likewise bounded (defaults 25 / 168 hours), with env knobs `DOCKER_STANDBY_MAX_*` and `BLAXEL_STANDBY_MAX_*` documented for operators.
- Tasks can go to sleep early from the task page overflow menu (Sleep above Delete). The action is available for snapshot-capable runs and for resumable Docker/Blaxel standby, so operators can release an awake environment without waiting for the keepalive timer.

### Patch changes

- Signed public artifact raw URLs (allowlisted images and videos used for visual proofs and PR embeds) expire 30 days after they are signed, and cache headers stay within the remaining TTL, so a leaked screenshot link cannot be fetched indefinitely.
- Blaxel sandbox lifecycle is more resilient: deterministic external IDs with idempotent create, bounded retries on readiness-sensitive calls, reuse of preview resources across standby/resume instead of delete-and-recreate, and immediate failure on non-retryable 4xx errors.
- Local Docker development rebuilds worker images that lack current networking tools before launching tasks, routes sandbox HTTP/WebSocket traffic through the public app edge so tunneled clients get a usable live session, and marks preview auth cookies Secure when using SameSite=None and Partitioned so iframe previews authenticate reliably.
- PR review notification updates treat failing CI checks and live merge conflicts as high-signal blockers: triage copy names the problem and offers a fix or conflict resolution instead of burying it after a soft "looked good" wrap-up. When findings or other open feedback are already actionable, the notification no longer pads with “CI is passing”; green checks are only mentioned when there is nothing else to act on.
- Main GitHub PR review summary comments now show a compact status footer with the review phase and short commit SHA (`Reviewing abc1234` / `Reviewed abc1234`), using a linked SHA when a commit URL can be built.
- Docker and Blaxel standby environments can resume even when they were suspended before the first agent harness session, so early-sleep retains come back to Idle without forcing a new session create path.
- The worker common env file (`~/.roomote/env.sh`, which holds deployment secrets such as cloud tokens) is written owner-only (`0o600`) with `~/.roomote` locked to `0o700`, so other sandbox users cannot read those secrets.

## 0.2.0 (2026-07-12)

### Minor changes

- Blaxel is available as a hosted sandbox compute provider in onboarding and Settings → Sandboxes: provider configuration, automatic worker-image provisioning into a Blaxel-compatible immutable sandbox image with progress and retry UI, OIDC, usage tracking, and lifecycle cleanup, so deployments can run task sandboxes on Blaxel alongside existing providers.
- Blaxel tasks support native standby resume: idle sandboxes stay retained for seven days with the worker stopped, and follow-up work reconnects to the same instance with refreshed TTLs and preview URLs instead of always spinning a fresh environment. Resume uses the worker-resume path and recreates conflicted preview endpoints so retained sandboxes come back cleanly after standby.

## 0.1.1 (2026-07-11)

### Patch changes

- Bitbucket pull request @mentions now look up active review tasks only within the Bitbucket source-control provider and prefer stable account id/uuid for bot self-detection (with username preferred over nickname), so comment routing is less likely to hit the wrong provider’s task or loop on bot self-replies when nickname and username differ.
- Settings → Misc → Diagnostics stacks each label above its value on small screens, so timestamps, versions, and hashes stay readable instead of wrapping one character per line in the old two-column layout.
- GitHub pull request provenance footers (“Follow up by mentioning @…”) now use the deployment’s configured GitHub App slug at write time when one is set, instead of hardcoding `@roomote` whenever prompt-time resolution fell through to the schema default.
- The one-click Deploy to Render Blueprint now pulls `ghcr.io/roocodeinc/roomote-app:main` for app services instead of `:develop`, so new Render installs track the stable main image channel (aligned with Railway’s primary deploy button).

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

- Ship the post-0.0.3 develop backlog toward production, including Daytona environment/task snapshot resume with legacy env aliases, default-deny API authorization, R\_\* public env canonicalization, CI status in PR review feedback replies, sandbox provider UX fixes, and other already-merged fixes.

## 0.0.3 (2026-07-11)

### Patch changes

- Fix the release image publish gate so the first production release can ship: resolve the upgrade baseline from the latest GitHub release safely instead of leaking a 404 error into the image tag, and skip upgrade validation when no previous published release exists (fresh-install validation still runs).

## 0.0.2 (2026-07-10)

### Patch changes

- Seed the product version lineage so the first automated release becomes 0.0.2 above the existing v0.0.1 tag.
