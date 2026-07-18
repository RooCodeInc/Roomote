# Changelog

This file tracks product releases for Roomote (single monorepo version). Automated release entries are prepended by `pnpm run version`.

## 0.12.1 (2026-07-18)

### Patch changes

- Apply generated titles to Discord first-message task threads early so they no longer stay on provisional names
- Allow Discord Retry after a failed environment start without hitting the source-event unique constraint or leaving the run stuck Booting
- Automatically choose a Discord forum tag when launching tasks in tag-required forum or media channels, and require Manage Threads before applying moderated tags
- Acknowledge expired or duplicate Discord routing-button clicks without blocking newer gateway events
- Start standard tasks from GitHub issue @mentions (comments and new issue bodies), not only pull request comments
- Simplify Create GitHub App and Create Slack app setup by keeping the automated in-UI path only and restoring reliable Back navigation when earlier setup steps are skipped
- Default the /tasks user filter to any user for admins instead of only the signed-in admin

## 0.12.0 (2026-07-18)

### Minor changes

- Continue Discord tasks in the mentioned thread with earlier thread history and attachments instead of opening a separate task thread.
- Add GitHub Copilot as a connectable inference provider with GitHub device-code OAuth. Copilot credentials stay on the control plane while `github-copilot/...` inference routes through the run-scoped gateway.

### Patch changes

- Make Discord task thread titles readable by expanding mentions and stripping attachment noise, then replace provisional titles with the task title.
- Skip the Discord reconnect notice when a completed task resumes from snapshot in the same thread.
- Fix environment start failures on ES256 signing keys by accepting common key encodings (raw PEM and base64 DER) instead of only base64-encoded PEM.
- Show OpenCode provider retry errors in chat with a retrying indicator and countdown.
- Stop endless retries when a provider reports billing, suspension, or payment-required failures; surface the provider message and end the task.

## 0.11.0 (2026-07-18)

### Minor changes

- Allow natural replies to confirm, cancel, or correct pending workspace routing choices in Telegram and Discord.
- Let Roomote agents show sandboxed, presentational HTML widgets directly in task transcripts, with text fallbacks for chat-originated tasks.
- Operators can enable Auto-respond on Discord text and announcement channels, so linked posts and matching bot/webhook feeds start tasks with per-channel instructions—no @mention required.
- Add Kimi for Coding as a first-class inference provider with keys from the Kimi Code console, separate from Moonshot Open Platform.

### Patch changes

- When visual-proof auto-post is off, Discord, Teams, and Telegram agents are guided to attach screenshots in the originating thread (same fallback Slack already had) so proofs are less likely to remain task-UI-only.
- Discord install docs and channel diagnostics require Add Reactions, so channels missing that permission fail closed instead of looking usable.
- Discord task starts use the router's free-form kickoff when available and show cleaner Follow / Cancel controls instead of long primary-style button labels.
- Discord task reactions now match Slack: eyes on real intake messages, mapped terminal/cancel reactions on the launch target, and no automatic eyes spam on every active-thread follow-up.
- On Discord and Teams, agents re-receive out-of-band PR review and status notices on the next user follow-up so “fix those” stays grounded after Idle notifications.
- Unlinked Discord users are no longer prompted to link their account for ordinary unmentioned chat inside an existing task thread; link nudges still apply for DMs, slash commands, and @mentions.
- When Code Reviewer is enabled, chat closeouts that share a new or refreshed PR/MR link briefly note that a source-control self-review will follow.

## 0.10.0 (2026-07-17)

### Minor changes

- Operators can configure Ollama, vLLM, or LiteLLM as endpoint-based inference providers. Roomote discovers and qualifies their OpenAI-compatible models server-side, routes tasks through the inference gateway, and records LiteLLM-reported request cost without exposing endpoint credentials to sandboxes.

### Patch changes

- Pending GitHub App install requests now poll for approval, offer a manual re-check, auto-continue once an org owner approves, and DM the requester on linked chat integrations, so setup no longer dead-ends on a static pending screen.
- Telegram task topic handoffs are explicit in the source conversation: Roomote names the new topic, links to it when Telegram provides a permalink, and explains same-chat fallback when topic creation fails, instead of relying only on an eyes reaction or silent fallback.

## 0.9.0 (2026-07-17)

### Minor changes

- Live previews are always available when the preview runtime is ready and the environment defines ports. The preview pane stays open for setup (runtime, ports, and broken-preview help) instead of being gated behind an enable/disable setting.

### Patch changes

- Unanswered Discord routing suggestion cards now auto-confirm after 30 seconds, matching Slack, so a suggested environment still launches if nobody clicks. Fallback cards without a real suggestion no longer claim a best match or auto-launch.
- On deployments with only one environment, the homepage workspace control defaults to that environment instead of remaining on Auto.
- When Local Docker and a cloud sandbox provider are both configured, the default sandbox provider now prefers the ready cloud provider so homepage and launch defaults no longer stick on Local Docker.
- Telegram routing confirmation cards use the same 30-second auto-confirm window as Slack and Discord, so there is one consistent correction window across chat providers.

## 0.8.1 (2026-07-17)

### Patch changes

- Clarify Review Code wording and section ordering on the Automations settings page so source-code, Slack, manager, and meta automations are easier to scan.
- Create account and other credential fields no longer block password managers, so 1Password can offer to generate and save passwords on signup.
- Task log tails again allow intentional `/tmp` paths such as harness and environment log files, while still blocking absolute paths outside that boundary.
- Spell cancel buttons as **Never mind** (two words) on Slack, Discord, and Telegram task and workspace pickers.
- Recover from bounded model-provider turn errors, including safety-policy refusals, without immediately aborting the Roomote task.
- Slack transcript decoding no longer crashes with a stack overflow when a thread contains a long sequence of thread-activity blocks.

## 0.8.0 (2026-07-17)

### Minor changes

- Route task-sandbox inference through a control-plane gateway for every deployment: provider API keys and ChatGPT subscription auth stay server-side, sandboxes call `/api/inference` with a run-scoped token, and the InferenceGateway feature flag is removed so this is always on.
- Allow self-hosted operators to set the paid-seat license key via the `R_LICENSE_KEY` environment variable (takes precedence over Settings → Users).
- Add provider-local model mapping presets in Settings so operators can choose labeled mapping sets (including OpenRouter Balanced and Quick turnaround), confirm the selected mapping before it applies, and automatically add or enable referenced models.
- Remove the authorship-rules feature (settings UI, compiler, and enqueue-time evaluation). Task commit authors and PR assignees now always use default attribution.

### Patch changes

- Automation labels spell the CodeQL brand correctly, so `codeql_triage` surfaces as “CodeQL Triage” instead of “Codeql Triage” in task filters, analytics, and attribution.
- Temporarily disable Google Vertex AI and remove legacy direct Mistral execution. Model-provider credentials now enter task sandboxes only through the selected runtime provider allowlist, while unrelated task environment variables remain available.
- Clarify the Discord install flow (including dropping the permissions integer from operator-facing guidance) and recover the Discord gateway when a deployment never received a gateway secret instead of staying stuck offline.
- When both an OpenAI API key and a ChatGPT subscription are connected, Settings again shows a separate OpenAI provider section instead of folding every `openai/` model under ChatGPT (subscription).
- Tasks no longer abort when OpenCode surfaces a provider rate-limit as a terminal session error; the worker treats those limits as retryable and continues the run after backoff.
- OpenRouter Connect works for self-hosted deployments whose public app URL is a loopback address, instead of failing the OAuth handoff in that configuration.
- Refresh the shipped worker runtime when restoring task snapshots so snapshots created by an older release remain compatible with current runtime protocols such as the inference gateway.
- Shared links into the product app now resolve to short static page titles and one-line descriptions (task, settings, history, sign-in, setup, onboarding) instead of the generic global fallback.
- Harden high-confidence security gaps: shell-escape untrusted git and GitHub CLI arguments, tighten OAuth account linking, and strengthen run-token authentication used by sandbox runtime traffic.
- Slack transcript decoding no longer hangs when thread activity contains crafted or pathological input.

## 0.7.1 (2026-07-16)

### Patch changes

- On cloud-enabled deployments, the homepage launcher no longer shows the sandbox (compute provider) chooser, matching Settings and keeping provider selection managed by the deployment default.
- Model settings autocomplete is more responsive: suggestions update sooner, stay visible while new results load, support fuzzy matches from the first character, and no longer show model-resolution errors behind an open suggestion list.

## 0.7.0 (2026-07-16)

### Minor changes

- Add a scheduled CodeQL triage automation that can report prioritized code-scanning alerts to Slack or Discord and launch focused remediation tasks.
- Suggested-task summaries, announcer reports, and platform-issue alerts can now report to a Discord channel: their destination pickers offer Slack or Discord channels the same way the triage and auditor automations do, and platform-issue alerts deliver to the selected Discord channel.
- Operators can set a deterministic Ping instance ID through supported deployment manifests while existing generated identities continue to work unchanged.

### Patch changes

- Analytics overview and cost views now avoid redundant queries and unnecessary data loading while preserving their existing filters and attribution.
- Anthropic and Bedrock Mantle tasks using newer Claude models now use compatible adaptive thinking settings instead of failing on their first model call.
- New and retried Roomote Cloud tasks now use the deployment-managed compute provider consistently while existing snapshots remain resumable on their source provider.
- Cost analytics time filters now load correctly instead of failing for finite periods such as the default seven-day view.
- Discord channel permission diagnostics now identify the connected bot correctly, so settings validation works against the live Discord API.
- Managed Roomote compute now keeps its app naming separate from bring-your-own Modal configuration, preventing deployment-managed sandbox attribution conflicts.
- Tasks launched with a model override now apply the configured reasoning effort, and API-provided per-task reasoning effort is honored by the worker.
- Harden the Discord gateway: quarantined (undeliverable) events now surface in the Discord settings diagnostics instead of accumulating invisibly, the durable inbound and dead-letter streams are bounded with capacity pressure reported before shedding, a single transient Redis blip no longer drops a healthy Gateway connection or ratchets delivery restarts to the maximum backoff forever, and a dead gateway supervisor reports to error tracking instead of only logging.
- Task Info now retains the inference provider used at launch, so historical tasks keep the correct provider label after deployment credentials change.

## 0.6.0 (2026-07-16)

### Minor changes

- Promote Bitbucket OAuth to deployment scope so repository sync, webhooks, pull request operations, and worker Git credentials use encrypted deployment connections with token refresh and clearer setup guidance.
- Add Discord as a communications provider with bot setup and account linking, Gateway-based messages and slash commands, per-task threads and forum posts, attachments, follow-ups, automations, and proactive notifications. Gateway sessions resume across service restarts and leader handoffs so Discord can replay events received during the transition.
- Add cost analytics on `/analytics/costs` with generalized LLM usage tracking across task and non-task attribution, provider/model metadata, and durable pricing-aware usage events.
- Environments now track a persisted verification state that is separate from "a definition exists". A new environment is Configured until a follow-up verification task confirms it works, then it becomes Verified; runtime-affecting edits reset it to Configured while name/description-only edits keep it verified. Onboarding can finish while verification runs, the Environments settings page shows the verification status with a Retry verification action and a link to the related task, and agents record the outcome through the new `manage_environments` `record_verification` action.
- Inference providers now carry recommended per-role model defaults (helper, vision, code review, explore, planning). Connecting a provider in the setup wizard applies its recommended defaults automatically, and a "Use recommended" action on the Default Models card in Settings > Models re-applies them at any time. Google Vertex AI now defaults to Claude models (Sonnet 5 coding, Haiku 4.5 helper/explore, Opus 4.8 review/planning), and Google Gemini defaults to Gemini 3.1 Pro for coding with Flash for helper/explore. Requesty is no longer offered for new connections; existing Requesty connections keep working.
- GitHub App setup now creates public GitHub Apps so the install step can pick the target organization, instead of forcing private apps that can only install on the creating account.
- Failed environment starts show the original prompt with a retry control so operators can relaunch without retyping the kickoff.
- Add Roomote Cloud analytics and support integrations behind deployment flags so hosted deployments can enable cloud analytics, the in-app support chat widget, and related remote telemetry wiring without requiring operators to build those surfaces themselves.
- Add the Roomote deployment-managed compute provider: deployments that ship managed sandbox credentials get a zero-setup sandbox option in setup and Settings while bring-your-own Modal, E2B, Daytona, and Blaxel remain available.
- Slack setup can now create the Slack app for you: paste an app configuration token and Roomote creates the app through Slack's `apps.manifest.create` API, saves the client ID, client secret, and signing secret automatically, and advances straight to the Connect to Slack install step. Entering values manually and the prefilled-manifest path remain available as fallbacks, and the mock Slack harness now covers `apps.manifest.create` so the flow is testable without a real workspace.
- Deliver spawned-task settle outcomes back to the launching run so follow-up work such as environment verification completion is pushed into the parent task instead of depending on agent-side polling that can go idle.
- Refine task conversation activity presentation with clearer activity grouping, condensed tool-call streams, and improved transcript density for long multi-step turns.

### Patch changes

- CI failure triage no longer no-ops when the manager destination is Teams or Telegram; manual Run now can launch the investigate-and-fix task against a non-Slack manager channel.
- React with thumbsdown when a linked pull request is closed without merging, instead of a heavy multiplication mark, across Slack terminal-status notifications.
- Give Discord its own gateway secret (Telegram-style) instead of reusing the shared public webhooks secret, reducing blast radius if one channel's secret is rotated or leaked.
- Allow the production Docker socket proxy to create and remove managed task workspace volumes so Compose-based deployments can provision workers without 403 volume API failures.
- Stop Gitea pull requests from flooding with bot review threads when the bot username does not start with `roomote`, by correctly recognizing bot comments without re-entering mention intake.
- Hide Sandboxes settings when Roomote Cloud is enabled: remove the nav entry and redirect direct visits so cloud deployments do not expose byo-sandbox configuration.
- Show provider headers in multi-provider model choosers and group ChatGPT subscription models under ChatGPT so long model lists are easier to scan in launch and Settings surfaces.
- Default models is now Model mapping with a preset chooser and confirmation dialog before applying recommended provider defaults, so operators can review the mapping instead of it overwriting immediately.
- Tasks no longer hang forever when OpenCode session creation never returns; the run fails closed with diagnostics instead of waiting indefinitely.
- Provider Cancel (Slack and Telegram) now fully stops the active run and shuts the sandbox down, instead of leaving a resumable standby machine after cancel.
- Remove the customizable Vibes admin settings surface and deployment style or emoji overrides; agents use the fixed product defaults instead.
- Rename the managed compute provider label from "Roomote Sandbox" to "Roomote" across setup and Settings.
- Setup no longer skips communication or source-control provider steps just because runtime env vars already satisfy a provider: the picker still appears with the matched option preselected so operators can confirm or change the choice.
- Address v0.6 release feedback: keep the prior physical database contract for the v0.5→v0.6 rollback window, harden upgrade-CI schema checks, and tighten preview auto-resume detection and parent-run settle notifications.

## 0.5.0 (2026-07-15)

### Minor changes

- Docker Compose and Dockerfile environment projects are first-class: run them on Modal VM sandboxes, stream project logs into the task Logs panel, start them without blocking eligible tasks, and allocate higher sandbox memory when nested Docker is required (renamed from "container projects").
- Multi-SCM automations and PR tooling: triage, audit, announcer, and manager-stats cover GitHub, GitLab, Gitea, Azure DevOps, and Bitbucket with shared open-PR listing, merged-PR facts, conflict resolution, and digests; reports can land on Slack, Teams, or Telegram, and the automations page shows destinations plus exception-only coverage badges.
- Environment setup is reworked into the normal task flow: setup completion is observable to the agent and platform, setup logs show in the Logs tab, first-time hosted compute provision no longer blocks creation, excluded sandbox providers stay hidden, and completion messaging no longer shoves users back to a separate /setup page.
- Experimental settings add a deployment-level Code Mode toggle for coding-agent task behavior.
- Local Docker can be enabled or disabled from the Local Docker settings surface without leaving that provider’s configuration page.
- Source-control setup expands provider OAuth and connection flows, simplifies Azure DevOps to organization and PAT by default while preserving full repository identifiers, and prefills the GitHub App description in the manifest setup flow.
- Slack agent narrative replies prefer modern markdown blocks, the Working on footer posts out of band with notifications when linked PRs close, MCP integration setup becomes a non-blocking suggestion instead of blocking task start (with Zero detection limited to product surfaces), and agents can post to Teams or Telegram channels through a surface-generic channel-post tool.
- When only one environment exists the homepage starts there instead of Auto, subagent rows expand to show the launch prompt, the router supplies task-relevant kickoff strings (with freer punctuation and no forced opening reply after free-form kickoffs), freeform kickoffs always show when tasks start, CI failure triage runs as one environment-backed fix task, the coding agent consults the advisor on hard failures and user challenges, and Microsoft Teams onboarding setup copy and flow are refreshed.
- Daily anonymous product stats include a 7-day PR funnel so deployments can evaluate how effectively agent work turns into shipped pull requests.
- Visual proof images now render inline in the task transcript instead of only as detached artifact links.

### Patch changes

- Hosted Docker runtime provisioning is more reliable across E2B, Blaxel, and related setup paths, with retryable rebuilds that preserve the prior artifact; failed local standby resumes clean up nested Docker-project daemons rather than leaving them running.
- Setup can back out of earlier choices without wiping later steps when a user revisits a picker, finishing setup into an onboarding task no longer flashes the home page first, and source-control settings no longer discard in-progress configuration edits when provider-status refetches.
- GitLab OAuth listing and install paths work for OAuth-backed tokens and public callback hosts: MR list/sync uses the bearer-aware token header, and OAuth authorize/callback redirect URIs use the request callback host (matching Gitea). Gitea comment intake ignores the configured deployment bot identity, not only roomote*-prefixed logins. Host-aware keys keep PR funnel and merge-duration counts correct across multi-host source-control instances, and Slack/markdown path handling avoids ReDoS-prone polynomial patterns flagged by CodeQL.
- Local development artifact uploads from hosted workers succeed through the Caddy edge, and presigned upload responses without an S3 ETag are no longer treated as successful.
- Slack notifications no longer target the wrong task thread or post to destinations whose Slack connection was disconnected.
- The homepage empty-environments warning no longer flashes orange while environments are still loading.
- Blaxel Docker projects no longer pass the unsupported Compose `--wait` flag: the provider check now reads the worker's process environment, where the compute provider is actually set.

## 0.4.2 (2026-07-13)

### Patch changes

- Onboarding Slack setup no longer strands revisits with saved credentials on a form with no Continue action: the step button is shown again when the intro screen is skipped.

## 0.4.1 (2026-07-13)

### Patch changes

- Automation act work items no longer fail after a scan task resumes: submit uses the current scan run instead of a non-deterministic first run when a task has multiple runs.
- Improve Telegram reliability with automatic slash-command registration, bounded Bot API retries, persistent bot identity caching, photo and document task inputs, and repairable connection diagnostics.

## 0.4.0 (2026-07-13)

### Minor changes

- Onboarding communication setup includes Telegram alongside Slack and Microsoft Teams, with guided BotFather and token-only setup that registers the webhook without treating Telegram as an authentication provider.
- Telegram tasks open in their own forum topic when Threaded Mode or a forum supergroup is available, isolating each task conversation and preserving topic context across resumes and callbacks, with a fallback to the existing chat flow when topics cannot be created.
- Telegram setup no longer asks for a bot username: Roomote derives it from the configured bot token for group routing, deep links, invocation identity, and task conversation links.

### Patch changes

- Onboarding environment setup auto-selects the only available GitHub repository when nothing is already selected, while keeping explicit unchecks sticky so a solo repo is not re-checked after the user clears it.
- Slack Settings and setup now show an already-configured Client ID, place the diagnostics channel refresh control beside the channel dropdown, and avoid freezing inferred Microsoft Teams bot client or tenant IDs when saving Microsoft single-app setup.
- When Supermemory is connected, agents proactively save durable shared preferences, decisions, conventions, and recurring gotchas across tasks instead of waiting for an explicit remember request, while still excluding secrets, code dumps, task status, and repo-derivable content.
- Telegram Settings and setup no longer block save on an empty webhook secret (Roomote generates it), show clearer webhook check failures, display a saved bot username in plain text, and strip token paste whitespace that previously caused Telegram 401s.

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
