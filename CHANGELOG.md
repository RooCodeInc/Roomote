# Changelog

This file tracks product releases for Roomote (single monorepo version). Automated release entries are prepended by `pnpm run version`.

## 1.12.1 (2026-09-19)

Roomote 1.12.1 restores model and messaging reliability, strengthens Fast Session evidence and credential handling, and improves automation delivery.

### Highlights

- Restore Kimi for Coding and resolve saved provider credentials for models selected on individual Sessions.
- Keep Slack and Telegram messaging reliable with bounded provider handling, authenticated destinations, and traceable self-DM delivery.
- Deliver complete automation outcomes and email actions while verifying delegated-task reports against concrete evidence.
- Restore integration authentication for self-hosted Fast Sessions and limit helper processes to the environment values they need.

### Patch changes

- Self-hosted Fast Sessions running through BullMQ can mint the authentication tokens required by structured review and deployment integrations instead of starting with no available integration tools. Thanks to @pridemusvaire for contributing this fix.
- Automation reports now wait for delegated work to finish instead of publishing an internal handoff, and email reports include the same relevant navigation and configuration actions as Slack whenever those actions are available.
- Fast Sessions now verify delegated-task completion and blocker reports against concrete evidence, reuse sufficient proof already supplied, and make one bounded recovery attempt when the reported result is incomplete or inconsistent.
- Picking a model for a single Session from a provider that none of the deployment's default models use no longer fails with a missing API key error. The provider credential saved in Settings is now resolved for the picked model.
- Kimi for Coding works again in sessions and tasks. The public model catalog OpenCode reads at runtime renamed this provider, so every request failed before it was sent. Roomote now registers the provider itself instead of depending on that catalog entry. Saved `kimi-for-coding/k2p7` selections move to `kimi-for-coding/kimi-for-coding`, the id Kimi now documents for that model.
- Keep Slack messages reliable under provider limits by safely truncating oversized content, bounding rate-limit retries, and preventing cached thread reads from overwriting newer edits or hiding deletions.
- Standalone Telegram messages to your linked account now use a managed private topic when Threaded Mode is enabled and return provider delivery details, so accepted self-DMs are reliably received and traceable without inheriting an unrelated chat or topic.
- The OpenCode helper process used for Fast Sessions and helper model calls now receives only the environment it uses: model-provider credentials (including any declared in `R_MODEL_ENV_KEYS`) and the variables passed to it explicitly.
- Explicit messaging requests now use one provider-neutral destination lookup and send flow across Fast Sessions and tasks, with bounded Slack discovery, authenticated self destinations for Slack and Telegram, and the existing provider access checks.

## 1.12.0 (2026-09-18)

Roomote 1.12 expands self-service integrations and repository discovery, adds browser and email delivery options, and improves Session reliability across web and Slack.

### Highlights

- Connect built-in integrations and personal or shared remote MCP servers directly from Sessions, with integration keys available to every active member.
- Find connected repositories live by name or description from Fast Sessions and task sandboxes, including deployments without configured environments.
- Receive browser attention alerts and automation reports by email, with secure implicit verification when replying to Roomote-initiated email.
- Delete Sessions with their direct Memory, cycle through artifacts, and recover more reliably from setup, worker, and initial page-loading failures.

### Minor changes

- Built-in automations can deliver reports to an account email address, automations use the configurable Default destination when one is available, and custom automations no longer stop at an arbitrary limit of 25.
- Verify an unverified account email implicitly when its owner replies to a Roomote-initiated email: the reply must pass DMARC and quote the single-use reference token the outbound email carried, after which the reply is processed normally without a separate verification message or Settings visit.
- Agents have a read-only `list_repositories` tool that searches connected repositories live, by name or description, with paging. In Fast Sessions it covers every active repository and returns each one's ID, default branch, provider, host, URL, and mapped environments, so a loosely named repository ("my fork of X") is resolved without asking for a URL even on deployments with more repositories than the prompt lists. In task sandboxes it covers the repositories the task is authorized to check out, with their checkout state, alongside the existing `REPOSITORIES.md` index and `clone_repository` tool; it appears in sandboxes once the worker image from this release is in use.
- Integration keys are now available to active members without an Experimental settings opt-in. Existing owner and administrator permissions, secure credential substitution, approved origin and method limits, and network safeguards remain unchanged.
- Home composer suggestions are now available to every user instead of requiring an Experimental setting.
- Fast Sessions now expose the complete built-in integration catalog and connection status through read-only discovery, then use a separate canonical-ID `connect_integration` action to start the provider's supported OAuth, secure Settings, already-connected, or keyless path. Native, remote MCP, and API-key instructions now share one decision flow that respects explicit choices and never bypasses permission or authorization outcomes. OAuth callbacks remain bound to the requester and Session, then resume the conversation after success, cancellation, or failure. Notion additionally supports an operator-configured public-connection OAuth client while retaining its internal integration secret flow.
- Add OpenRouter as a selectable backend for the optional Jev judgment model, reusing the deployment's existing OpenRouter connection while preserving strict response validation and existing fallbacks.
- Any member can now add a remote MCP server, the way they add an integration key: shared with everyone in the deployment, or private to them. Private servers live under Personal Settings → Personal MCP servers, reach only their owner's Sessions and tasks, and stay invisible to everyone else, administrators included. Shared servers are managed by the member who added them and by administrators, and other members see them read-only. A server can be moved between private and shared without authorizing again. Asking Roomote in a Session to connect a service's MCP server now works for every member, shared by default and private on request. Local (stdio) servers remain administrator-only.
- Delete a Session and its directly associated Memory from the Session menu, with clear safeguards for active work and private data.
- Sessions can notify you in the browser when they need attention or are ready, with an opt-in permission prompt and attention tracking that avoids duplicate or stale alerts.
- Announce the latest stable major or minor Roomote release after a successful update through a configurable built-in automation, matching the in-app authored summary and complete highlights with durable retry-safe delivery and a manual test action.

### Patch changes

- Cycle directly between artifacts in the artifact viewer without returning to the artifact list.
- Use a neutral reaction when a pull request closes without merging instead of presenting the closure as a celebration.
- Block custom integration requests from targeting internal network addresses while preserving explicitly approved public endpoints and methods.
- Fast Sessions now see the deployment's active connected repositories even when no environments are configured, so a request that names a repository (or "my fork of X") launches an All repositories task instead of asking for a repository URL. The list is capped for large deployments, and the agent only asks when several repositories plausibly match.
- Move Integrations into the top-level navigation and make each integration's connection status easier to scan in its details.
- Improve mobile Session and task controls by preventing prompts from stealing focus, keeping the Session drawer above the keyboard, and placing Session overflow actions in the bottom-right action rail.
- Make model selection clearer by refining coding-model routing controls, showing the selected default model in the Session composer, and restoring metadata for recommended Amazon Bedrock models.
- Updated the bundled OpenCode runtime to 1.18.30. Native Amazon Bedrock models that return redacted reasoning (such as xAI Grok) now work in sessions and tasks instead of failing on every response, and Bedrock reasoning replay is more reliable. GPT-6 sessions keep identifying as Roomote under OpenCode's new GPT-6 system prompt.
- Recover cleanly from worker bootstrap exits, repository setup failures, skipped setup capabilities, invalid custom schedules, and initial Session, task, or Personalization loading errors instead of leaving work stalled, hiding useful errors, or leaving pages stuck.
- Make Roomote interfaces clearer with condensed Session metadata, independent nested disclosures, accessible task-log controls, a less cluttered list-focused Home experience, standardized product terminology, and the current deployment host in About.
- Make Slack automation and release-announcement cards consistent and easier to read by preserving paragraph spacing, compacting unordered lists, and using the standard automation result layout.
- Include attached screenshots in the first reply sent to a vision-capable model instead of making the model wait for a later turn to see them.

## 1.11.0 (2026-09-17)

Roomote 1.11 adds private Sessions, smarter model routing and triage, cross-platform peer conversations, and safer integration and operator workflows.

### Highlights

- Keep sensitive work owner-only in private Sessions, with explicit approval before publishing anything outside the Session.
- Route coding work by natural-language conditions and use the optional TypeSafe Jev judgment model for faster routing and triage decisions.
- Continue peer conversations across Slack and Discord while making Fast and Slack delivery more resilient.
- Add and authorize custom remote MCPs from Fast, use GitHub tools across connected repositories, and send platform issue reports only after admin confirmation.

### Minor changes

- Let admins define natural-language coding-model routing rules in Settings > Models, selecting an enabled model and reasoning level for strongly matching work while explicit choices and deployment defaults remain authoritative.
- Extend experimental peer conversations from Slack to established Discord Fast threads, so linked participants can continue discussion after mentioning one another while Roomote stays quiet unless addressed or clearly needed.
- Allow Roomote to send notifications and automation reports to account email addresses before they are verified, while keeping verification required for inbound email commands and replies.
- Let deployment administrators add and authorize custom remote MCP integrations from Fast Sessions without sharing credentials in chat, and prefer a service's official remote MCP server over an integration key when nothing connected covers it.
- Let tasks and Fast Sessions report admin-fixable platform, configuration, and access issues through the existing Platform Issue Alerts flow. Admins review the exact details in a confirmation page before sending anything to Roomote.
- Add optional Private Sessions that keep transcripts, tasks, artifacts, and integration data owner-only and out of shared Memory. Admins enable them deployment-wide; owners can publish through normal tools after explicitly approving what leaves the Session.
- Add an optional judgment model for fast routing and triage decisions. Admins can connect TypeSafe in Settings > Models and choose Jev via TypeSafe or Jev via Vercel AI Gateway under Judgment model (or set `R_JUDGMENT_MODEL`). When it is on, Roomote uses it for channel launch criteria, request classification, unmentioned thread replies, Fast environment and skill hints, integration tool search, Memory result ordering, PR review noise, email auto-replies, and Discord forum tags, and keeps its existing behavior whenever the judgment model is unsure or unavailable.

### Patch changes

- Make automation controls predictable: scheduled automations ask for a frequency before enabling, required custom fields show validation guidance, and Results shares only output proven safe for the whole deployment.
- Apply Experimental settings deployment-wide under admin control, keep the peer-conversation control consistent with neighboring settings, and preserve configured Auto-respond channels when the automation is disabled and re-enabled.
- Give Fast Sessions the same repository access a coding task has. A signed-in member can use GitHub repository tools under one cached installation token that reaches only the connected repositories. Searches pass through with GitHub's own query syntax, `org:` and `repo:` qualifiers pick the right installation, and reads no longer have to name a repository. Calls routed across installations no longer fail with `invalid session` because the GitHub proxy does not carry MCP sessions upstream. Coding tasks stay read-only on this tool path and keep writing through their own checkout.
- Keep Fast Sessions responsive through transient connection resets, show Working only while Roomote is actually responding, and surface delegated task reports immediately instead of waiting for the parent turn to finish.
- Fast Sessions find out what connecting to a service's remote MCP server requires before suggesting it. Roomote now registers the deployment with the provider when the server is added, so an authorization link is only shared when it can succeed; a provider that only accepts approved clients is reported in its own words and Roomote continues with your integration key. When an authorization link does fail, the Session is told why instead of landing on a silent page.
- Agents now check shared Memory for unfamiliar people, projects, companies, and terms before asking users to provide context that Roomote may already know.
- The "Add your key" card on a Session page now goes away once the conversation moves past the agent's request. It shows only while that request is the open ask, and it disappears when the owner replies without saving a key, saves one, or the approval expires. The approval itself stays available in the key dialog.
- Allow an owning user to continue a private Session without restating its privacy mode on every turn, while keeping explicit privacy mismatches and non-owner access rejected.
- Avoid automatically opening Session task panels for tasks that failed before execution started.
- Return to the Environments list after creating an environment. Legacy environment links on Home now start ordinary Sessions instead of directly launching tasks.
- Make analytics and anonymous reporting more accurate by counting user-started and private Sessions correctly and adding aggregate Session creation, source, owner, token, and cost totals to daily instance reports.
- Improve Session interfaces by preserving the current user's avatar identity, hiding the artifact tab when a Session has no artifacts, restoring Voice for private Session creation, and labeling artifact download links for screen readers.
- Recover cleanly when web authentication expires instead of redirecting repeatedly between sign-in and authenticated pages.
- Prevent Slack messages from disappearing after transient processing failures and keep peer conversations responsive to the current linked participant without making Roomote appear active during side discussions.

## 1.10.0 (2026-09-16)

Roomote 1.10 expands agent research and multi-repository work, reorganizes personal and shared integrations, and improves Session reliability, mobile input, artifact previews, and operator diagnostics.

### Highlights

- Research the public web through guarded URL fetching or the new opt-in Exa integration.
- Check out additional authorized repositories from any sandbox workspace while preserving its original tooling and services.
- Manage personal integration keys separately from deployment-wide integrations, make bounded approved requests directly from Fast, and use task-scoped substitutes for scripts or many calls.
- Keep Sessions moving with stronger mobile input, artifact previews, pull-request views, authentication recovery, and delivery diagnostics.

### Minor changes

- Sandbox tasks can now check out additional authorized repositories from environment, repository, repository-set, all-repositories, and connected Blank slate workspaces while keeping the selected workspace responsible for initial tooling and services.
- Add guarded public URL fetching to the Roomote MCP for Fast Sessions, coding tasks, and external clients, with text formatting, image support, bounded time and size, explicit caller headers, and public-destination checks on every redirect while unrestricted runtime fetching remains disabled.

### Patch changes

- Add an opt-in deployment-wide Exa integration with free keyless search, an optional encrypted API key for authenticated Exa Agent access, secure proxy mediation, Fast and sandbox availability, tool management, and public setup documentation.
- Roomote agents now read nested Slack workflow attachments, look up available context before asking about terse triggers, and identify the exact task-memory field limit when a saved summary is too large.
- Artifact galleries now show bounded real content for CSV and TSV files and reliably load Markdown previews instead of leaving supported files on abstract or stuck placeholders.
- Fix `/health/bullmq` reporting every deployment unhealthy: the overdue queued-event count bound a Date inside a raw SQL fragment, which Postgres rejected, so the check failed on every probe since 1.9.3.
- Integration keys now separate personal and deployment-wide access: members manage private keys in Personal Settings, admins manage shared keys in Integrations, inactive owners immediately invalidate shared grants, and listings omit revoked or expired entries. During human turns, Fast can make one or a few direct approved-method requests; delegated coding tasks use scoped substitute tokens for scripts, SDKs, CLIs, or many calls. Approval dialogs, transcript labels, save continuation, error guidance, and owner-aware task-settlement handling are clearer and safer.
- Mobile composers now keep Enter available for multiline prompts and accept suggested text on the first tap without a soft-keyboard blur discarding the suggestion.
- Operators get trustworthy password-reset delivery and pull-request conflict diagnostics, while abuse limits no longer trust caller-supplied forwarding headers that can be rotated to evade request ceilings.
- Resolved pull-request review offers now leave the conversation once follow-up work starts, and nested tool calls keep the correct tool-specific icons inside expanded activity groups.
- Expired web Sessions now return through sign-in to the interrupted page, and Blank slate task launches from Discord, pull-request discussions, and Linear no longer fail by treating the workspace sentinel as an environment ID.
- Session workspaces now prioritize running task panels, show the total number of open recent pull requests on Home, and filter Sessions by the full pull-request provider, host, repository, and number identity.
- Active voice conversations no longer send duplicate reply notifications through connected chat or email providers, while ordinary web Sessions keep the existing fallback delivery behavior.

## 1.9.4 (2026-09-15)

Roomote 1.9.4 adds self-service password recovery and clearer cross-surface Telegram replies while making integration keys easier to enter, strengthening inbound email safety, and improving delivery diagnostics, artifact tables, and transcript resilience.

### Highlights

- Request a password reset directly from sign-in on deployments configured with Email (AgentMail).
- See the originating web message quoted when a cross-surface conversation replies in Telegram.
- Open requested integration-key forms automatically and return to them from a persistent Session card.
- Strengthen inbound email protection and delivery diagnostics while keeping artifact tables and transcripts resilient.

### Minor changes

- Telegram replies now quote the authenticated sender and message when a follow-up was sent from the Roomote web app, keeping cross-surface context visible above text and image responses without changing ordinary Telegram replies.
- Email/password users can now request a one-hour password reset link directly from sign-in when Email (AgentMail) is configured, while deployments without AgentMail keep the admin-assisted recovery path and public responses do not reveal whether an account exists.

### Patch changes

- CSV and TSV artifact previews now align row numbers with the first line of adjacent cell content, including rows with multiline values and whether the first row is treated as headers or data.
- Inbound email now requires a passing DMARC result before Roomote trusts the sender as a verified account. Messages without a pass are silently dropped before account matching, replies, or refusal limits, preventing spoofed sender addresses from triggering email to victims.
- When an agent asks for an integration key in a Session, the key dialog now opens on its own for the Session owner, and a small "Add your <service> key" card stays at the end of the conversation until the key is saved, so the dialog is always one click away even after it was dismissed. The agent's link keeps working as before.
- Session and task transcripts now render skill results that omit output instead of falling back to the client-side exception page.
- Webhook and pull-request review delivery outcomes now emit searchable, correlation-friendly operational events, so operators can follow Telegram and GitHub activity from receipt through persistence, dispatch, and final delivery without logging message content or credentials.

## 1.9.3 (2026-09-15)

Roomote 1.9.3 makes integration keys personal and reusable, improves artifact and activity inspection, routes notifications more intelligently, and strengthens background delivery, upgrades, and pull-request review workflows.

### Highlights

- Add, reuse, and revoke personal integration keys across every Session and coding task you own.
- Scan tabular artifacts more easily and inspect the skills, reasoning, and tool details behind agent activity.
- Keep background Session delivery moving with deadlock prevention, worker recovery, queue health diagnostics, and stale-review guards.
- Route notifications to the chat platform you chose most recently and recover self-hosted upgrades from transient Postgres disconnects.

### Patch changes

- Background Session delivery is more resilient: review-feedback dispatch no longer stalls BullMQ through a database lock cycle, and operators get a queue-processing watchdog plus `/health/bullmq` diagnostics when a worker is alive but no longer processing jobs.
- After an integration key is saved through a Session, the transcript now shows a short, friendly continuation instead of exposing the technical instruction used to resume Fast.
- Expanded activity groups now preserve reasoning and nested Session details while letting users inspect each tool call through the same shared detail view used elsewhere in task and Fast Session transcripts.
- Fast now prepares an integration key directly when a linked SaaS resource needs one, without first probing public access or delegating that probe to a coding task. The secure approval link opens the integration-key dialog correctly, and Fast no longer asks users to enable a setting that is already available.
- Fast now recognizes when a request needs a service with no connected integration and offers to use an owner-provided integration key instead of asking for screenshots, requiring an administrator-installed connector, or launching work to build one. When integration keys are disabled, Fast points to the correct Experimental setting.
- Integration keys now belong to their owner instead of one Session, so every Session and coding task that owner starts can use them until they expire or are revoked. Users can add, review, and revoke keys directly under Settings > Integrations without first asking an agent to prepare an approval.
- Session secrets are now called integration keys throughout Roomote and live under Settings > Integrations for every user. Self-hosted deployments using the optional dedicated proxy hostname should replace `R_SESSION_EGRESS_PROXY_HOST` with `R_CREDENTIAL_EGRESS_PROXY_HOST`; the API path and worker settings now use the credential-egress name as well.
- Roomote code-review checks now recover from transient GitHub summary-read failures and report a neutral, linked diagnostic when the summary remains unavailable instead of incorrectly failing as though no review result was published.
- CSV and TSV artifacts are easier to scan: gallery cards show abstract table previews, wide tables scroll without clipping columns, and users can choose whether the first row should be treated as column headers.
- Telegram now resolves automatic pull-request review offers in place, removing stale controls and keeping the confirmation with the original review summary instead of posting a separate reply.
- Fast Session and coding-task transcripts now show which skills were actually loaded, keep skill instructions private, and prevent agents from claiming that a listed but unloaded skill was used.
- When an absent web user needs a new personal notification thread, Roomote now prefers the Slack, Teams, Telegram, or Discord platform that user most recently chose to start work while preserving existing Session threads and the standard provider fallback order.
- Self-hosted upgrades now retry the bundled database migration runner when Postgres briefly drops its connection, avoiding a failed deployment when the transaction can safely restart while still failing immediately for migration and SQL errors.
- Automatic pull-request review follow-ups now confirm the pull request is still open before launching or resuming work, and retire deliveries that have remained stuck for too long, preventing stale feedback from reopening completed work days after a pull request merged.

## 1.9.2 (2026-09-15)

Roomote 1.9.2 makes artifacts easier to inspect, restores reliable Session starts and sandbox provisioning, and improves live activity, Settings clarity, and Session-secret operations.

### Highlights

- Preview CSV and TSV artifacts as accessible tables while keeping the complete source available.
- Start member web Sessions reliably and recover hosted sandboxes from transient bootstrap failures.
- Follow live agent activity in one collapsible block and get clearer errors, labels, and accessible actions in Settings.
- Run Session service-token traffic entirely through the API-side proxy without the former gateway and connector configuration.

### Patch changes

- Roomote agents now present caveats about a user's chosen method as suggestions instead of corrections and describe their own fixes and checks without unrequested verdict language.
- Task and Session transcripts now show each live work stretch in one stable, collapsible activity block that keeps the latest action legible without hiding detailed tool history.
- Non-admin members can start web Sessions again without an admin-only setup check rejecting the first turn as unauthorized.
- Remove the external Session egress gateway and its Docker connector sidecar. Every sandbox provider, Docker included, now delivers Session service tokens through the API-side proxy, so no gateway image, connector certificates, host firewall rules, or `SESSION_EGRESS_*` / `R_SESSION_EGRESS_GATEWAY_TOKEN` settings are needed; those variables are no longer read. Docker runs keep their ordinary network policy and no longer require a dedicated gateway network; task networks created under the old connector path still have their host firewall chains removed at teardown.
- Modal, Azure, and Daytona sandboxes now retry transient transport failures during bootstrap on a fresh instance while deterministic installation failures still stop immediately.
- Settings now distinguishes custom automation load failures from an empty list, labels model metadata across desktop and mobile, and gives each communications provider setup action a distinct accessible name.
- CSV and TSV artifacts now open as accessible, bounded table previews in task and Session artifact viewers, with source view still available for the complete loaded content and clear warnings for malformed or truncated data.

## 1.9.1 (2026-09-15)

Roomote 1.9.1 brings Session secrets to every hosted sandbox, adds cross-surface chat actions and guided delegation discovery, and improves Voice, Session, provider, email, and deployment reliability.

### Highlights

- Use owner-approved Session secrets safely from coding tasks on every hosted sandbox provider, including services with custom credential headers.
- Read Slack or Discord context and post verified Slack updates from any Fast surface, with optional peer-conversation follow-ups in Slack.
- Find useful work to delegate through a guided interview available from Home and natural-language requests.
- Open large task transcripts faster and get more reliable Voice, endpoint setup, wakeups, Session views, and AgentMail formatting.

### Patch changes

- AgentMail now renders safe links and rejects unsafe protocols with a forward-only Markdown parser, preventing crafted messages from stalling outbound email formatting.
- Fast can now read authorized Slack or Discord context from any chat surface and post explicitly requested updates to verified Slack destinations, with workspace, channel-membership, and linked-account checks preserved across platforms.
- Endpoint-backed inference providers can now save valid configuration during temporary model-discovery, compatibility, rate-limit, network, or upstream failures, while invalid URLs, rejected credentials, and exhausted credits remain blocked.
- Add a guided delegation interview, trigger it from natural-language requests about how Roomote can help, and make it the first optional onboarding suggestion on Home.
- Large task transcripts now open from a bounded recent window and load older messages as you scroll, avoiding unbounded initial loading while preserving live updates, position, and retry controls.
- Memory disclosure is now consistent for everyone: Roomote identifies a materially useful remembered fact and explains how it informed the work without requiring the former per-user Therapist Mode setting.
- Deployments now run MinIO from Roomote's own `ghcr.io/roocodeinc/roomote-minio` image, built from the final MinIO community source release, instead of the retired upstream images. The same image provides the `mc` client used to create the artifact bucket, so the separate `minio/mc` image is gone. Existing `/data` volumes are unaffected.
- Deliver Session service tokens to coding runs on every hosted sandbox provider. Daytona, E2B, Blaxel, Box, and Azure runs now receive substitute tokens and the API proxy base URL the same way Modal and Roomote Cloud runs do, gated by the Session owner's Session secret tools setting. No deployment configuration is required.
- Deliver owner-approved Session service tokens to coding runs on Modal and Roomote Cloud. When the Session owner has Session secret tools enabled, the controller registers the run after bootstrap and the worker receives substitute tokens, the service manifest, and the API proxy base URL; the model calls approved services through the proxy with ordinary HTTP clients while the real key stays in the API. No deployment configuration is required.
- Add the API-side session egress substitution proxy at `/api/session-egress/<grant>/<path>`, so attached coding runs on compute providers without a per-workload connector can call an owner-approved origin with an ordinary HTTP client and a substitute token while the real credential stays in the API.
- Session views now include every ready Session in the Ready filter and render transcript timestamps without time-zone-dependent hydration failures.
- Session secret grants can name any credential header, not only `authorization`, `x-api-key`, and `api-key`, so services that authenticate with their own header such as `private-token` or `x-shopify-access-token` can be approved. Request-shaping headers remain refused, and a scheme is still only accepted on `authorization`.
- Log bounded, nonsecret reason codes when Session-secret tools and HTTP integration requests fail closed, so operators can diagnose a denial from server logs. Client-facing messages are unchanged and no path, header, body, credential or upstream error text is logged.
- Guide agents through Session secrets end to end: Fast checks existing approvals before preparing, reads through the broker, and launches attached coding tasks for scripts, SDKs, and approved writes; coding tasks get worked examples for the proxy base URL and clear meanings for its error responses; tool descriptions no longer call the broker read path deprecated. The public Session secrets page describes the feature as shipped.
- Slack Session owners can opt into peer conversations so eligible human follow-ups continue reaching Fast after another person is mentioned, while direct Roomote mentions and established routing behavior remain unchanged by default.
- Voice and dictation controls now present one focused composer mode at a time, preserve typed drafts across calls, show live call status and microphone controls, and allow a longer natural pause before browser dictation ends.
- Deployment admins can now turn Voice off and back on from Settings > Integrations even when the Voice key is provided by the `R_VOICE_OPENAI_API_KEY` environment variable. The environment key decides which OpenAI account pays for Voice; the deployment decides whether Voice is on. A key saved in Settings is kept while Voice is off. The card no longer names the environment variable.
- Scheduled wakeups now deliver their final result or blocker when they successfully cancel themselves after completing the monitored condition, while independently canceled or archived wakeups remain silent.
- Webhook cleanup now retains its three-day default when environment validation is intentionally skipped, preventing repeated cleanup failures without changing validated deployment overrides.

## 1.9.0 (2026-09-13)

Roomote 1.9 adds a native Telegram Fast experience, Session-owned Goal Mode, direct pull request merging, and more adaptive setup and workspace flows.

### Highlights

- Work with Fast natively in Telegram, keep Goal Mode running across Session turns, and reply to personal Session notifications while away from the web app.
- Complete deployment setup conversationally and start all-repositories work without cloning every repository up front.
- Merge pull requests, maintain shared custom skills, and opt into memory-informed Home suggestions directly through Fast.

### Minor changes

- Fast can now update shared custom skills by exact catalog ID, with atomic exact-text or full-content edits and version protection that prevents stale changes from overwriting newer work.
- Fast can now merge pull requests directly across supported source-control providers after an explicit request, while preserving provider checks, permissions, head-version safeguards, and post-merge verification.
- Telegram now delivers Fast replies, edits, private-chat drafts, and compact Session footers as native rich messages, with live streaming and links back to active work.
- Telegram users can now start Goal Mode for an active task with `/goal`, keeping goal-directed work in the same chat or topic without switching to the web app.
- Telegram now shows Fast-delegated coding work in one compact, editable live message with topic-aware routing, expandable progress, elapsed status, and a direct link to the selected task.
- Users who leave the web app can now receive a personal notification when a web-started task completes, fails, or is canceled, with a direct link back to the task.
- Automation Results now automatically leave the unread inbox when their sole Roomote-created deliverable pull request merges, with consistent behavior across supported source-control providers and event ordering.
- Deployment setup is now conversational and agent-led, with trusted in-thread cards for source control, integrations, sandboxes, starter work, and automation recommendations that adapt to completed or skipped choices without blocking the conversation.
- All-repositories coding workspaces now start from a repository index and check out only the repositories a task needs, avoiding slow or stalled startup caused by cloning every active repository in advance.
- Users can opt into experimental Home suggestions generated from their own recent completed task memories, with privacy-filtered sources, background precomputation, resilient static fallbacks, and support across configured helper-model providers.
- Web Session notifications now arrive when an absent user needs to review a response or provide input, carry the actual reply into one personal provider thread, and accept replies that continue the same Session or pending task without duplicate or stale notifications.
- Goal Mode now belongs to the Fast Session instead of one child task, so Roomote can pursue an objective across turns and delegated tasks, continue automatically within a bounded budget, and preserve goal state across web, Telegram, and Discord conversations.
- Session owners can now approve narrowly scoped API keys through a secure form without placing credentials in chat or agent context. Fast and attached Docker coding runs can use approved keys only for the selected public HTTPS origin, allowed methods, and lifetime, with revocation and expiry enforced before requests and responses.
- Cloud users now explicitly accept the experimental Voice data flow before their first call, before microphone capture or OpenAI contact begins. The consent explains that audio, transcripts, and workspace context are sent to OpenAI, is stored per user, and does not change self-hosted Voice behavior.

### Patch changes

- Roomote Cloud hides managed Email configuration that members cannot change, while continuing to show the deployment-provided address and connection state.
- Deployment setup rejects malformed domain names before they can produce invalid routing or certificate configuration.
- Fast now handles incomplete skill lookup arguments and unavailable skill sources without hiding valid skills, and integration discovery reports exact filter misses instead of returning an ambiguous empty result.
- Mobile navigation makes recent Sessions easier to reach and moves Session switching into a responsive left rail that keeps the current conversation usable.
- Telegram replies now preserve paragraphs, lists, reply context, and supported Markdown consistently, split long responses without losing content, and avoid adding redundant reply quotes.
- Session history is clearer: internal timer receipts and redundant failed-tool labels stay hidden, task memories identify their initiating member, and the Experimental Results setting accurately describes its available features.
- Tasks launch in the intended environment more reliably, and task-list failures now offer a retry instead of leaving users stranded on an error state.
- Telegram conversations are more reliable across attachments, voice messages, topics, automations, reviews, mentions, and interactive prompts, with stable titles and icons, correctly threaded reports, clearer automation headings, durable review actions, and stale controls removed when they are no longer usable.
- Telegram live coding progress stays stable through short and resumed Fast turns, and successful tasks keep their last useful update instead of being replaced with a generic completion message.
- Voice conversations follow active coding tasks more consistently during calls and render transcript whitespace cleanly.
- Automation reports use consistent default destinations across communication providers, while Fast widgets and their shareable links remain available across providers and resumed background turns.
- Automation Results are easier to scan and act on across desktop and mobile, with clearer priority markers, accessible in-place expansion, restrained Markdown styling, and safe links for URLs and repository-backed pull request references.
- Task prompts now reject attachments that failed to download instead of silently launching work without the requested file.
- Results, Analytics, Environments, recent Sessions, Memory settings, and sandbox provider status now distinguish failed initial loads from empty data and offer an in-place retry while preserving already loaded content.
- Signed-in users no longer remain on the login page, and safe local return paths now resume the requested page without allowing external, protocol-relative, or sign-in-loop redirects.
- Custom automations can now run for discoverable Slack channels even when the local channel cache has no row, while ambiguous, inaccessible, or unverified workspace matches continue to fail closed.
- The web app now preserves composer focus after sends, announces integration validation errors to assistive technology, stabilizes optimistic avatars, labels collapsed navigation actions, and keeps rendered text artifacts readable on wide screens.
- Fast sessions now reject integration tool calls that pass undeclared argument keys, such as chat history bounds wrapped in a stringified `args` field, with an error naming the accepted arguments. Previously the MCP server silently dropped those keys, so the default 24-hour history window applied and the model kept repeating the malformed shape.
- Fast Sessions now see the names and descriptions of instance skills and inline environment skills in every turn, so Roomote recognizes a matching playbook from the request and loads it without being asked. Previously skills were only discoverable after the model chose to call `list_skills`, so custom skills from Settings > Skills went unused unless a user typed `$skill-name`. Marketplace and repository skills stay on demand; the prompt names each environment's marketplace sources so the model knows when to look them up.
- Closed agent panels now stay dismissed when users navigate away from a Session and return, while explicitly reopening or deep-linking a task still restores its panel. Thanks to @PierrunoYT for contributing this improvement.
- Chat channel history results are now bounded to the newest messages that fit a fixed size, with a note telling the agent how to page further back, instead of being cut mid-JSON by the agent's output limit.
- Long reasoning turns now stay connected through silent inference-provider gaps instead of resetting the stream, aborting in-flight tools, and regenerating the same work. The inference gateway sends standards-compatible SSE keepalives without changing model events or non-streaming responses.
- Conversational setup no longer stalls when a model carries a qualifier from the previous capability into the next offer. Roomote now ignores qualifiers that do not apply while continuing to validate source-control providers and integration choices when they do apply.
- Blank slate workspaces now configure Git for every run and, when the deployment has active repositories, can check out authorized repositories on demand and deliver pull requests without switching workspace types. Blank slates remain credential-free when no repositories are available.
- Normal Sessions can now start tasks regardless of onboarding's starter-work state. Setup-only recommendations, launch gates, and onboarding state changes remain confined to the canonical setup Session, while ordinary integration connection cards continue to work.
- MinIO and the MinIO client are now pulled from quay.io instead of Docker Hub, where the images were removed. The pinned versions and digests are unchanged, so existing artifact volumes are unaffected.
- Coding tasks now retry within the existing bounded provider-recovery flow when a provider interrupts an in-flight tool call and leaves the turn idle, instead of incorrectly settling as complete with an aborted edit or other unfinished work.
- Session composers now keep focus when task panels expand automatically or become ready later, so users can continue typing without focus jumping into a delegated task. Deliberately selecting a task still focuses its prompt as expected.
- Temporarily hide Session-secret tools behind a default-off user experiment while hosted credential access is unavailable. Existing configured integrations remain available.

## 1.8.2 (2026-09-14)

Roomote 1.8.2 restores reliable Slack channel history reads in busy channels.

### Highlights

- Read recent Slack channel history without scanning the channel's entire backlog or reporting misleading permission errors.

### Patch changes

- Fix Slack channel history reads failing in busy channels. Time-bounded reads now pass the bound to Slack instead of paging through the whole channel, and the error returned to the agent names the underlying Slack failure.

## 1.8.1 (2026-09-14)

Roomote 1.8.1 restores Azure-backed delegated coding tasks and reliable Fast skill lookups on OpenAI models.

### Highlights

- Run delegated coding tasks through Azure providers without inference-gateway authentication failures.
- List and load Fast skills reliably when OpenAI models supply optional tool arguments.

### Patch changes

- Delegated coding tasks using Azure OpenAI or Azure AI Foundry now authenticate through the inference gateway instead of failing before the provider request begins.
- Fast `list_skills` and `load_skill` now tolerate null and filler optional arguments, return useful validation errors, and keep packaged and instance skills available when an optional scoped source fails.

## 1.8.0 (2026-09-11)

Roomote 1.8 adds a durable automation results inbox, private personalization, more flexible setup and environments, and faster independent delegated work.

### Highlights

- Review durable automation reports and suggested follow-ups by priority, then clear them or turn them into editable Session work.
- Configure optional integrations through more reliable guided setup, and create environments that provide tools or services without cloning repositories.
- Personalize how Roomote works with you through encrypted private instructions and optional conversational learning.
- Finish multi-scope requests sooner when Fast can safely delegate independent coding work in parallel.

### Minor changes

- Review durable automation reports and suggested follow-ups in an opt-in Results inbox, ordered by priority and recency, then clear them or turn them into editable Session work.
- Guided setup can discover supported document, monitoring, and project-tracking integrations, while structured questions and saved answers now remain reliable across reloads, retries, and recovery.
- Fast proactively launches independent, non-overlapping coding work in parallel when doing so can complete a multi-scope request sooner.
- Personalize how Roomote works with you through encrypted, private instructions and optional conversational learning, with stable per-participant behavior throughout each Fast conversation.
- Create environments without repositories for workspaces that provide services, tools, variables, integrations, ports, or guidance without cloning source code.

### Patch changes

- Custom automation cards show the next scheduled run in the deployment timezone and refresh it when the displayed occurrence becomes due.
- Email setup gives unverified members an achievable admin-assisted path when verification delivery is unavailable, and oversized Fast replies retain their trusted reply footer.
- Fast reports actionable MCP tool failures instead of presenting upstream validation errors with empty structured data as successful results.
- Clarify how environments help Roomote verify its work.
- Pull request feedback reaches idle Fast Sessions promptly while delegated tasks continue, while still waiting when the Session is actively responding.
- Visual proof work continues with an honestly disclosed representative UI when genuine application state is unavailable instead of stopping at the first infrastructure limitation.
- Recent Sessions show the current user's genuinely latest work, reveal full truncated titles on hover, and keep the shared rail responsive while a selected Session loads. Thanks to @stea9499 for contributing the title improvement.
- Coding agents wait for Roomote-managed Docker startup instead of launching duplicate services and can install a necessary system dependency inside the disposable sandbox when authorized work requires it.
- Sandbox tasks can no longer launch nested Roomote tasks through run-scoped credentials, while authenticated users and Fast retain their supported launch paths.
- Fast-delegated tasks keep user interaction in their parent Session while retaining task workspaces for execution details, steering, previews, artifacts, and resumption.
- Task controls show actionable feedback when a stop attempt fails and remain available for a retry instead of failing only in the browser console.
- Voice conversations start with the selected GPT-Live voice, survive phone rotation, release call resources after terminal connection failures, show the Call ended marker, and keep internal delivery rows out of web transcripts.
- Voice previews now say when the OpenAI key lacks the Audio model permission instead of a generic failure.
- Voice answers greetings and small talk itself again instead of starting a Fast turn for every utterance, which doubled replies and read out of order; it still never states facts about code, tools, or the product without Fast.

## 1.7.0 (2026-09-11)

Roomote 1.7 adds natural voice and email conversations, smarter follow-through for delegated work, richer automation controls, and clearer usage insights.

### Highlights

- Talk with Fast Sessions through configurable GPT-Live voices and previews, or continue Roomote work and private automation reports over email with AgentMail.
- Let Fast quietly follow delegated coding tasks, surface meaningful developments, and correct work that drifts from the request.
- Add natural-language routing rules to built-in automations and manage existing pull requests across supported providers.
- Track token usage alongside spend in Cost Analytics, including historical totals when tasks are deleted.

### Minor changes

- Use Email through AgentMail as a replyable Roomote channel for task requests and outcome-first custom automation reports, with inbox-scoped setup, durable threads, signed answers, verified-account safeguards, and verification status and resend controls in Linked Accounts.
- Built-in automations can use natural-language Additional rules for repository scope, per-repository routing, and report guidance.
- Track token usage alongside spend in Cost Analytics with a total-token trend line, provider and model totals and averages, and token-aware drilldowns.
- DeepSeek V4.1 Flash replaces the dated Flash recommendation across OpenRouter, Vercel AI Gateway, and OpenCode Go.
- Fast Sessions quietly follow launched coding tasks, report meaningful developments, apply evidence-backed corrections until work settles, and distinguish task-history checks from incoming task reports.
- Agents can close, reopen, retarget, and edit existing pull requests across supported source-control providers without creating replacements.
- Weekly Manager Stats includes a daily created-versus-merged pull request chart and starts enabled on new deployments once a destination is configured.
- Unify shared and environment-specific skills in one searchable Settings catalog with availability filters and a marketplace dialog.
- Talk naturally with Roomote from Fast Sessions, with deployment-wide voice selection and previews while GPT-Live handles audio and Fast handles every utterance with the Session's model, tools, and context.

### Patch changes

- Custom automation task models can be changed only by the automation owner or an administrator.
- Built-in automation switches clearly show whether each automation is enabled or off.
- Saved automation cards show cadence in the deployment scheduling timezone used for execution.
- Fast Sessions can manage reminders and automations directly again without a scheduling-discovery step.
- Fast Sessions can use deployment-wide custom remote MCP integrations without exposing upstream credentials.
- Fast Sessions honor saved Routing Rules when selecting an environment or delegated coding-task model.
- Source-control and Linear webhook redeliveries no longer risk repeating actions when the original audit outcome was not finalized.
- Route every voice utterance through Fast so product answers use the Session's tools, context, and safeguards instead of unverified direct voice output.
- Move focus into required follow-up fields and dependent selectors after committed choices in guided setup flows.
- Blank slate tasks no longer expose internal repository sentinels in task headers and filters.
- Independent Slack suggested tasks reliably start in separate execution threads and Sessions instead of sharing task context; rejected launches clean up misleading start messages and remain available to retry.
- Communication replies use compact live footers that keep running-task counts, pull request links, and Session links current as work starts and finishes.
- Preview Markdown artifacts directly in task and Session galleries before opening them.
- Coding tasks recover from exhausted transient OpenCode connection resets instead of stopping without a useful Session handoff.
- Stopping a coding task from a Session preserves its task, sandbox, and artifacts for later resumption instead of terminally cancelling it.
- Preview status and failure pages provide consistent responsive branding, explanations, and recovery actions across desktop and mobile.
- Keep pull request metadata refreshes state-neutral and distinguish later opt-in clean-review promotion from the refresh itself.
- Custom automation cards refresh persisted results after Run now without requiring a page reload.
- Slack requests no longer receive a redundant eyes reaction while Roomote is working.
- Cost Analytics keeps historical spend and token totals when tasks are deleted while hiding deleted-task details.
- Connected Sentry integrations expose the full admin-approved tool catalog instead of a stale static allowlist.
- Open a user's Sessions directly from their avatar in Session viewers and task messages.
- Session timer activity uses user-facing labels instead of exposing internal wakeup tool names.
- Automatic task follow-through timers stay out of the Session reminder list while user-created timer receipts clearly describe each action and reused schedule.
- Automations and Skills page controls stay visible on desktop while long settings lists scroll independently.
- The Automations list combines built-in and custom entries with consistent search, columns, responsive text, and alphabetical ordering.
- Voice transcripts no longer show pending spoken acknowledgements after a call ends when the associated request was never sent.

## 1.6.0 (2026-09-09)

Roomote 1.6 adds flexible sandbox and public-repository work, native conversation charts, leaner scheduling discovery, and more reliable Sessions and skill management.

### Highlights

- Run sandbox tasks without repositories or source-control credentials through the new Blank slate target.
- Present data as accessible native charts in Slack and Roomote web transcripts.
- Inspect public GitHub repositories from Fast and coding tasks without connecting each target repository.
- Opt into leaner scheduling discovery for ordinary Fast turns while preserving reminders and custom automations.

### Minor changes

- Sessions and custom automations can delegate sandbox work to a Blank slate target that starts without cloning repositories or requiring source-control credentials.
- Agent replies and delegated reports can present pie, bar, area, and line charts in Slack and Roomote web transcripts, with accessible data tables and text fallbacks for other chat providers.
- Fast and coding tasks can inspect public GitHub repositories through native tools without connecting the target repository or linking a personal account, while private access and writes remain connection-scoped.
- Operators can opt into progressive scheduling discovery for Fast Sessions, reducing the tools and guidance sent on ordinary turns while preserving reminder and custom automation behavior when scheduling is needed.

### Patch changes

- Newly started web Sessions show the submitted prompt immediately and reconcile ambiguous retries without duplicate messages.
- Fast can stop and resume an unresponsive delegated task without terminally cancelling it, while explicit cancellation remains terminal.
- Restore admin management for environment-specific skills in Settings, including custom skill editing and marketplace installation.
- Fix Blank slate custom automations so delegated tasks start without repositories.

## 1.5.1 (2026-09-09)

Roomote 1.5.1 makes Fast guidance and follow-up behavior more reliable, clarifies delegated review work, and restores Better Stack tool discovery.

### Highlights

- Apply deployment-wide Agent Guidance to every Fast turn and offer bounded monitoring when an eligible outcome remains unresolved.
- Distinguish code review agents from ordinary coding agents in Session task cards.
- Restore exact-name integration tool discovery for Better Stack operational triage.

### Patch changes

- Session task cards now label pull request review work as a Code review agent and use matching task descriptions, making review work easier to distinguish from ordinary coding tasks on desktop and mobile.
- Fast Sessions now apply deployment-wide Agent Guidance and reload saved guidance for each new turn, matching the behavior promised in Settings while leaving already-running coding tasks unchanged.
- Fast now evaluates bounded monitoring at eligible closeouts, offering a specific follow-up when an unresolved outcome can be checked while preserving consent, evidence, deduplication, and finite monitoring bounds.
- On-demand integration tools can be found reliably by exact name again, restoring capability discovery for Better Stack operational triage without weakening integration scope or authorization checks.

## 1.5.0 (2026-09-09)

Roomote 1.5 brings shared skills, more control over automations and coding tasks, and direct repository work across GitHub, GitLab and Bitbucket Cloud, alongside security and integration fixes.

### Highlights

- Share reusable skills and manage your own custom automations without launching a coding task or requiring administrator access.
- Explore repositories and perform supported GitHub, GitLab and Bitbucket Cloud updates directly in Fast, with provider-specific permissions and limits.
- Configure CI triage with natural-language rules, stop individual coding tasks from Session cards, and search large model selectors.
- Receive security and integration fixes, including reliable GitHub installation routing with explicit single-repository search scopes.

### Minor changes

- Admins can configure CI Failure Triage repository scope, per-repository report destinations and investigation guidance through natural-language Additional rules. Rules are validated when saved; ambiguous or unsupported selections preserve the prior configuration. Explicit repository restrictions are fixed at save time, and unavailable destinations stop delivery instead of silently rerouting it.
- Create reusable instance-wide skills directly in Sessions or Settings without choosing an environment or starting a coding task. Settings > Skills shows a shared catalog with creator labels and editing controls for creators and admins. Fast loads saved changes immediately, while coding runs refresh their catalog at startup. Existing environment and marketplace skills remain available through environment YAML, outside the shared Settings list.
- Update existing GitHub pull requests, request reviewers, post comments and review-thread replies, and add reactions directly from Fast without starting a coding task. These actions use the connected GitHub App and its repository permissions; creating or merging pull requests and writing repository files still require a coding task.
- Explore connected GitLab and Bitbucket Cloud repositories and update existing merge or pull requests directly in Fast using deployment OAuth connections. GitLab supports title, description and close/reopen updates, notes and discussion replies; Bitbucket supports title/description updates, declining pull requests, and comments/replies. Focused repository questions can use configured provider APIs without a workspace, while broad investigations, edits and test execution still delegate to coding tasks. Creating or merging pull requests and writing files are not available through these bounded Fast paths.
- Members can create and manage their own custom automations, including schedules and report destinations, without administrator access. Management remains creator/admin-only, while signed-in deployment members can follow a Session link to read its timeline and linked task transcripts, logs, and artifacts without gaining action or secret access. Members' Session user filters offer their own identity and custom automations; built-in automations and deployment-wide controls remain admin-only.
- Stop an individual active coding task directly from its Session card without stopping the parent Session or sibling tasks. The control requires execution access, targets the displayed run and shows cancellation errors inline.

### Patch changes

- Better Stack operational scans resolve collection and cluster routing from current source metadata instead of reusing stale or guessed identifiers that cause queries to fail. Scans remain read-only and stop rather than guess when metadata is unavailable.
- Avoid unnecessary pull request retries and edits when Roomote assigns a valid Session follow-up link instead of the initial task link.
- GitHub tools select the matching installation when multiple installations of the configured GitHub App are connected, instead of failing or using an arbitrary installation. Reads require an active connected repository, and searches require exactly one explicit repo:owner/name scope; unscoped and multi-repository searches are no longer accepted, including on single-installation deployments.
- Refresh task memories when a pull request the task opened merges or closes unmerged, so recall can distinguish shipped work from abandoned approaches. Pull request outcomes are scoped to their source-control host and repository so matching names and numbers on another host cannot change unrelated tasks or memories; legacy links with unknown provenance are skipped.
- Publish GitHub review-thread replies immediately instead of leaving them in pending drafts. Submitting a review no longer accidentally publishes unrelated draft comments; an existing pending review is submitted only when explicitly selected.
- Require access to the underlying task before issuing a sandbox run token, preventing members from minting tokens for another owner's restricted automation tasks. Ordinary task collaboration and owner/admin access are preserved; already-issued tokens are not revoked.
- Search model selectors by model name or ID when more than eight models are available, while preserving provider groups and default selections. Search resets when the selector is reopened.
- Update dependencies to address security vulnerabilities in web requests, image processing, API parsing, YAML handling, and AI response reads, including critical Next.js fixes, while retaining AVIF image optimization.
- Keep Slack review cards focused on current findings and action buttons, without redundant resolving questions or superseded-review notices.
- Connect to Snowflake with encrypted PKCS8 RSA private keys and a passphrase instead of failing after the connection is saved. Passphrase inputs are masked, invalid keys and connection failures return credential-safe errors, and setup guidance covers secure key generation and staged rotation.
- Task follow-ups can be retried after a definite send rejection, and distinct instructions are no longer incorrectly blocked. Uncertain deliveries remain protected against duplicate sends.
- Show the configured task model and reasoning defaults in the model chip before its picker is opened, instead of briefly displaying a built-in reasoning level.

## 1.4.1 (2026-09-08)

Roomote 1.4.1 restores integration lookups that failed with GPT-5.x models.

### Highlights

- Use connected services such as Sentry, Linear, and Notion again without changing their connection settings.

### Patch changes

- On-demand integration lookups work again with GPT-5.x models in sandbox tasks and Fast, fixing failed requests to services such as Sentry, Linear, and Notion without changing their connection settings.

## 1.4.0 (2026-09-08)

Roomote 1.4 brings reminders, clearer shared Sessions, and richer video evidence together with easier automation setup and more reliable everyday work.

### Highlights

- Schedule reminders and bounded monitoring in a Session, see upcoming wakeups above the composer, and cancel them when they are no longer needed.
- Follow shared work through current-viewer avatars, recognizable task identities, and inspectable task reports.
- Share task recordings as native Slack videos and opt into higher-frame-rate capture for motion-heavy demos.
- Keep automation work in continuous Sessions, set up a Slack manager channel more easily, and choose GPT-6 Astra through additional providers.

### Minor changes

- Enable GPT-6 Astra through Vercel AI Gateway, GitHub Copilot, or OpenCode Zen alongside existing providers, subject to the connected account's model access. Existing model defaults remain unchanged.
- Expand Session tool exchanges to inspect image questions and results, instructions sent to delegated tasks, and incoming task reports. Consistent robot identities and task links make handoffs easier to follow, and expanded task inspections include the latest submitted report with secret redaction rather than unrelated assistant messages.
- OpenCode subagents can make one further nested delegation or consultation, allowing depth-two assistance while preserving each role's existing tool permissions.
- Custom automations now run through Sessions, report delegated results together with actionable suggestions, and keep accepted suggestions in their originating Session and, on Slack, its report thread, including suggestions published directly by Fast reports. Configured environments are delegation preferences rather than guaranteed sandbox launches. Configure a report destination for chat delivery; otherwise results remain in the web Session without an owner-DM fallback. Runs use the creator's credentials, automations without a creator need an admin to re-save them, and Run now reports queued rather than a launched task ID.
- Ask a Fast Session for a reminder or recurring check, including whole-second delays, and receive results in the same conversation. Fast can offer a specific, bounded follow-up when it can verify an outstanding outcome, scheduling it after you accept; explicit monitoring requests need no additional opt-in. Ongoing-process monitoring stays quiet without news and stops at the agreed bound or earlier when resolved or no longer actionable. Upcoming wakeups show countdowns above the Session composer and can be cancelled by the Session owner or an admin. Wakeups require no administrator to schedule, are limited to ten per Session, and are cancelled when the Session is archived; delivery is best effort rather than an exact-time guarantee.
- See other people viewing a Session through header avatars and name tooltips; your own avatar is omitted, and the indicator disappears when you are the only viewer.
- Connecting a Slack account can set up a public #roomote-managers channel when no Manager Channel is configured, without enabling automations or replacing explicit report destinations. Existing Slack apps need updated permissions, reinstallation, and an account reconnect to use automatic channel setup.
- Fast replies can deliver task recordings as native Slack videos, with authorized viewer links when delivery is unavailable. Motion-heavy demos can opt into native recording up to 60 FPS while ordinary recordings remain at 30 FPS. Existing Slack installations need the new files:write permission, and higher-FPS capture requires the updated recording runtime.

### Patch changes

- Automation avatars no longer show glaring white backgrounds in dark mode, while retaining their light-mode appearance.
- Azure sandboxes enable idle suspension by default and refresh the policy when reused, resumed, or restored. The policy follows the configured timeout, normally five hours; an explicit zero retains the opt-out.
- Web transcripts hide newly marked runtime navigation messages already represented by task cards while preserving ordinary conversation links.
- Previously uploaded artifacts remain available when a replacement upload is interrupted; unversioned task and Session lookups return the latest completed upload while explicit-version reads retain their existing behavior.
- Completed visual proof is no longer reported as timed out while subsequent review or pull request delivery continues.
- USD costs use consistent thousands separators, and Task Info refreshes inference costs when opened and while visible instead of leaving stale totals on screen.
- Device-code connections can recover after a failed authorization dialog is closed and reopened, including GitHub Copilot, ChatGPT, and xAI connections.
- Discord automation threads accept directed follow-ups without another mention, thread replies avoid invalid inline reply references, and coding-task links clearly identify newly started work.
- Honor custom automation model and reasoning overrides for the Fast session across initial and resumed turns, without applying them to delegated coding tasks.
- Fast retains follow-up messages sent during response closeout for the next turn, while reactions and platform events no longer discard parked questions or turn their retry notices into false interruptions.
- Merge announcements recover uniquely matched signed pull request screenshot URLs after redaction so images remain available without relaxing safe-fetch restrictions.
- Session board cards and long labels stay within mobile layouts, composer suggestion hints no longer overlap typed text, and mobile suggestion buttons use a shorter Accept label while desktop retains the keyboard hint. Automations uses more of the available screen width.
- Pull request feedback triage uses its configured queue retries after preparation failures instead of unnecessarily waiting for scheduled recovery.
- Provider qualification verifies a real structured tool call, rejecting misleading response text while accepting fragmented streamed function names and compatible local servers that require required-tool selection instead of named-function selection. Thanks to @DarthAffe for reporting [#1862](https://github.com/RooCodeInc/Roomote/issues/1862).
- Review handoffs resolve the acting user or human owner when messaging linked tasks instead of failing solely because the token lacks user context.
- Sentry triage uses the requested accessible organization, projects, and time scope rather than assuming internal project names or implicit defaults, and asks for clarification when the scope is ambiguous.
- New Sessions start correctly after resetting the model picker to Default.
- Keep Slack's working indicator aligned with the active Session turn, including durable retry waits and pauses between streamed replies while tools run. Late titles and stale turn cleanup no longer clear a newer turn's indicator, and settlement waits for pending stream operations. Background delegated tasks retain their separate activity indicators.
- Streamed output preserves UTF-8 characters split across chunks instead of replacing multibyte characters with corrupted text.
- Native tool activity shows clear read, edit, and skill-loading labels instead of treating result text as a tool name. Edit receipts identify a filename or file count, with consistent wording across running, completed, failed, and expanded activity. Grouped edit headers continue counting edit calls rather than distinct files.
- Correct Telegram custom automation setup guidance to explain that chat replies continue the automation Session, matching existing behavior.
- Discord and Telegram show native typing activity while Roomote thinks and uses tools during an active Session turn, including after intermediate replies.
- Slack provider-error notices show a compact warning and safe error message instead of repeating recovery instructions and the task link.
- Desktop Session and Task panels open and close smoothly while preserving surviving panel state and focus, and status text uses a consistent, slower shimmer. Manual resizing stays immediate, and reduced-motion preferences are respected.
- Roomote can choose screenshots, video, both, or no visual evidence according to what best demonstrates the work, without requiring an explicit video request.
- Environment-backed tasks can push and create or update pull requests in other deployment-active GitHub repositories on the same GitHub App installation, without requiring those repositories in the prepared workspace.
- MCP OAuth client registrations remain reusable through token expiry and reauthorization, with a 90-day inactivity window renewed by successful authorization exchanges and refreshes. Token lifetimes remain unchanged.
- Fix Monday account linking and token refresh failing with an invalid OAuth resource request.
- Reduce unexpected web logouts with 30-day sessions and reliable rolling renewal that updates both the browser cookie and database expiry.
- Settings stop repeatedly retrying failed model saves, restore saved values when available, and show a clear error. Saved Slack automation destinations remain visibly selected, and the Pull request delivery selector has an accessible name.
- Include all server-local-day pull requests in PR analytics on non-UTC deployments, matching task and cost reporting.
- Clarify that Roomote should not assign people work or commit them to plans without authorization, while remaining proactive about its own authorized work.
- Include the running build's commit SHA and deployment label alongside the release version in assistant prompts, explicitly reporting unavailable commit metadata as unknown.
- Brain-enabled host backups fail clearly when the index database cannot be checked, rather than reporting success with a potentially incomplete backup.
- Stable sandbox workers can be selected through the release-list fallback when GitHub blocks tag lookup.
- Make Doctor warn about whitespace-only Slack and Microsoft authentication configuration instead of reporting it as configured.
- Update qs to 6.16.0 to address denial-of-service and array-limit-bypass vulnerabilities in query and form parsing dependencies.

## 1.3.2 (2026-09-06)

Roomote 1.3.2 fixes integration tool schema errors that can prevent Fast conversations from responding.

### Highlights

- Keep Fast integration calls working with nested objects, arrays, and other JSON arguments.

### Patch changes

- Fix Fast turns failing with integration tool schema errors while preserving support for nested integration arguments.

## 1.3.1 (2026-09-05)

Roomote 1.3.1 improves Fast, Live Preview, chat, and MCP coordination while adding focused controls for pull request reviews and custom automations.

### Highlights

- Tailor a structured pull request review with an enabled model and reasoning effort, and inspect one custom automation prompt without loading every prompt into the conversation.
- Keep Fast responsive with earlier acknowledgements, an automatic retry for provider rejections, and Slack follow-ups that retain task screenshots.
- Poll compact Roomote MCP updates, recover Live Previews through actionable states, and keep integration arguments and organization-wide pull request links accurate.
- Process chat conversations more reliably, keep expanded Slack task cards open through live updates, and report Redis outages accurately through BullMQ health checks.

### Patch changes

- BullMQ health checks now fail promptly with HTTP 503 when Redis is unavailable instead of staying green or timing out, while healthy checks retain queue diagnostics.
- Telegram and Microsoft Teams no longer drop retried inbound messages after a transient webhook-processing failure.
- Admins can ask Roomote to inspect one custom automation's configured prompt without loading every automation prompt into the conversation.
- Fast now streams its acknowledgement before coding-task startup, so users see an immediate response while provisioning begins and do not receive duplicate acknowledgements after a restart.
- Fast retries an inference provider rejection once from a fresh Session instead of immediately asking you to try again, and terminal failures now identify the model and the provider's bounded, redacted error.
- Later Fast replies in Slack can attach screenshots from earlier tasks in the same Session across normal, streamed, and reaction-triggered replies, while foreign-task artifacts remain blocked.
- GitHub review-thread follow-ups now keep each human turn in one evolving Roomote comment with a single quieter footer, instead of adding a new bot comment whenever delegated work reports back.
- On-demand integration tools now accept their discovered required arguments, including nested objects and arrays, instead of rejecting otherwise valid calls.
- Live Preview now explains setup, startup, timeout, expiry, and wake failures with actionable retry states, while concurrent resume requests converge on the same recovery instead of showing a false failure.
- Organization-wide tasks no longer create invalid pull request links when a bare GitHub checkout result does not identify a concrete repository.
- Fast Sessions can run structured pull request reviews with an explicitly enabled model and reasoning effort, while omitted choices continue to use the deployment's review defaults.
- Fast now stays out of Slack conversations between people unless a message is directed at Roomote or it has a useful contribution, while mentions, direct messages, and directed follow-ups remain responsive without a separate `!fast` command.
- Expanded Slack task cards now stay open while live progress and terminal results update in place.
- Roomote MCP clients can poll compact cursor-based Session and task updates without repeatedly loading full transcripts or raw tool activity.

## 1.3.0 (2026-09-04)

Roomote 1.3 brings every supported entry point into continuous Sessions, expands the Session workspace with artifacts and live previews, and makes Fast conversations more resilient across shared and interrupted work.

### Highlights

- Work across several resizable task panels inside a Session, switch between conversation and execution without losing your place, and navigate recent Sessions and task workspaces more directly.
- Bring web, API, Slack, Discord, Microsoft Teams, Telegram, Linear, GitHub, GitLab, Bitbucket, Azure DevOps, and Gitea requests into continuous Sessions where Roomote can answer directly or delegate execution without losing the surrounding conversation.
- Collect live previews from delegated tasks in their parent Session and link source-control replies back to the active Session preview.
- Resume interrupted Fast turns without repeating requests or duplicating task launches.

### Minor changes

- Work across several resizable task panels inside a Session, switch between conversation and execution without losing your place, and navigate recent Sessions and task workspaces more directly.
- Bring web, API, Slack, Discord, Microsoft Teams, Telegram, Linear, GitHub, GitLab, Bitbucket, Azure DevOps, and Gitea requests into continuous Sessions where Roomote can answer directly or delegate execution without losing the surrounding conversation.
- Collect live previews from delegated tasks in their parent Session and link source-control replies back to the active Session preview.
- Add a supported agent-guided installation path that uses the standard Linux installer, can evaluate Roomote inside a Linux VM, and suppresses tokenized setup URLs from captured transcripts.
- Create durable artifacts from any Fast turn, open Session and task artifact links or images in the side panel, and use Build This to delegate a plan through its owning Session.
- Launch Roomote's structured pull-request review directly from a Session and keep automatic reviews attached to the Session that opened the pull request.
- Add an opt-in Therapist Mode that names the remembered fact that informed a Session or task without exposing internal Memory metadata.
- Add GPT-6 Astra to the curated model catalog for OpenRouter, OpenAI API, Roomote inference, and ChatGPT subscription, including ChatGPT Fast mode.

### Patch changes

- Make scheduled automation Sessions continuable from the web composer, show the configured custom prompt in their transcripts, keep tool results concise, and include verified pull-request numbers in Merge Announcer reports.
- Resume interrupted Fast work promptly when queue workers restart by draining active turns and handing unfinished work back immediately. Operators can tune the shutdown window with `R_BULLMQ_SHUTDOWN_DRAIN_MS`.
- Repair GitHub account linking and completed-deployment setup redirects, report missing GitHub App credentials clearly, preserve Linear refresh tokens during same-account reconnects, and work from the real Linear issue instead of its generated delegation stub.
- Keep image-containing Fast turns on the configured orchestration model, delegate image inspection only when needed, and reliably attach screenshots produced by delegated tasks to Fast replies.
- Let teammates participate in shared Fast Sessions from the web or a connected chat thread instead of rejecting every message from someone other than the Session owner.
- Resume interrupted Fast turns from their recorded conversation, replies, and tool results, including turns that launched tasks, posted their final reply, reacted with emoji, or started from a platform event. Unfinished work continues without asking the user to repeat the request or duplicating an identical task launch.
- Let Fast stay silent when people are talking among themselves instead of posting a false turn-budget error, while asking for a rephrase when a request directed at Roomote genuinely goes unanswered.
- Give self-hosted Fast processes more configurable temporary storage and report actionable filesystem diagnostics instead of failing opaquely when that storage fills.
- Keep delegated work attached to its parent Session, clear stale queued-message state after tasks start, return task results to the conversation, and render pinned launches as task cards.
- Accept unused optional MCP tool fields, respond to explicit GitHub mentions even in repositories excluded from unsolicited automation, and revalidate time-sensitive operational facts before acting.
- Improve task and Session readability with correctly clipped avatars, accurate demo-task start times, visible cost labels, restored environment badges, smoother artifact transitions, less intrusive initial activity, and a todo list that no longer crowds the prompt input.
- Keep Modal- and Roomote-backed task snapshots resumable beyond the previous seven-day application limit when the provider still retains them.
- Prevent parent task model, reasoning, and provider overrides from leaking into environment services or preview shell files while preserving explicit inference configuration.
- Start the first Fast conversation after a deployment without waiting several minutes for OpenCode to install its runtime plugin.
- Protect Roomote-reserved deployment variables from generic environment-variable updates and deletion.
- Preserve reviewer feedback across new commits, retire controls for outdated revisions, restart Roomote reviews from GitHub's Re-run action, and clear failed review checks after findings are resolved.
- Make starting and navigating Sessions clearer with recent-session access, rotating home prompts, a streamlined launcher, friendlier setup suggestions, and an optional judgment-first TODO review task.
- Keep Session timelines complete when events share a timestamp, collapse completed activity after conversation replies, and present tool activity in clearer product language.
- Keep Slack task progress visible and stable as threads grow, show live activity separately from final output, and explain when buttons on retired task messages can no longer be used.
- Render Slack links, channel references, and bare URLs correctly in web Session transcripts.
- Keep source-control conversations accurate by quoting the triggering comment, editing one reply throughout a Fast turn, linking forwarded Slack notifications to the exact GitHub comment, and resolving comment-edit endpoints safely.
- Revoke a removed user's existing run-token access to task artifacts while preserving deployment-owned task access.
- Require an explicit `@mention` before Roomote responds inside GitHub review threads, omit the redundant quoted comment there, and use a plain source-control reply footer.

## 1.2.4 (2026-09-04)

Roomote 1.2.4 completes setup from infrastructure readiness and makes unavailable product areas clear without interrupting the active setup Session.

### Highlights

- Finish setup without choosing optional starter work once infrastructure and repository prerequisites are ready.
- See which product areas become available after setup, with unavailable destinations disabled and explained.

### Patch changes

- Complete setup as soon as infrastructure and repository prerequisites are ready, while keeping setup-gated destinations visible but disabled with an explanation until setup finishes.

## 1.2.3 (2026-09-03)

Roomote 1.2.3 restores Fast Sessions for deployments that rely on the default task model.

### Highlights

- Start Fast Sessions with the default task model when no explicit model override is configured.

### Patch changes

- Use the task model catalog default for Fast sessions when no explicit orchestration or coding model override is configured.

## 1.2.2 (2026-09-03)

Roomote 1.2.2 strengthens deployment and setup reliability while making Slack-driven Fast conversations clearer and more consistent.

### Highlights

- Keep Brain, background jobs, and the controller available through service replacements and pending database migrations.
- Complete setup when an orchestration model sends placeholder questions alongside the trusted starter-work prompt.
- Resume the original Slack request through Fast after account linking instead of starting a separate task.
- Read linked Slack names and emoji reaction receipts in web transcripts.

### Patch changes

- Fixed the Brain (gbrain) service crash-looping after a deploy when its job worker found the queue lock still held by the container being replaced. The worker now retries within the lock's TTL instead of taking the whole service down, so a fresh or redeployed Brain comes up on its own.
- Render standard Slack and Microsoft Teams reaction receipts as emoji in Fast web transcripts without exposing the internal reaction tool activity, while leaving unknown workspace emoji names visible.
- Render Slack user mentions as readable, linked names in web task and Fast Session transcripts while preserving the original message text for replies and follow-up tasks.
- Fixed the setup session failing to offer starter-work choices when the orchestration model passes the trusted `setup_starter_tasks` preset together with placeholder questions. The preset now wins and model-supplied questions are discarded instead of rejecting the call, so onboarding no longer stalls at "choose your first work" on models that fill every optional tool parameter.
- Resume a Slack user's original request through Fast after account linking instead of starting a separate legacy task, while preserving the original message and thread context.
- Fixed the bullmq and controller services crashing during upgrades when they started before the database migration finished. On platforms that roll every service at once, a boot that reads a column the pending migration adds could exhaust the restart budget within seconds and stay down until someone redeployed it; both services now wait for the migration to land and then start normally.

## 1.2.1 (2026-09-02)

Roomote 1.2.1 restores Fast turns on OpenAI models and keeps Slack replies and usage alerts accurate.

### Highlights

- Run Fast turns on OpenAI models without immediate inference-provider errors.
- Keep streamed Fast replies in Slack complete and deduplicated when finalization fails.

### Patch changes

- Restore Fast turns on OpenAI models by sending a valid schema for user-input requests instead of failing immediately with an inference-provider error.
- Keep streamed Fast replies in Slack complete and deduplicated when finalizing the stream fails.
- Show concise inference-provider usage alerts in Slack without repeating synthetic percentage details.

## 1.2.0 (2026-09-02)

Roomote 1.2 enables contextual Message Suggestions by default, streams Fast replies across web and Slack, guides first administrators in one resumable setup Session, and recommends Gemini 3.8 Flash.

### Highlights

- Get contextual Message Suggestions by default in task and Session composers.
- See Fast replies stream into web Session transcripts and Slack threads while the model writes them.
- Guide first administrators through setup in one persistent, resumable Session.
- Recommend Gemini 3.8 Flash across Google Gemini, OpenRouter, Vercel AI Gateway, Requesty, and OpenCode Zen.

### Minor changes

- Let custom automations select a model-specific reasoning effort, including for delegated tasks launched from Fast, so admins can tune recurring work for cost and depth.
- Let replay-safe Fast turns survive process interruptions and provider retry waits by resuming durably on a live process without duplicate acknowledgements or repeated side effects.
- Add Gemini 3.8 Flash to Roomote's recommended model catalog and presets for Google Gemini, OpenRouter, Vercel AI Gateway, Requesty, and OpenCode Zen.
- Guide first administrators through source control, starter work, sandbox configuration, and optional automation recommendations in one persistent setup Session with recoverable progress.
- Let users reply to and manage live nested tasks directly inside Sessions, including attachments, commands, pending input, cancellation, and sleeping-task wakeup.
- Let each launchable Fast automation suggestion select its own named environment, all-repositories, or Fast target across Slack, Discord, Microsoft Teams, and Telegram.
- Let visual-proof runs use transparently disclosed simulated state when genuine setup is impractical, while clearly limiting the evidence to rendered appearance, layout, and interaction.
- Enable contextual Message Suggestions by default for task and Session composers.
- Let Roomote agents create and update Notion databases, data sources, properties, and views through the public API while leaving unsupported block reordering and hosted-MCP-only features unavailable.

### Patch changes

- Queue Fast automation runs durably before acknowledging them and report admitted work as queued, preventing long starts from timing out, duplicating launches, or appearing complete prematurely.
- Apply matching Dependabot or Renovate reviewers and assignees to dependency-remediation pull requests, while allowing automation-started PR delivery to fall back safely when no human attribution candidate exists.
- Keep task and Session views complete and readable by retaining linked and general subagent activity, restoring accumulated pull-request links without unnecessary wrapping, showing consequential outbound communication, and hiding internal discovery and duplicate reply-tool entries.
- Show a clearer "Tab to accept" hint for composer suggestions only while the task or Session reply box is focused.
- Make Review Code rely on current-commit CI results instead of rerunning repository validation suites, reducing duplicate validation time and compute.
- Expand privacy-safe Fast diagnostics with setup timing, model-request counts, aggregate token usage, and context-size signals without logging prompt, reply, or tool content.
- Make Fast conversations start and free up for follow-ups sooner by removing repeated tool setup and integration-discovery delays, overlapping Slack preparation, and ending inference after the reply is delivered.
- Paginate Blaxel sandbox inventory requests within the provider's page-size limit.
- Finalize hosted runs whose Modal sandbox is gone instead of repeatedly retrying maintenance for missing sandboxes.
- Keep Fast and task prompts lean by discovering remote integration tools only when needed, while preserving permissions and showing the invoked integration action clearly in transcripts.
- Show linked sender identities and readable display names in Fast and Fast-delegated Slack transcripts instead of anonymous avatars or raw Slack mention tokens.
- Expose timestamped provisioning and command output for new Roomote Cloud sandbox runs through compute-log lookups, including stdout, stderr, and failure diagnostics.
- Start self-hosted Memory from the published gbrain image matching the Roomote release by default while preserving custom image overrides.
- Recover Sessions whose terminal subagent remains unsettled after a provider timeout instead of leaving the parent Session running indefinitely.
- Stream Fast replies into web Session transcripts and Slack threads while the model writes them, then settle each stream into the finished reply with its usual content and links.

## 1.1.0 (2026-09-02)

Roomote 1.1 adds contextual message suggestions, clean-review handoff across source-control providers, Claude Fable 5.1, and stronger Fast and Session reliability.

### Highlights

- Get contextual next-message suggestions in task and Session composers, with simple keyboard controls and an optional admin setting.
- Hand clean Roomote-created drafts to human reviewers automatically across supported source-control providers without approving or merging them.
- Choose Claude Fable 5.1 from Roomote's curated model catalog across supported inference providers.
- Keep Fast follow-ups, interruption recovery, Session activity, and pull-request lifecycle updates accurate through busy or interrupted work.

### Minor changes

- Add Claude Fable 5.1 to Roomote's curated recommended-model catalog across supported inference providers.
- Let admins opt in to marking clean Roomote-created draft pull requests and merge requests ready for human review across GitHub, GitLab, Gitea, Azure DevOps, and Bitbucket Cloud without approving or merging them.
- Add optional helper-model-generated Message Suggestions to task and Session composers, with Tab acceptance, Escape dismissal, bounded conversation context, and an experimental admin setting.

### Patch changes

- Combine rapid same-user Fast follow-ups into one ordered update so every message reaches the active response together without losing attachments or durable history.
- Keep Build this work in the artifact's existing Session with its environment, branch, model, plan, routing, and retry identity.
- Repair stale setup-completion state when reseeding reused demo sandboxes so authenticated settings remain reachable without changing production onboarding.
- Prevent Fast custom automations from posting duplicate Slack reports when bookkeeping fails after the original report was delivered.
- Make Fast interruption recovery accurate and resilient by attributing causes, using honest restart copy, draining in-flight turns during API shutdown, renewing live-turn leases, and resuming the original unresolved request after a later nudge.
- Require Fast to send a text acknowledgement or delivered task kickoff before starting tool-driven work so a reaction alone cannot leave users waiting through silent execution.
- Route Linear issue discussion through the dedicated comment operation and surface the actual Linear tool error when a request fails.
- Ensure Ping telemetry, version checks, and instance reports always carry a non-empty application version, including when a release version is unavailable.
- Keep pull-request delivery and lifecycle reporting authoritative so successful remote creation does not appear failed when parent notification is delayed and stale child reports cannot contradict merged or closed events.
- Keep Session task activity and navigation accurate by showing running follow-up turns, removing redundant Roomote self-links from delegated-task kickoffs, and returning to the originating nested task after an artifact preview.
- Let Roomote MCP and other task-management callers inspect and continue valid user-facing Session links whether they contain the canonical Session ID or a retained Fast conversation identifier.
- Preserve authored Slack invocation text for Fast prompts and render installed Roomote app mentions as readable `@Roomote` text instead of raw bot IDs.
- Put inactive Roomote tasks to sleep after their pull request merges while preserving active or recently resumed work and keeping the parent Session state accurate.
- Deliver inference usage threshold alerts for ChatGPT, GitHub Copilot, and xAI Grok subscriptions alongside the existing finite-quota providers.

## 1.0.2 (2026-09-01)

Roomote 1.0.2 makes Fast follow-ups reliable and steerable during active work, moves artifact builds into Sessions, and strengthens conversational and unattended automations.

### Highlights

- Send follow-ups during active Fast responses without losing messages, with same-person corrections steering current work between completed tool calls.
- Create recurring automations from Fast conversations, and let unattended runs launch follow-on Sessions and coding tasks with trusted owner context.
- Build Markdown plans inside Sessions while preserving the selected environment, branch, model, and plan context.

### Patch changes

- Let unattended automation runs use their trusted owner context to start follow-on Sessions and coding tasks and attribute resulting pull requests, while ownerless runs remain restricted.
- Let deployment admins turn repeatable Fast work into recurring automations through conversation, with schedule confirmation, duplicate checks, and an optional test run after creation.
- Keep human follow-ups sent during an active Fast response durable across web and supported chat providers, so accepted messages run in order under the correct participant instead of disappearing.
- Let same-person follow-ups steer active Fast work between completed tool calls instead of waiting for the current response to finish, while preserving safe queued turns for other participants.
- Reduce noise in Sessions list and board views by removing active spinners while keeping needs-input and blocked badges visible.
- Start Markdown artifact builds inside a Session while preserving the selected environment, branch, model, and plan context, so retries recover the same delegated task instead of creating a standalone Task.

## 1.0.1 (2026-09-01)

Roomote 1.0.1 improves Session access and task navigation, brings automated Slack and Discord entries into Fast, and hardens Fast recovery, model defaults, and pull-request review follow-through.

### Highlights

- Share Session links across the deployment, see attached work in task-only Sessions, and keep task timelines consistently ordered.
- Route eligible Slack and Discord automation feeds through Fast, and let authorized Slack Fast sessions discover channels and post standalone updates.
- Open direct environment launches in their task workspace while keeping Fast retries, model defaults, and pull-request auto-resolve behavior reliable.

### Patch changes

- Route eligible Slack and Discord messages from bots, webhooks, and automated feeds through Fast first, while retaining direct task launch as a fallback so automated work is not dropped.
- Open the task workspace immediately after a user selects an environment and launches work from the web, instead of routing them through the owning Session first.
- Show and honor the deployment's Fast orchestration model in the new-Session picker instead of silently persisting the coding model default as a Session override.
- Recover Fast Sessions whose owner disappears during a quiet provider retry, preserving the silent short-retry experience while ensuring abandoned turns settle to a visible interruption instead of remaining stuck.
- Give Slack-originated Fast sessions authorized channel discovery and standalone posting while keeping reactions safely scoped to the current inbound message and honoring deployment-disabled tools.
- Keep pull-request auto-resolve enabled through temporary task snapshot gaps so later review and CI cycles retry automatic dispatch instead of showing duplicate review prompts.
- Make Sessions reliable and shareable across deployments: any signed-in user with the link can view and contribute like they can with tasks, task-only Sessions show their attached work, and concurrently attached tasks stay consistently ordered.
- Render Session and task start times in each viewer's local format without triggering hydration errors when the browser and server use different locales or time zones.

## 1.0.0 (2026-08-30)

Roomote 1.0 makes Fast the default entry point for conversations, enables Memory by default on new hosted deployments, and completes the Session-centered automation, analytics, and artifact experience.

### Highlights

- Start unpinned requests in Fast by default, while choosing an environment or repository still starts coding work immediately.
- Enable Memory by default for new hosted deployments and recall public Discord discussions, visible Linear issues, and richer Notion database properties.
- Follow conversations, delegated executions, artifacts, reviews, and costs in a searchable Session workspace across desktop and mobile.
- Continue Fast across supported chat providers, delegate parallel work with attachments, preview generated HTML safely, and announce default-branch changes.

### Major changes

- Make Fast the default entry point for unpinned Roomote requests across the web dashboard and supported chat providers, and enable Memory by default for new hosted deployments. Select an environment or repository when work should start directly in a coding task; existing deployments keep their current Memory setting.

### Minor changes

- Start and continue linked Fast conversations directly from Microsoft Teams and Telegram, matching the existing Slack and Discord experience.
- React to Roomote Fast replies across Slack, Discord, Microsoft Teams, and Telegram to provide context for a follow-up or let the conversation stay quiet.
- Announce default-branch pushes across supported source-control providers with concise, pull-request-aware summaries, direct change links, and durable Slack, Discord, Microsoft Teams, or Telegram destinations.
- Open Analytics on Costs by default and break out Session orchestration and Memory synthesis so teams can understand where inference spend comes from.
- Let Fast launch multiple independent coding tasks from one turn, forward image and supported file context into delegated work, and show nested startup progress without losing retries or results.
- Let Fast inspect GitHub Actions runs, jobs, and logs to explain CI failures while keeping the diagnostic path read-only.
- Open generated HTML artifacts as safely sandboxed previews with a source-code toggle, while keeping presentational widgets available in web transcripts and linked chat previews.
- Add public Discord discussions and visible Linear issues to Memory, preserve richer Linear planning metadata, and render readable Notion database properties for more complete recall.
- Let administrators enable Memory without a dedicated synthesis-provider key, enable it by default for new hosted deployments, and surface newly ingested pages within minutes instead of waiting for a later maintenance pass.
- Finish setup in one Roomote Session that launches and tracks selected starter tasks, with clearer guidance about the value and limits of hosted trial inference.
- Make Sessions the primary workspace for Roomote work, with dashboard launch and search, recent-session navigation, delegated execution details, artifacts, reviews, costs, stable titles, and responsive mobile layouts in one continuous conversation.
- Browse current and previous Roomote releases directly in the update dialog, with the latest release expanded and newer remotely detected updates kept visible even when their notes are not yet available in the running image.
- Open current and previous Roomote release notes directly from About Roomote in the existing in-app release-history dialog.
- Follow delegated work more clearly in Sessions with live nested-task activity, a conversation-wide artifact gallery, cleaner task details and navigation, and modernized search, filter, board, and list controls.
- Include one safely validated, representative pull-request screenshot in Slack Merge Announcer reports when the pull request provides a suitable image.
- Show richer task context throughout Sessions with accumulated pull requests, actor and source details, clearer status indicators, direct access to a sole running task, and full task workspaces for Session deep links.
- Make Roomote MCP Session-first so ordinary start, search, summary, message, and follow-up operations use Sessions by default while explicit task IDs continue to target individual coding tasks.
- Have Fast acknowledge substantive human requests before starting model-invoked work, using a brief reply or eligible Slack reaction without duplicating immediate answers, clarifications, or delegated-task kickoffs.

### Patch changes

- Keep Fast sessions quiet through short transient provider recoveries: retries stay silent unless the wait grows past 30 seconds, all retryable provider errors share a six-retry budget with bounded jittered backoff, and warm-session progress refreshes the recovery budget the way completed coding-task turns do.
- Queue delegated-task updates durably for their Fast parent so busy conversations process child progress and completion in order instead of rejecting or killing the parent event after 30 seconds.
- Keep pull-request review follow-through reliable by showing actionable feedback in Fast and standard web tasks, clearing resolved Roomote findings, preserving the correct destination branch and attribution, and avoiding duplicate review requests.
- Disable anonymous usage reporting in the bundled Infinity service so self-hosted local Memory embeddings stay quiet by default.
- Keep Fast Sessions stable through cold starts and refreshes by preserving conversation context, model and reasoning choices, generated titles, pull-request status, and recovery state without duplicate or stale transcript notices.
- Keep Slack Fast thread titles synchronized with generated and manually edited Session titles instead of leaving conversations labeled `Thread`.
- Show platform issue alerts sent directly to Slack deployment admins with the same actionable automation card used for configured alert destinations.
- Keep expanded tool-call details readable in Task and Fast transcripts by wrapping long YAML values within the transcript instead of clipping or overflowing them.
- Keep Session context accurate by including attached task inference spend in total costs, opening inline task links in their owning Session, and hiding running or artifact states when they no longer apply.
- Keep Slack-backed Sessions and automations reliable by deferring silent custom-automation delivery, suppressing no-op placeholders, validating Fast titles without retry loops, restoring clear Configure actions, and using the correct Merge Announcer icon.
- Restore required runtime dependencies in standalone deployment images while continuing to bundle in-app release history.
- Show the shared progress spinner while tool calls are active, then restore each tool or integration icon when the call settles.
- Let Fast mode discover, load, and explicitly invoke environment-scoped Settings skills while preserving built-in skill precedence and bounded access.
- Complete large Notion historical discovery scans in the fast continuation loop instead of spreading database-row traversal across weeks of scheduled passes.
- Keep tasks moving when visual proof takes too long by applying one five-minute deadline across capture, retries, and recovery before returning a graceful proof blocker.
- Include authorized Settings skills in Fast mode's unscoped skill inventory.
- Keep running nested-task activity visible when a Session is loaded directly or reconnects, while still hiding it during genuine new parent responses.
- Restore authorized deployment MCP tools in Fast advisor and judge consultations while keeping Fast-native orchestration and custom automation tools confined to the parent Session.
- Keep Fast conversations responsive through API restarts by closing out in-flight turns gracefully during shutdown, so replies no longer disappear and sessions no longer get stuck waiting on an abandoned turn.

## 0.45.1 (2026-08-29)

This patch restores complete Notion database discovery across Memory and the built-in Notion MCP.

### Highlights

- Find and ingest pages inside directly shared Notion databases even when Notion search omits them.

### Patch changes

- Discover pages inside directly shared Notion databases in Memory and let agents resolve the database through the Notion MCP even when Notion search omits its rows.

## 0.45.0 (2026-08-27)

This release adds secure hosted trial inference and self-run Brain model options, expands GLM 5.3 support, and improves reliability across Fast sessions, pull-request reviews, Memory, and chat.

### Highlights

- Start hosted deployments with secure, spend-capped Roomote trial inference and accurate cost reporting.
- Run Brain embeddings and reranking on self-hosted infrastructure with multilingual bundled defaults.
- Use GLM 5.3 and GLM 5.3 Flash across more existing inference providers.
- Keep Fast sessions, pull-request re-reviews, Memory ingestion, and chat reporting reliable through retries and resumptions.

### Minor changes

- Expand GLM 5.3 and GLM 5.3 Flash availability and recommendations across OpenRouter, Vercel AI Gateway, Requesty, OpenCode Go, Z.AI, and Z.AI Coding Plan.
- Offer secure, spend-capped Roomote trial inference during hosted setup, record its real model costs in task and cost analytics, and present the option with clearer onboarding copy.
- Let self-hosted deployments run Brain embeddings and reranking through their own OpenAI-compatible upstream, including an opt-in bundled CPU service with multilingual model defaults.

### Patch changes

- Include the Brain's memory volume and database state in supported self-hosted backup and restore bundles so memories survive host recovery consistently.
- Treat temporary Brain network outages as queue backpressure so infrastructure restarts do not exhaust individual memory write retries or require manual repair.
- Render Fast replies as rich Markdown in Discord guild channels instead of falling back to plain unformatted messages.
- Make suggested tasks in Fast automation reports launch reliably across Slack, Discord, Microsoft Teams, and Telegram while keeping each suggestion card's state in sync.
- Preserve the full Fast conversation context across resumed turns so follow-up answers continue from the existing thread instead of losing earlier messages.
- Keep Fast session sidebars and information panels usable on mobile by switching them to the same single-panel layout as task workspaces.
- Discover Notion pages and database rows that inherit integration access through shared parents, even when Notion search does not return them.
- Keep automatic pull-request re-reviews running after their previous sandbox shuts down and anchor each sync review on the head commit that was actually reviewed.
- Keep Standard tasks and Fast web sessions running through retryable inference-provider failures instead of ending the work prematurely.
- Briefly name the recalled insight that materially influenced an agent's approach without exposing internal memory provenance or identifiers.
- Keep Fast and standard agents identified as Roomote by removing OpenCode's conflicting injected identity prefix from their system prompts.
- Render automation report Markdown correctly in Slack while preserving the report's replyable thread footer.
- Use task-specific wording in Slack inline status updates so progress messages describe the work instead of exposing generic agent terminology.
- Make transcript tool activity easier to inspect by showing sanitized inputs and readable YAML details without hiding the corresponding tool results.

## 0.44.0 (2026-08-26)

This release adds shared memory, skill discovery, and presentational widgets to Fast sessions, expands automation delivery across chat providers, and improves session and pull request review reliability.

### Highlights

- Save durable context from Fast sessions and recall it in later work through connected memory providers.
- Discover and load packaged or repository-defined skills from Fast before delegating work.
- Render safe status cards, tables, plans, and other presentational widgets in Fast session transcripts.
- Deliver Fast automation reports across Slack, Discord, Microsoft Teams, and Telegram, with direct chat continuation where supported.

### Minor changes

- Deliver Fast automation reports across Slack, Discord, Microsoft Teams, and Telegram channel or direct-message destinations, with web continuation everywhere and direct chat continuation where the provider supports Fast session identity.
- Let Fast sessions discover and load packaged and repository-defined skill documents through bounded, session-safe tools without exposing filesystem access.
- Let Fast save durable preferences, decisions, corrections, and facts to shared memory so they can be recalled in later sessions, while supporting pluggable memory providers and making concurrent memory ingestion more reliable.
- Render safe presentational widgets such as status cards, tables, and plans directly in Fast session transcripts while keeping raw HTML confined to the sandboxed web view.

### Patch changes

- Deliver Fast custom automation reports to their owners through configured Slack direct messages, and fail runs clearly when their configured Fast destination cannot be resolved or supported.
- Reconcile image-only Fast replies with their canonical transcript events so optimistic messages do not remain duplicated or stale.
- Keep Fast sessions moving through retryable provider failures without repeating completed tool effects, and forward follow-up instructions to active tasks before posting the confirmation reply.
- Make Fast coding-task kickoffs clearer by describing the repository work and naming the target repository when it is known without exposing internal orchestration details.
- Restore web-initiated Fast turns in standalone production images by shipping native-tool runtime dependencies and removing stale generated tool files during setup.
- Honor each user's Fast response mode preference on the homepage even when the browser has a saved workspace, while keeping explicit environment links and active workspace choices ahead of the personal default.
- Deliver completed pull request review findings reliably by tracking the review lifecycle with structured metadata instead of variable status wording.
- Keep pull request review threads clear by removing stale action buttons when newer feedback arrives or an action is handled, while preserving the latest actionable controls across Slack, Discord, and Telegram.
- Settle Slack task cards when work becomes idle or waits for input, then return them to an active state when work resumes without losing delayed final output.
- Keep the current page visible while authenticated navigation loads and correct the label shown when an input request is cancelled.
- Show Slack pull request review resolutions as subdued context notes instead of prominent message sections after an action is handled.
- Show the redacted task memory submitted by an agent in the save tool result so users can inspect what was recorded without exposing secret-shaped values.
- Deliver Teams Fast automation reports and failure states to newly created owner direct messages by using the persisted session route when no active route row exists.

## 0.43.0 (2026-08-26)

This release brings Fast sessions into the dashboard, introduces a streamlined Memory experience, launches useful starter tasks directly from setup, and adds optional GitHub review checks.

### Highlights

- Start and continue Fast sessions from the dashboard with generated titles and live canonical transcripts.
- Browse and share individual memories from a streamlined Memory settings experience.
- Launch preselected starter tasks as soon as setup completes.
- Publish Review Code results as optional GitHub checks for branch protection and rulesets.

### Minor changes

- Start, title, inspect, and continue Fast sessions from the web dashboard with live canonical transcripts, while Slack and Discord replies link back to the same session view.
- Publish Review Code results as an optional GitHub check that teams can use with branch protection and rulesets.
- Use consistent Memory naming across Roomote and browse, focus, and share individual memories from a streamlined settings page with recovery controls when ingestion needs attention.
- Replace the final setup step with preselected starter tasks (speed up CI, security scan, fix test flakes, update dependencies) that launch idempotently as standard tasks when setup completes.

### Patch changes

- Keep Slack pull request status and resumed task previews accurate across ordinary, Fast-delegated, retried, reopened, and completed task paths.
- Keep Fast sessions useful across follow-ups and longer work by preserving native context through helper restarts, exposing deployment task inspection, responding naturally to corrections, and sharing concise progress when work takes time.
- Make pull request feedback and review checks more reliable by coalescing duplicate actionable notifications, completing checks when reviews finish, and showing provisional findings sooner when a summary is delayed.
- Render automation result tables in Slack with valid cell payloads, including tables with visually empty cells.
- Show the first user message as a Fast session's temporary title instead of exposing a timestamp-like conversation identifier while title generation finishes.
- Allow image-only prompts when starting or continuing Fast sessions while continuing to reject invalid images and empty messages.

## 0.42.0 (2026-08-25)

This release expands Fast and automation workflows, shortens initial setup, adds proactive usage and pull-request conflict alerts, and improves task recovery and chat reliability.

### Highlights

- Use current chat context and deployment-configured MCP tools directly from Fast, including automation management and all-repository delegation.
- Run custom automations in Fast and trigger Roomote from Slack workflows and third-party apps.
- Configure inference-provider usage alerts and notify originating conversations when Roomote-created GitHub pull requests conflict.
- Finish initial setup sooner, recover failed task starts with a prefilled launcher, and keep chat-backed work more reliable.

### Minor changes

- Run custom automations in Fast mode with consistent Slack reports, easier command-palette discovery, and validation focused on the automation being saved.
- Let Fast read the current chat context and use deployment-configured MCP tools directly, including custom automation management and delegation across all repositories.
- Configure inference-provider usage alerts with adjustable thresholds, destinations, deduplication, and multi-provider delivery.
- Notify the originating task conversation when a Roomote-created GitHub pull request becomes conflicted so the team can resolve it promptly.
- Retry failed task starts through an editable new-task launcher prefilled with the original prompt, model, and environment.
- Let Slack workflows and third-party apps trigger Roomote through explicit mentions.
- Finish initial setup sooner by making environment creation optional, then guide teams to create an environment from Home when they want verified repository setup.

### Patch changes

- Reduce GitHub App rate-limit pressure by coalescing installation-token requests, briefly caching the PR-notification hot path with one fresh-token retry, reusing bootstrap credentials until their scheduled refresh, and honoring provider backoff signals.
- Prevent chat-backed and Fast work from hanging during terminal delivery failures, provider recovery, or interrupted retries.
- Keep ChatGPT subscription OAuth credentials on the control plane and out of task sandboxes and restored snapshots.
- Deliver GitHub installation approval notifications to requesters who use Discord without Slack.
- Include complete Fast parent and advisor or judge inference usage in Costs analytics.
- Make empty Fast messages respond contextually and keep updates focused on useful outcomes instead of orchestration details.
- Preserve exact Slack or Discord source-message links in pull requests created by Fast-delegated tasks.
- Stop pull-request review prompts from reappearing after a user selects automatic Fix all handling.
- Move completed tasks to Done after their pull request merges and resume settled delegated work under the original task.
- Restore each user's preferred Tasks layout and give Slack-launched tasks meaningful generated titles.
- Keep oversized Fast integration results readable through conversation-scoped spill handles without exposing the service filesystem.

## 0.41.0 (2026-08-24)

This release adds a shared task board, expands Fast delegation and preferences, delivers actionable pull-request CI updates and proactive operator alerts, clarifies inference costs, and gives the Brain richer pull-request context.

### Highlights

- Coordinate team work from a shared board organized by task lifecycle, ownership, and context.
- Launch multiple independent tasks from one Fast session, choose their coding models, and consult focused reasoning subagents.
- Send actionable GitHub check failures back to linked tasks and their originating conversations.
- Warn operators about provider usage limits and deliver configuration issues to admins even without a configured channel.

### Minor changes

- Break down, filter, and inspect inference costs by usage source so operators can attribute spend to features such as task routing and title generation.
- Let Fast choose an enabled coding model for each delegated task and consult advisor or judge subagents for focused reasoning without launching another workspace-backed task.
- Let Fast launch multiple independent Roomote tasks from one Slack or Discord turn while keeping each kickoff visible and preventing repeated identical requests from creating duplicate work.
- Notify linked Roomote tasks and their originating conversations when checks fail on a GitHub pull request, consolidating related failures and ignoring results from outdated commits.
- Warn operators before supported inference-provider usage limits are exhausted, and deliver platform configuration issues to linked deployment admins by direct message when no alert or Manager Channel is configured.
- Add a shared task board that groups work into Active, Needs input, Blocked / failed, and Done columns, with ownership, participant, activity, workspace, and pull-request context for coordinating team work.

### Patch changes

- Give Brain pull-request pages the PR description and labels from GitHub, GitLab, Gitea, Bitbucket, and Azure DevOps so agents can recall why a change was made, not only its title.
- Enrich Brain pull-request pages with files changed, code areas, line totals, and review outcomes across supported source-control providers so agents can find the changes that affected a part of the codebase.
- Keep Fast sessions moving with clearer delegated replies, Slack task cards that resume after follow-ups, recovery from missing runtime dependencies and transient provider outages, and accurate guidance when a provider blocks a response.
- Show Fast response mode to every user in Personal Settings and apply each saved preference to eligible linked Slack and Discord messages without requiring deployment configuration.
- Trust only explicitly configured Roomote GitHub App slugs for managed pull-request activity, and keep Roomote attribution in pull-request descriptions to one canonical entry.
- Make onboarding easier to follow with clearer account, inference-provider, source-control, and environment guidance throughout the setup flow.
- Make pull-request feedback in Fast sessions reliable by delivering review activity consistently, keeping Slack review actions usable after delegated tasks settle, suppressing duplicate or stale results, and reducing notification pressure on provider quotas.
- Keep Brain task-memory history accurate by recording completed tasks reliably, distinguishing real ingestion gaps from completed backfills, and preventing the history-ingestion banner from returning after completion.
- Finish Slack task cards with the delegated agent's real result after Fast work settles, preserve actionable input requests, and keep terminal error cards stable while delivery retries.
- Give Fast and normal Roomote agents the semantic product release in their core prompt context while omitting channel tags and unavailable versions.

## 0.40.2 (2026-08-22)

This patch improves Fast coordination, Slack task visibility, pull request review reliability, task feedback, and Brain preview operations.

### Highlights

- Configure a separate model and reasoning level for Fast orchestration.
- Follow Fast-delegated Slack work through native streaming task cards and richer pull request updates.
- Keep pull request review notifications and closeout work moving safely through GitHub API limits.
- See renamed tasks immediately, get clearer billing pause guidance, and avoid empty Dependabot reports.

### Patch changes

- Explain when billing has paused new task launches and direct users to check billing across the web app and chat integrations.
- Improve the Brain preview with truthful source and corpus status, full-corpus browsing, correct page metadata, more reliable Slack and GitHub ingestion, resilient nightly synthesis and fact extraction, and durable mirror credentials across redeploys.
- Keep scheduled Dependabot triage quiet when a successful scan finds no open alerts or follow-up work.
- Make Fast workflows easier to follow with native streaming Slack task cards, relayed coding progress, task-specific pull request updates, automated review feedback, terminal pull request status, actionable follow-up suggestions, and stronger recovery from long turns and transient provider failures.
- Keep pull request review notifications and closeout work reliable under GitHub API limits by caching unchanged reads, deferring quota-limited work, and ignoring unrelated external bot activity.
- Let deployment admins choose a separate model and reasoning level for Fast orchestration while keeping the coding model as the default fallback.
- Refresh task lists and search results immediately after a task is renamed so the new title appears without reloading the page.

## 0.40.1 (2026-08-20)

This patch improves Slack and self-hosted administration, fixes task and Discord delivery issues, and smooths PostgreSQL upgrades.

### Highlights

- Update existing Slack app manifests from Communication Settings while preserving custom configuration.
- Keep Discord commands working when self-hosted deployments serve the Roomote API under a path prefix.
- Make self-hosted preview certificates simpler and prevent PostgreSQL collation mismatch warnings after upgrades.
- Show queued task follow-ups accurately and prevent duplicate pull-request review tasks during rapid pushes.

### Patch changes

- Add a guided Slack app manifest updater to Communication Settings so admins can apply current Roomote capabilities, permissions, events, and callback URLs with a fresh configuration token.
- Fix Discord commands silently failing on self-hosted installs that serve the Roomote API under a path prefix.
- Default new self-hosted installations to flat preview hostnames so standard wildcard certificates cover task previews without an extra preview subdomain.
- Keep self-hosted PostgreSQL on the Trixie collation provider when enabling pgvector so existing databases do not report collation version mismatches after upgrading Roomote.
- Keep task follow-up and pull-request review delivery state accurate by showing queued messages honestly and preventing duplicate review tasks during rapid pushes.
- Include the running Roomote application version in About output so operators can identify the deployed release during support and troubleshooting.
- Brain and Fast mode remain internal previews, with reliability, observability, identity, and task-inspection improvements. Let us know in Discord if you’re interested in testing them or contributing.

## 0.40.0 (2026-08-18)

This release adds safer Notion workflows, environment diffs, automation history, model support, and reliability improvements across tasks and Slack.

### Highlights

- Connect a deployment-wide Notion integration with permission-scoped access and precise content editing.
- Compare draft environment edits and saved versions side by side.
- Review previous automation runs and steer active tasks through the Roomote MCP.
- Improve reliability across long-running tasks, Slack task delivery, and automation reports.

### Minor changes

- Open previous automation runs from the Automations settings page to review their status, timing, and linked task history.
- Add a deployment-wide Notion internal integration for tasks and automations, with permission-scoped access to shared content and precise controls for inserting and updating page content.
- Compare draft environment edits and saved versions side by side in the environment editor. Thanks to @a8trejo for contributing this improvement and reporting [#1160](https://github.com/RooCodeInc/Roomote/issues/1160).
- Add GLM 5.3 support and updated model recommendations across OpenCode Go, Z.AI Coding Plan, OpenRouter, and Vercel AI Gateway.
- Send immediate steering instructions to active tasks through the Roomote MCP so agents can adjust work without waiting for another task turn.

### Patch changes

- Make automation reports quieter and easier to act on with structured Slack cards, run metadata, compact durations, replyable platform alerts, and reliable delivery for failure and Dependabot results.
- Remove repeated task rows from cost drilldowns, preserve pull-request opener attribution, and clarify when pull-request review threads will be auto-resolved.
- Make Slack task delivery more reliable by waking sleeping tasks from thread replies, preserving follow-up delivery during API rollback, removing internal block context from task messages, and preventing duplicate kickoff messages.
- Keep task transcripts and controls readable by separating thinking headings, preserving table-format menus, and preventing terminal views from flooding browser error telemetry.
- Keep long-running tasks moving by compacting custom-model context before provider limits, restoring prompts in order after snapshot resumes, and reporting queued messages only when their turn starts.
- Initial explorations of an orchestration interface and persistent Brain. Let us know in Discord if you’re interested in testing them or contributing.

## 0.39.1 (2026-08-14)

This patch adds guided automation recommendations during setup and strengthens Goal Mode, chat continuity, snapshots, provider compatibility, and task controls.

### Highlights

- Review and apply repository-aware automation recommendations during setup.
- Use `/goal` from Discord while keeping objective context intact across follow-ups.
- Keep chat threads usable when tasks finish silently or are deleted.
- Improve snapshot recovery, provider compatibility, artifact progress, and model controls.

### Patch changes

- Recommend useful automations during setup based on connected repository activity, with controls to review and apply the recommendations before continuing.
- Keep chat conversations usable by delivering a fallback response when a task finishes without a final message and releasing Slack, Discord, Teams, and Telegram threads after their task is deleted.
- Add Discord's `/goal` command for keeping Roomote focused on an objective across multiple turns, while preserving Goal Mode context through follow-ups and keeping internal lifecycle instructions out of agent prompts.
- Format Discord pull-request review resolutions as subdued status text so action results are easier to distinguish from the main review message.
- Remove an unused environment endpoint that could expose raw environment configuration while leaving task launches, environment updates, and verification unchanged (thanks @canblmz1 for reporting).
- Improve provider and agent compatibility by restoring MCP access for judge and advisor agents, recommending GPT 5.6 Luna for GitHub Copilot, reducing expected Modal lookup noise, cleaning up legacy-provider OIDC refreshes, and supporting nullable-array MCP schemas with Gemini.
- Make environment snapshots more reliable by pacing background refreshes, preserving actionable launch diagnostics, recording failed snapshots accurately, and finalizing runs whose sandboxes disappear before a snapshot completes.
- Improve task visibility and control with artifact-build progress and direct task links, a clearer responsive model selector, and more concise, structured custom automation reports by default.
- Let Discord `/goal` tasks complete or block normally by preserving the final Goal Mode context through activation.
- Use a concise, first-person message when a chat task finishes without another response.

## 0.39.0 (2026-08-13)

This release expands model choice and per-task switching while improving provider setup, task reliability, pull request review delivery, snapshots, Slack conversations, and self-hosted installation.

### Highlights

- Discover enabled models and switch models or reasoning levels for individual tasks from the composer or by asking the agent.
- Choose from current Gemini, DeepSeek, Grok, and GitHub Copilot models with model-appropriate defaults and reasoning controls.
- Catch invalid inference credentials, quota, model access, and runtime wiring during setup instead of on the first task.
- Keep pull request review feedback and action offers reliable through association, queue, task, and Slack workspace timing races.

### Minor changes

- Add model discovery to the task management tool so agents can list enabled model IDs beside the existing task model switch action.
- Add Gemini 3.7 Flash, recommend DeepSeek V4 Pro 0813, and let Grok subscription and GitHub Copilot users choose from current supported chat models with model-appropriate reasoning controls.
- Add a per-task model switcher: a model chip in the web task composer switches the coding model and reasoning level (with per-role overrides for planning, code review, explore, helper, and vision behind "All roles"), changes apply from the next message and persist across snapshot resumes, and agents can switch their own task's models on request via the new `manage_tasks` `update_models` action.
- Automatically pick up Grok chat models that xAI releases after connecting the Grok subscription or an xAI API key, without waiting for a Roomote catalog update. Models you disable or remove stay that way. Thanks to @pridemusvaire for contributing this improvement.

### Patch changes

- Validate MCP OAuth callbacks by callback class instead of client-specific URLs, supporting secure hosted, loopback, and native app callbacks.
- Keep pull request review feedback and action offers reliable through association, queue, and worker timing races; scope actions to their owning task and Slack workspace; and coalesce each automated review pass into one notification.
- Make environment setup validate commands locally, avoid unnecessarily broad dependency installs, wait efficiently for verification, and distinguish pre-existing repository failures from environment problems.
- Validate inference-provider credentials, model access, quota, and runtime wiring before saving setup configuration so invalid connections fail with actionable guidance instead of breaking the first task.
- Remove the unnecessary gap below the task composer on mobile while preserving the existing desktop task layout.
- Keep automatic workspace routing and focused helper agents working with Amazon Bedrock models, configured reasoning, and connected integrations that expose incompatible tool schemas.
- Restore environment snapshot creation and show snapshot actions only for sandbox providers configured on the deployment.
- Restore the xAI Grok subscription usage bar in Models settings by sending the identity headers now required by the billing service. Thanks to @pridemusvaire for contributing this fix.
- Restore the one-command installer endpoint by removing its dependency on a stale GitHub credential and add health checks for its public routes. Thanks to @Tepexic for reporting [#1274](https://github.com/RooCodeInc/Roomote/issues/1274).
- Keep Goal Mode controls, GitHub Copilot model routing, and sandbox sleep checks working when platform API routing, model reasoning support, or one sandbox provider is unavailable.
- Keep Slack task conversations reliable by including replies posted during task routing, retrying transient message-update failures, and allowing app-accessible public channels without requiring the acting user to join them.

## 0.38.0 (2026-08-12)

This release adds `/goal` mode for long-running work, a Roomote MCP, custom routing rules, and the ability to generate demo videos.

### Highlights

- Keep long-running work moving toward a defined objective with bounded Goal Mode continuations.
- Connect OAuth-capable coding clients to Roomote through one stable remote MCP URL.
- Route work to the right environment with custom workspace rules.
- Generate polished demo videos from live browser journeys with captions and optional narration.

### Minor changes

- Let tasks discover available public communication channels and send explicitly requested Slack direct messages to linked Roomote users while preserving workspace and recipient authorization.
- Answer non-repository questions and perform explicitly requested connected-system actions through the new exploration and action workflow, without forcing unrelated source-code work.
- Diagnose environment startup and application-health problems with the Doctor workflow, which verifies a fresh task journey, identifies ownership, and rechecks authorized repairs.
- Produce polished feature-demo videos from live browser journeys with guided pointer effects, captions, optional narration, and reusable rendering controls.
- Keep long-running web tasks moving toward a defined objective with bounded Goal Mode continuations, generation-safe completion controls, and `/goal` support in the task composer.
- Show OpenCode Go rolling, weekly, and monthly usage in model settings so operators can monitor subscription capacity without leaving Roomote.
- Connect OAuth-capable clients such as Claude Code, Codex, Cursor, and VS Code to Roomote member tools through one stable remote MCP URL, with browser consent, compatible client registration, and securely rotated credentials.
- Configure custom workspace routing rules that send new work to the right environment based on natural-language criteria, with a simplified settings layout for reviewing the active rules. Thanks to @MaximeLaurenty for reporting [#1221](https://github.com/RooCodeInc/Roomote/issues/1221).
- Connect X (Twitter) as a built-in integration from Settings, with guided configuration and Roomote-managed access to the integration's tools.

### Patch changes

- Keep custom automation prompts focused on the work to perform instead of repeating cadence that is already stored in the automation schedule.
- Run Roomote task environments on Box as a built-in compute provider, with setup support, secure worker configuration, and the same provider capability model used by existing sandboxes.
- Keep OAuth-based custom MCP integrations in the configured state until authentication completes instead of showing them as connected prematurely.
- Revoke the entire remote MCP OAuth refresh-token family when an already-rotated refresh token is replayed, per the OAuth 2.0 Security BCP. Previously the replay was rejected but the rest of the token family stayed valid, so a stolen-token signal never disabled the remaining tokens.
- Recommend Grok 4.6 for newly configured xAI task roles, avoid unnecessary environment credential prompts, and clarify when Modal command output cannot be resumed by ID.
- Deliver pull-request feedback reliably without duplicate review notifications, including for repositories excluded from automatic GitHub task creation.
- Report provider errors that end a task turn back into the originating Slack, Discord, Telegram, or Teams thread instead of leaving the conversation silent.
- Keep task input flows usable by restoring slash-command autocomplete, preventing file search from opening on `@`, removing answered Slack elicitation buttons, and ensuring resolved input requests do not reappear.
- Keep task runtimes reliable by recovering through OpenCode context compaction, preserving the parent's compute provider for delegated child tasks, and using the configured vision model to describe supported videos.

## 0.37.0 (2026-08-10)

This release brings voice-driven work to every chat provider, expands organization-wide automations and source-control identity support, and improves task reliability.

### Highlights

- Start tasks and send follow-ups with audio or voice messages across Slack, Discord, Telegram, and Microsoft Teams.
- Run custom automations across every active repository while routing suggested follow-up tasks to the correct environment.
- Show verified linked identities and privacy-safe attribution across GitLab, Gitea, Bitbucket, and Azure DevOps.
- Keep long-running tasks, pull-request reviews, authenticated previews, and chat auto-start flows working more reliably.

### Minor changes

- Run custom automations across all active repositories while routing each suggested follow-up task to the correct repository environment.
- Start tasks and send follow-ups with audio or voice messages across Slack, Discord, Telegram, and Microsoft Teams, with actionable guidance when transcription is unavailable.
- Configure deployment incident banners and Slack warnings with a Statuspage-compatible unresolved-incidents feed URL, or leave the feed disabled when no URL is set.
- Show verified linked identities for GitLab, Gitea, Bitbucket, and Azure DevOps, and use privacy-safe provider attribution for public source-control changes.

### Patch changes

- Let agents open authenticated shareable previews without being redirected to sign-in, including previews that ultimately redirect to direct machine URLs.
- Add a direct link from model settings to Roomote's model recommendations so users can compare supported choices before configuring task roles.
- Preserve provider-neutral source context for child tasks so agents can identify the originating conversation without inheriting live reply behavior.
- Keep pull-request attribution current and privacy-safe across public and private repositories while preserving provider-specific follow-up links. Thanks to @T4cC0re for reporting [#1184](https://github.com/RooCodeInc/Roomote/issues/1184).
- Refresh supported source-control OAuth credentials before they expire during long-running, resumed, and mixed-provider tasks while keeping temporary provider failures retryable.
- Keep pull-request review follow-ups running until their queued work settles, release review actions after stale workers stop, and avoid duplicate completion or action notifications.
- Reply to human-authored Slack and Discord auto-start messages when task classification or startup fails unexpectedly instead of appearing unresponsive.
- Restore Better Stack monitoring, incident, and telemetry inspection tools in tasks while preserving Roomote's read-only integration boundary.
- Reuse compute-provider clients across scheduler checks to prevent memory growth and worker restarts on deployments with continuously active tasks.
- Show every active pull request linked to a task across the web app and supported chat providers instead of displaying only one associated pull request.
- Let agents discover enabled automation models and reject unavailable model overrides when an automation is configured instead of failing later at launch.

## 0.36.1 (2026-08-07)

This release improves compatibility across MCP and Anthropic integrations, tightens automation suggestions, and refreshes Gemini recommendations.

### Highlights

- Configure per-tool controls for streamable HTTP MCP servers that require session initialization.
- Run Anthropic-backed model and tool calls without unsupported schema constraints causing failures.
- Keep launchable task suggestions limited to automations that explicitly request them.
- Use Gemini 3.6 Flash consistently for newly recommended Google Gemini task roles.

### Patch changes

- Discover tools from streamable HTTP MCP servers that require session initialization and negotiated protocol headers, restoring per-tool controls for strict servers.
- Keep launchable task suggestions limited to automation runs that explicitly request them, so normal user conversations no longer show unrelated follow-up task prompts.
- Recommend Gemini 3.6 Flash consistently across Google Gemini task roles and remove Gemini 3.1 Pro Preview from newly recommended model lists.
- Prevent Anthropic-backed model and tool calls from failing on unsupported JSON Schema constraints while preserving the same local output validation.

## 0.36.0 (2026-08-07)

This release adds deployment-wide custom MCP servers, makes suggested tasks easier to launch from chat, and gives automations private delivery options across communication providers alongside reliability improvements.

### Highlights

- Configure custom remote and local MCP servers once for every task, with secure authentication and per-tool controls.
- Launch suggested follow-up tasks directly from Slack, Discord, Telegram, and Teams with clearer, consistent interactions.
- Send custom automation reports privately to the owner's linked Slack, Discord, Teams, or Telegram account.
- Keep active pull-request reviews current when new commits arrive, while preserving chat context and task status notifications more reliably.

### Minor changes

- Let users send custom automation reports privately to their linked Slack, Discord, Teams, or Telegram account with the new DM me destination.
- Make suggested follow-up tasks a first-class part of chat replies across Slack, Discord, Telegram, and Teams, with clear launch instructions, reaction-based starts, and workspace routing when users approve them.
- Let deployment administrators configure custom remote and local MCP servers for every task, with OAuth and header authentication, per-tool controls, encrypted secrets, and protected network access. Thanks to @T4cC0re for reporting [#1142](https://github.com/RooCodeInc/Roomote/issues/1142).

### Patch changes

- Keep active automated pull-request reviews running when new commits arrive so the latest pushed head is reviewed before the task finishes.
- Preserve the original message, attachments, and mention context when Roomote starts from emoji-triggered Slack requests or forwarded Discord messages.
- Keep self-hosted Node services within container memory limits by applying safe default heap caps while preserving operator overrides.
- Stop recommending Mimo V2.5 in newly connected model-provider lists while preserving existing explicit configurations.
- Restore merge and close notifications for tracked pull requests in repositories excluded from automated GitHub processing.

## 0.35.0 (2026-08-06)

This release expands source-control setup and review workflows, adds a direct homepage feedback path, and improves reliability across automations, Slack routing, and self-hosted sandboxes.

### Highlights

- Review pull requests with line-anchored comments across GitHub, GitLab, Gitea, Bitbucket, and Azure DevOps.
- Configure and safely disconnect every supported source-control provider from Settings.
- Share feedback directly from the homepage without interrupting normal task workflows.
- Scan and run custom automations more easily with clearer schedules, destinations, and independent controls.

### Minor changes

- Add a dismissible homepage feedback prompt that lets users book time with the founders or send feedback by email without interrupting their normal workflow.
- Post line-anchored inline pull-request review comments across GitHub, GitLab, Gitea, Bitbucket, and Azure DevOps, with provider-aware suggestions and safe fallback when an anchor is rejected.
- Let administrators configure non-GitHub source-control providers with complete callback guidance and safely remove persisted GitHub, GitLab, Gitea, Bitbucket, or Azure DevOps connections from Settings.

### Patch changes

- Make custom automations easier to scan with human-readable schedules and clearer destinations, and keep creation and other run controls available while an automation is being queued.
- Keep sandbox HTTP and WebSocket traffic reachable on LAN-hosted deployments and fall back to the task API when a live sandbox connection cannot stop an active task.
- Keep OpenCode task sessions consistently identified as Roomote while preserving the current workflow and implementation guidance.
- Explain when automatic Slack routing is temporarily unavailable instead of silently showing the workspace picker, while keeping sensitive provider errors out of user-facing messages.
- Stop task closeouts from promising a follow-up self-review when every selected GitHub repository is excluded from automated processing.
- Let administrators disconnect GitLab, Gitea, and Bitbucket OAuth connections when provider client credentials come from runtime configuration.
- Preserve deleted-line review thread anchors on Bitbucket and Azure DevOps so later reviews can match and reply to existing inline comments.
- Let sync reviews resolve Roomote-authored inline threads after verifying the flagged code was fixed, including when GitHub marks the original anchor outdated.

## 0.34.0 (2026-08-04)

This release adds Granola and Requesty connections, introduces Mind reader mode for expanded model thoughts, and improves task reliability across mixed-provider workspaces and chat delivery failures.

### Highlights

- Connect Granola once for deployment-wide access to approved meeting notes, folders, and transcripts.
- Connect Requesty from setup or model settings with a curated catalog of current supported models.
- Expand model thought blocks by default with the optional Mind reader mode.
- Launch tasks reliably from workspaces that combine repositories across supported source-control providers.

### Minor changes

- Let deployment administrators connect Granola once so Roomote can securely browse the notes, folders, and transcripts allowed by the configured API key.
- Add an optional Mind reader mode that expands LLM thought blocks by default while preserving manual conversation-level choices.
- Let users connect Requesty from setup or model settings and start with a curated catalog of current supported models.

### Patch changes

- Use Roomote's stable branded Discord invite from the repository and in-app release notes.
- Keep tasks running when agents attempt to read unsupported ICO or CUR files by returning a recoverable tool error before provider submission.
- Launch tasks reliably from workspaces that combine repositories across GitHub, GitLab, Gitea, Azure DevOps, and Bitbucket with provider-scoped credentials. Thanks to @jantekb for reporting [#1082](https://github.com/RooCodeInc/Roomote/issues/1082).
- Require an active deployment administrator to create or update shared environments through Roomote's MCP tools.
- Stop completed chat tasks from entering repeated closeout attempts when message delivery has failed permanently.

## 0.33.0 (2026-08-04)

This release adds new ways to connect and invoke Roomote, gives deployments clearer account-linking guidance, and improves automation and Amazon Bedrock model discovery.

### Highlights

- Start Roomote from existing Slack, Discord, and Microsoft Teams conversations with an administrator-configured emoji reaction.
- Connect Resend with safe inspection-oriented defaults and explicit controls for sensitive actions.
- Add deployment-specific account-linking guidance across chat, source control, and sign-in surfaces.
- Keep Amazon Bedrock models visible and organized under one provider section in model settings.

### Minor changes

- Let administrators configure an emoji that starts Roomote from an existing Slack, Discord, or Microsoft Teams conversation, reusing the normal task flow and preserving the reacting user's account attribution.
- Add Resend as a deployment-wide integration with inspection-oriented access by default and explicit administrator controls for sensitive email, credential, automation, contact, domain, and webhook actions.
- Let administrators add deployment-specific account-linking guidance that appears alongside Roomote's built-in instructions in source-control comments, Discord, Telegram, and the sign-in page.

### Patch changes

- Keep Amazon Bedrock Mantle models visible after settings reload and group native Bedrock and Mantle entries under one Amazon Bedrock section instead of showing duplicate headings.
- Make routine Discord release announcements shorter and suppress link-preview cards while keeping the release notes link available.
- Make automations the highest-priority onboarding prompt for users who have not enabled one, and link the Automations page directly to practical Cookbook recipes.

## 0.32.1 (2026-08-04)

This patch restores licensed Cloud seat limits and keeps custom automation destinations limited to connected communication providers.

### Highlights

- Restore licensed seat limits for Roomote Cloud deployments so valid provisioned licenses no longer fall back to the free-tier limit when no activation lease is present.
- Choose custom automation destinations from connected communication providers only.

### Patch changes

- Restore licensed seat limits for Roomote Cloud deployments so valid provisioned licenses no longer fall back to the free-tier limit when no activation lease is present.
- Show only connected communication providers when choosing a custom automation destination, while preserving task-view-only delivery and existing form edits as integration availability loads.

## 0.32.0 (2026-08-03)

This release adds OpenCode Go subscriptions, restores convenient automation test runs, refreshes recommended models, and makes license syncing more resilient.

### Highlights

- Let operators connect an OpenCode Go subscription independently from OpenCode Zen and use supported Go models across Roomote task roles.
- Run enabled custom automations on demand and test newly created automations immediately.
- Use current Qwen and DeepSeek recommendations across supported model providers.
- Retry license usage reporting after transient Roomote Cloud failures.

### Minor changes

- Let operators connect an OpenCode Go subscription independently from OpenCode Zen and use supported Go models across Roomote task roles.

### Patch changes

- Let administrators run enabled custom automations on demand from Automations settings, and offer an immediate test run after an automation is created conversationally.
- Recommend Qwen3.8 Max through supported providers and use OpenCode Zen's supported DeepSeek V4 Flash model identifier.
- Retry license usage reports after transient Roomote Cloud failures and report concurrent license-key changes accurately instead of dropping usage observations or reporting a false success.

## 0.31.0 (2026-08-03)

This release expands Amazon Bedrock and deployment controls, refreshes Automations and self-hosted licensing, and adds copyable Cookbook recipes for common workflows.

### Highlights

- Use native Amazon Bedrock Runtime models alongside Mantle, including regional inference profiles and supported reasoning settings.
- Find and manage custom and built-in automations through a redesigned, filterable Automations experience.
- Disable curated integrations through a deployment policy without deleting saved credentials or affecting other provider types.
- Copy ready-to-use Cookbook recipes for outage triage, support investigations, CI fixes, product updates, and scheduled maintenance.

### Minor changes

- Redesign Automations settings around scannable Custom, Enabled, and Available sections, with permalinked configuration dialogs, responsive custom automation controls, and category and provider-aware filtering.
- Let deployment operators disable the curated integrations catalog and its existing connections through an environment policy without deleting saved credentials or affecting other provider types.
- Let operators use native Amazon Bedrock Runtime models alongside Mantle, including regional inference profiles and supported reasoning settings, without changing existing Mantle configurations.
- Add direct Roomote Cloud purchase and renewal paths to self-hosted License settings, including low-seat and upcoming-expiry guidance for administrators.
- Show useful, dismissible product tips alongside task startup progress so users can discover Roomote capabilities while an environment boots.
- Add a copyable Roomote Cookbook with ready-to-use recipes for vendor outage triage, support investigations, CI failure fixes, product update newsletters, and scheduled maintenance.

### Patch changes

- Keep Azure Container Apps sandboxes suspended until Roomote deliberately wakes them, recover cleanly from leftover workers, and stop retrying runs whose sandboxes were deleted. Thanks to @tebieshi for contributing this improvement.
- Stop ChatGPT subscription connections from waiting forever on expired or blocked device codes, explain why authorization stopped, and offer a clean restart.
- Recommend Claude Sonnet 5 at medium reasoning for code review when operators apply supported provider presets, while retaining Opus for planning.
- Keep Discord task requests through account linking, focus onboarding on the required personal account connection, and preserve automation reply threads when tasks resume.
- Keep the Users settings invite list focused on links that still have uses remaining while retaining consumed invite records.
- Add a direct Personal settings shortcut to the signed-in user menu.
- Make ChatGPT, xAI, and GitHub Copilot device connections handle expiry, rate limits, restarts, and stale polling consistently, with clearer terminal errors across all three providers.
- Give sandbox providers more time to finish rate-limited starts before aborting, and offer a retry when a task start fails before producing output.
- Show terminal command output again in the web task view, with collapsible details and a copy button for easier inspection.
- Restore the previous deployment metadata and controller after a failed self-hosted image pull so operators can retry upgrades without breaking the next backup.
- Make UI proof reject obvious visual defects elsewhere in captured frames instead of accepting evidence that only satisfies the focal claim.

## 0.30.2 (2026-08-03)

This patch improves GitHub App recovery and Discord automation follow-ups, refreshes the DeepSeek recommendation, and retires the current experimental toggles.

### Highlights

- Recover from stale GitHub App credentials and reconnect repositories without sync conflicts.
- Keep Discord automation updates and replies together in dedicated threads.
- Recommend DeepSeek V4 Flash 0731 across supported providers.
- Retire the current experimental toggles while preserving their default behavior.

### Patch changes

- Recommend and resolve the dated DeepSeek V4 Flash 0731 model across supported providers.
- Create a dedicated Discord thread from each automation's first report so later updates and replies stay together.
- Let administrators remove stale GitHub App credentials and reconnect or refresh repositories without sync conflicts after replacing an installation.
- Retire the current experimental feature toggles while preserving their default behavior and keeping the settings area ready for future experiments.

## 0.30.1 (2026-08-02)

This patch improves custom automation scheduling and keeps Docker sandbox cleanup reliable in restricted deployments.

### Highlights

- Keep Docker sandbox cleanup working through restricted socket proxies so expired orphan task networks are removed without broadening proxy permissions.
- Schedule custom automations reliably with discoverable built-in hourly, daily, and weekly presets.

### Patch changes

- Keep Docker sandbox cleanup working through restricted socket proxies so expired orphan task networks are removed without broadening proxy permissions.
- Help agents schedule custom automations reliably by exposing every built-in hourly, daily, and weekly schedule preset through Roomote's management tools.

## 0.30.0 (2026-08-02)

This release makes custom automations more flexible and reliable while improving task recovery and cross-channel follow-ups.

### Highlights

- Schedule custom automations with presets, cron, or natural language, choose a model for each automation, and manage them through Roomote.
- Route manager summaries, suggestions, alerts, and other automation output to Discord as well as Slack.
- Recover from model-provider errors in the same task without losing the active workspace.
- Preserve conversational context when continuing Slack- or Discord-linked tasks from the web.

### Minor changes

- Let administrators choose a model for each custom automation while existing automations continue using the deployment default.
- Let administrators use a Discord channel as the shared destination for manager summaries, suggestions, alerts, and other automation output.
- Let administrators schedule custom automations with presets, cron, or natural language in a deployment-wide timezone, and manage their full lifecycle through Roomote's MCP tools.

### Patch changes

- Make app image builds more reliable by using BuildKit's built-in Dockerfile frontend instead of launching an unnecessary external frontend image.
- Return actionable validation messages when Roomote manages custom automations, and record unexpected API failures in server logs for troubleshooting.
- Launch due custom automations even when an earlier run remains active while retaining duplicate-launch protection.
- Preserve conversational context when users continue Slack- or Discord-linked tasks from the web, including concurrent follow-ups and image-only replies.
- Keep active task sandboxes available after model-provider errors so users can recover with a follow-up without losing workspace state.
- Let users browse and configure Automations without a misleading Slack prerequisite while retaining provider-specific setup and permission guidance.
- Use kickoff copy that matches the environment selected from Slack's manual routing picker instead of referring to a rejected suggestion.

## 0.29.0 (2026-08-01)

This release expands model reasoning and preset options while improving LiteLLM routing, invite previews, and environment guidance.

### Highlights

- Choose Max reasoning for supported OpenAI and Anthropic models, and use refreshed OpenAI and ChatGPT presets with specialized defaults and a Luna Max option.
- Route GitHub mentions and other helper calls reliably through configured LiteLLM providers.
- Share invite links with clear, privacy-safe previews and keep admin-only environment guidance hidden from members.

### Minor changes

- Refresh the recommended OpenAI and ChatGPT subscription model presets with Sol defaults for coding and vision, specialized supporting models, and a Luna Max option for higher-effort coding.
- Let administrators select and persist Max reasoning for supported OpenAI and Anthropic models while preserving compatibility with existing reasoning levels.

### Patch changes

- Give shared invite links a clear Roomote Invitation preview without exposing invite tokens, roles, or deployment details.
- Keep GitHub mention routing and other non-task helper calls working with LiteLLM-backed models by registering their configured endpoint, adapter, credentials, and model catalog. Thanks to @tomny-dev for reporting [#963](https://github.com/RooCodeInc/Roomote/issues/963).
- Hide the homepage environment-creation warning and admin-only action from members who cannot manage environments.

## 0.28.0 (2026-08-01)

This release speeds up setup and pull request reviews while improving chat task continuity, task attribution, model recommendations, and deployment reliability.

### Highlights

- Set up repositories faster with blobless clones and support git hooks that require yarn without changing the managed pnpm or npm versions.
- Apply team guidance throughout Review Code automations and start commit-triggered re-reviews sooner.
- Continue chat tasks naturally with reliable, provider-aware reminders, receive failure details in the originating conversation, and see consistent `Linear Agent` attribution.
- Complete delegated Azure DevOps setup on the first Microsoft sign-in and keep Coolify and Docker task networking reliable. Thanks to @tomny-dev for contributing the Coolify fix.

### Minor changes

- Let teams add custom instructions to Review Code automations so initial and follow-up reviews follow their preferred guidance.

### Patch changes

- Keep Coolify task creation and live previews working by connecting trusted services to the worker discovery network. Thanks to @tomny-dev for contributing this fix.
- Recommend Qwen3.7 Max and Qwen3.7 Plus when connected model providers support them.
- Speed up fresh environment setup for large repositories with blobless partial clones while preserving full commit and tree history.
- Let users continue sleeping Roomote tasks naturally in their Discord task threads without mentioning the bot again.
- Start commit-triggered pull request re-reviews sooner while retaining burst protection and per-PR deduplication.
- Apply configured Review Code instructions to GitHub follow-up reviews so team guidance remains consistent throughout the review lifecycle.
- Show a pointer cursor on the environment repository selector's create-repository action so its interactivity is clear.
- Complete Azure DevOps delegated setup on the first Microsoft sign-in instead of returning users to the credentials form without saving the linked account or syncing repositories.
- Name the active Discord, Slack, Teams, or Telegram surface correctly in task closeout and silence reminders.
- Keep closeout reminders from interrupting in-flight agent work or appearing twice for the same turn.
- Settle terminal provider and runtime errors as failed tasks so users receive the existing failure details in the Discord, Slack, Teams, or Telegram conversation where the task started.
- Put yarn on the sandbox PATH during worker setup, so repositories whose git hooks shell out to yarn no longer fail with `yarn: not found` (which agents were reporting as a missing Git credential). Corepack is enabled for yarn only, leaving the mise-managed pnpm and npm untouched. Thanks to @pridemusvaire for contributing this fix.
- Classify provider failures from structured HTTP status and retryability signals instead of provider-specific message wording, with bounded retries before status-less errors fail cleanly.
- Remove residual Docker task networks after completed, canceled, or failed tasks, and show actionable recovery guidance when Docker address pools are exhausted.
- Show identity-less Linear task creators consistently as `Linear Agent` across task history, creator filters, analytics, and manager statistics instead of exposing raw session IDs.

## 0.27.0 (2026-07-31)

This release expands Azure, ChatGPT, GitHub, and monday.com capabilities while improving task reliability, privacy, setup, and Coolify deployments.

### Highlights

- Run tasks with Azure Container Apps Sandboxes, or connect Azure OpenAI and Azure AI Foundry for model inference.
- Use monday.com context in tasks and invoke Roomote on GitHub with the shorter `@Roomote` mention.
- Enable Fast mode for ChatGPT subscriptions and manage optional Roomote Cloud analytics with new cookie consent controls.
- Keep Coolify Docker jobs, environment setup, Slack follow-ups, visual proof, task privacy, and pull request re-reviews working more reliably.

### Minor changes

- Add Azure Container Apps Sandboxes as a preview compute provider with fast suspend and resume, snapshots, stable preview URLs, configurable sizing, and guided worker image setup. Thanks to @tebieshi for contributing this improvement.
- Add first-class Azure OpenAI and Azure AI Foundry inference provider setup and model routing.
- Add Fast mode for ChatGPT subscriptions and improve subscription provider connection, model availability, and settings controls.
- Add cookie consent controls to Roomote Cloud and defer optional support and product analytics services until users grant consent.
- Let GitHub users invoke Roomote with the shorter `@Roomote` mention, with an administrator setting to require the full bot name instead.
- Add a read-only monday.com integration so Roomote tasks can use the current user's board and work-item context.

### Patch changes

- Validate Azure DevOps credentials before saving them, explain rejected credentials clearly, and restore Roomote's own-comment detection and approve or request-changes reviewer votes.
- Restore BullMQ access to the restricted Docker proxy in Coolify deployments so Docker environment validation and lifecycle jobs work correctly. Thanks to @tomny-dev for contributing this fix.
- Make Discord release announcements more concise and conversational.
- Make environment setup follow repository guidance and automatically resume tasks when background setup finishes.
- Improve weekly manager reports with readable number formatting and rankings limited to human users.
- Coalesce redundant pull request re-reviews and ensure active reviews include newly pushed commits.
- Prevent recent or pinned task identifiers from exposing tasks owned by another user in the sidebar.
- Keep Slack follow-ups from interrupting healthy active work while preserving stalled-task recovery.
- Polish task and dashboard status displays by hiding unreleased PR analytics, strengthening selected-task and provider-error indicators, and collapsing background activity when todo updates begin.
- Reliably expose captured visual-proof artifacts for explicit sharing in connected chat threads.

## 0.26.0 (2026-07-29)

This release expands Linear and GitHub workflows, makes release information easier to find, and improves setup and task reliability.

### Highlights

- Set up and manage Linear, link user accounts, and start app-mention, issue-delegation, scheduled, and direct Linear tasks.
- Create or fork a GitHub repository from Roomote, then bootstrap an empty repository and configure its environment automatically.
- Manage GitHub labels, milestones, and project status values safely from Roomote tasks.
- Find the running Roomote version easily, verify Teams credentials during setup, and start sandboxes more reliably through transient broker failures.

### Minor changes

- Announce newly published Roomote releases in Discord with the release title, notes, link, timestamp, and Roomote branding when a main-channel webhook is configured.
- Set up and manage Linear from onboarding or Settings, link user accounts, and start app-mention, issue-delegation, scheduled, and direct Linear tasks with the correct workspace and account context.
- Create a new GitHub repository or fork an existing one from Roomote, then automatically detect empty repositories, add their initial commit, and configure a working environment.
- Manage GitHub labels, milestones, and project status values from Roomote tasks with scoped credentials, confirmation for destructive changes, and read-back verification.
- See the running Roomote version from the signed-in user menu, open release details, and revisit the latest What's New notice without administrator access.

### Patch changes

- Hide self-hosted license controls from cloud deployments while keeping license management available to self-hosted administrators.
- Make task conversations easier to follow by showing request-input questions as distinct quoted context, refining mobile task chrome, quoting web follow-ups in GitHub replies, and keeping internal routing context out of Slack and Discord quotes.
- Retry transient compute-broker upload failures during sandbox startup so momentary upstream errors no longer prevent task environments from starting.
- Choose the model used by the Onboarding Agent when editing an existing environment, matching the model selection already available when creating one.
- Verify Microsoft Teams bot credentials with Microsoft before saving them, so a wrong app id, client secret, or tenant id fails the save with a message naming the field instead of reporting a configured bot that cannot authenticate. Teams settings now also reports when the saved credentials stop authenticating, and explains why the Teams app package cannot be pre-filled from a malformed App (Client) ID.

## 0.25.0 (2026-07-28)

This release expands account and diagnostics configuration while making task execution and Slack automation more reliable.

### Highlights

- Add a password to OAuth-first accounts from Personal Settings for flexible email/password sign-in.
- Route diagnostics to the configured Slack, Discord, Microsoft Teams, or Telegram destination.
- Keep Bedrock Mantle model launches, task snapshots, and Slack automation running reliably.

### Minor changes

- OAuth-first users can now set a password from Personal Settings and later sign in with their profile email and password.
- Configure router diagnostics in Deployment settings to send them through Slack, Discord, Microsoft Teams, or Telegram.

### Patch changes

- Let automation tasks send their final Slack outcome, blocker, or handoff without rejecting valid closeout replies.
- Keep Amazon Bedrock Mantle model recommendations current and ensure compatible OpenAI models launch through their supported Responses API.
- Preserve successful task snapshots before sandbox teardown so interrupted workers can resume tasks reliably across supported compute providers.
- Keep Slack-surface tasks working after progress updates instead of treating a status message as the end of the task.

## 0.24.0 (2026-07-27)

This release makes Roomote easier to reach across communication channels while refining setup, task loading, and connection reliability.

### Highlights

- Post to Slack, Teams, Telegram, or Discord through one consistent agent tool, with direct links back to rendered task widgets.
- Select the model for Settings-based environment setup and opt in to product updates during eligible onboarding flows.
- See the task workspace sooner while its history loads, and resume interrupted MCP OAuth connections safely after signing in.
- Find the Roomote Discord community directly from the release-update dialog.

### Minor changes

- Choose the model used for environment setup from Settings, and opt in to product updates when completing eligible setup and onboarding flows.
- Use one provider-neutral channel-posting tool across Slack, Teams, Telegram, and Discord, with each provider continuing to enforce its delivery and authorization constraints. External task replies also include a direct link to their rendered widgets.

### Patch changes

- Let interrupted MCP OAuth connections resume safely after sign-in, route GitHub issue links to their matching environment, and keep source-control attribution and review follow-up behavior accurate.
- Improve deployment and task reliability with faster encrypted configuration access, request timing diagnostics, safer custom MCP environment-variable handling, and quieter automation discovery scans. Thanks to @mrubens for contributing these improvements.
- Show a workspace-shaped loading state while task history hydrates, preserve accepted or dismissed PR feedback in Discord, and add a Discord community link to the release-update dialog.

## 0.23.0 (2026-07-27)

This release surfaces active service issues sooner and improves task, automation, self-hosted, and MCP reliability.

### Highlights

- See active Roomote service incidents in the dashboard and task-start messages.
- Understand unrecoverable provider authentication failures directly in task conversations.
- Open the dashboard faster without repeated Slack channel lookups delaying other content.
- Run self-hosted ACME installations and environment-configured MCP servers more reliably.

### Minor changes

- Show active Roomote service incidents in the dashboard and task-start messages so users can understand when a platform issue may affect their work.

### Patch changes

- Keep self-hosted ACME installations starting reliably and let configured MCP servers use operator-provided environment variables and Node tooling in task sandboxes.
- Load the dashboard without waiting for repeated Slack channel lookups, while keeping automation configuration more resilient to slow Slack responses.
- Make task failures easier to understand by showing unrecoverable provider authentication errors clearly, and keep automation channels quiet until work reaches an outcome.

## 0.22.0 (2026-07-27)

This release gives self-hosted operators more flexible preview hosting and expands managed inference subscription support.

### Highlights

- Run self-hosted task previews on flat wildcard hostnames with documented Caddy and Cloudflare Tunnel configuration.
- Connect an eligible Grok subscription with device-code OAuth, and see usage for Grok, Z.AI, and Z.AI Coding Plan in Models settings. Thanks again to @pridemusvaire for the xAI/Grok subscription and Z.AI contributions.
- Send image attachments through configured OpenAI-compatible vision or coding models.

### Minor changes

- Support flat preview hostnames for self-hosted deployments, with runtime configuration, Caddy routing, production Compose coverage, and deployment guidance.
- Connect an eligible Grok subscription with device-code OAuth, use xAI models without exposing subscription tokens to task sandboxes, and see subscription usage in Models settings.
- Show Z.AI and Z.AI Coding Plan quota usage bars under connected provider rows in Models settings (5h and weekly windows from the monitor quota API).

### Patch changes

- Apply persisted flat preview hostname suffix settings consistently at runtime and in preview diagnostics.
- Allow image attachments when a custom OpenAI-compatible provider supplies the configured vision model or falls back to the coding model.

## 0.21.1 (2026-07-26)

This release restores reliable structured routing while preserving tool restrictions for non-task agent sessions.

### Highlights

- Keep routing and other structured agent responses working without granting non-task sessions tool access.

### Patch changes

- Restore structured routing output while keeping non-task agent sessions unable to use tools.

## 0.21.0 (2026-07-26)

This release expands self-hosted deployment options and inference-provider choice, while making agent activity and automation more reliable and secure.

### Highlights

- Deploy self-hosted Roomote behind private networks and reverse tunnels with supported internal TLS.
- Add Z.AI and Z.AI Coding Plan as inference providers, with International and China region selection. Thanks to @pridemusvaire for this contribution.
- Keep task titles, routing, and summaries safely text-only when they process externally supplied input.
- Inspect the latest response from a subagent while it runs and after it completes.

### Minor changes

- Support internal TLS for self-hosted deployments behind reverse tunnels and private networks, without requiring public DNS or a custom Caddyfile.
- Add Z.AI and Z.AI Coding Plan as inference providers with International or China region on connect.

### Patch changes

- Restrict non-task OpenCode sessions to text-only output so task titles, routing, and summaries cannot act on instruction-like input.
- Keep Discord event handling and public-fork pull-request reviews reliable, while allowing self-hosted Docker environments to start on nftables-only hosts.
- Show the latest response from running and completed subagents, and give Dependabot automation clearer impact analysis and completion reporting.

## 0.20.1 (2026-07-25)

This release makes chat-driven automation more reliable, keeping Discord tasks moving and report-thread replies connected to their work.

### Highlights

- Keep Discord tasks responsive and recover safely from slow API processing or retries.
- Reply to any automation report thread to continue the task behind it, not only merged pull-request reports.

### Patch changes

- Discord tasks keep processing reliably when API work is slow or a delivery needs to retry.
- Replies now reach the task behind every automation report thread, not just merged-PR digests.

## 0.20.0 (2026-07-24)

This release makes it easier to give Roomote context, follow work across chat, and complete setup with guidance that matches the task at hand.

### Highlights

- Reference configured GitHub, GitLab, Gitea, Bitbucket, Azure DevOps, or Linear issues directly in task requests without pasting a full URL.
- Follow contextual Roomote documentation throughout setup, matched to the provider and configuration step in progress.
- Reply to merged pull-request reports in Slack, Discord, Teams, and Telegram to continue the related task conversation.
- Get more reliable automation launches, CI investigation replies, model setup, and source-control setup.

### Minor changes

- Reference configured GitHub, GitLab, Gitea, Bitbucket, Azure DevOps, or Linear issues directly in task requests without pasting a full URL.
- See contextual Roomote documentation throughout setup, with guidance matched to the provider and configuration step in progress.
- Reply to merged pull-request reports in Slack, Discord, Teams, and Telegram to continue the related task conversation.

### Patch changes

- Keep automation launches and CI investigation replies connected to their tasks, and prevent stale pull-request review actions from conflicting with newer responses.
- Show automations as generally available throughout the product.
- Add models successfully when an OpenRouter key is stored in Settings, and keep role-selected models available when recommendations change.
- Onboarding no longer auto-selects the only available GitHub repository.
- Keep setup on the correct step after connecting source control and reconnect Gitea after credentials are saved.

## 0.19.0 (2026-07-23)

This release makes pull-request review feedback clearer and safer to handle across chat, with more reliable task resumption.

### Highlights

- Resolve the feedback in a notification or have Roomote handle all future feedback on a pull request.
- Replying in a review-feedback thread retires its pending buttons so stale actions cannot conflict with the conversation.
- Resumed tasks retain their original source-control provider through older resume chains.

### Minor changes

- Make pull-request review feedback easier to handle by retiring stale offers after thread replies and providing clear actions to resolve selected or all issues.

### Patch changes

- Keep snapshot-resumed tasks connected to their original source-control provider when they resume through older task chains.

## 0.18.0 (2026-07-23)

This release makes pull-request feedback easier to act on across chat, extends Gitea automations, and improves task routing and reliability.

### Highlights

- Act on pull-request review feedback from Slack, Discord, and Telegram, or have future feedback handled automatically.
- Use Gitea with CI Failure Triage and Resolve PR Conflicts automations.
- Route tasks with useful context from pasted GitHub and configured Linear issue links.
- See safe provider error details in the task conversation when a run fails.

### Minor changes

- Handle pull-request review feedback directly from Slack, Discord, and Telegram, including an option to automatically send future feedback to the owning task.
- Use Gitea with CI Failure Triage and Resolve PR Conflicts automations for failed builds and labeled conflicting pull requests.
- Route tasks using context from pasted GitHub and configured Linear issue links when that context is available.

### Patch changes

- Improve task conversations with uninterrupted structured answers, native Discord footer styling, and clearer visual-preview guidance for agents.
- Show safe provider error details in the original task conversation when a task fails, so users can understand what needs attention.
- Improve operator reliability with clearer environment-variable setup, safer worker credential handling, and more resilient instance reporting.

## 0.17.0 (2026-07-22)

Managed deployments gain stronger access and credential protections, while users get safer account controls and more reliable links, notices, and Discord updates.

### Highlights

- Keep managed deployments readable while pausing new tasks when access becomes read-only.
- Run managed sandboxes through a broker without storing shared Modal credentials in tenant deployments.
- Change email-and-password credentials from a dedicated Personal Settings flow.
- Get browser-reachable artifact links, reliable release notices, and clearer Discord task updates.

### Minor changes

- Add a brokered compute backend so managed deployments can run sandboxes without storing shared Modal credentials.
- Add managed deployment access controls that keep existing data readable while pausing new tasks when a deployment becomes read-only.
- Let email-and-password users change their password from a dedicated Personal Settings flow.

### Patch changes

- Use the public Roomote URL for cloud task artifact links so shared links open outside the deployment network.
- Keep Discord task footers on the latest reply and display pull-request titles cleanly.
- Show in-app release notices on deployments running channel builds by baking the product version into published images and reading it for the what's-new and update-available notices.

## 0.16.0 (2026-07-21)

Custom automations and wider CI triage coverage help teams automate more recurring work, with reliability improvements across task startup and integrations.

### Highlights

- Create custom automations with their own prompts, schedules, and destination channels for recurring work.
- Investigate failed Azure DevOps and Bitbucket Pipelines automatically with CI Failure Triage.
- Send Suggest Ideas results to Telegram and Microsoft Teams, and benefit from more reliable task startup and integrations.

### Minor changes

- Add CI Failure Triage for Azure DevOps and Bitbucket Pipelines, extending automated failed-build investigation to more source-control providers.
- Add custom automations with their own prompts, schedules, and destination channels so recurring work can run and report where teams need it.
- Let Suggest Ideas send its results to Telegram and Microsoft Teams destinations as well as existing supported channels.

### Patch changes

- Allow manual custom-automation runs to start while an earlier run is active, and keep report threads and footers tied to the correct automation.
- Fix Discord task reactions and pull-request notification rendering so task status and bracketed titles display correctly.
- Recover task runs whose workers stop responding during preparation so tasks no longer remain stuck indefinitely.
- Reject pull requests on plain-issue `list_issue_comments` and `create_issue_comment` for GitHub and Gitea so agents cannot read or post PR discussion through the issue-only tool paths.
- Improve self-hosted task startup and integrations by handling Docker bootstrap failures, public-edge OAuth callbacks, and non-GitHub webhook URLs correctly.

## 0.15.0 (2026-07-21)

Multi-SCM triage and mentions, richer chat and release UX, and more reliable self-hosted Docker boots and agent context.

### Highlights

- Expand Triage Issues across GitHub, GitLab, and Gitea, with optional custom instructions and GitLab pipeline CI failure triage.
- Start Gitea issue tasks from @mentions and pull richer Slack/Discord context with generic chat lookup tools and structured questions on more chat surfaces.
- Show in-app release notices and OpenRouter credit balance, plus safer member first-run access and faster home/settings navigation.
- Fix stuck Docker boots on self-host (including TRPC reachability and cancel), Discord reply/thread context, and default-branch self-healing from workers and GitHub webhooks.

### Minor changes

- Add generic chat message and channel lookup tools so agents can pull Slack or Discord communication context without choosing a platform-specific tool.
- Start Gitea issue tasks when teammates @mention Roomote, matching GitHub and GitLab issue-mention routing.
- Add GitLab Pipeline Hook support for CI Failure Triage so failed GitLab pipelines can launch the same triage workflow as other providers.
- Show sidenav release notices for available updates (self-host admins) and what's new after upgrades, sourced from GitHub release notes with changelog summary and highlights.
- Allow safe inline SVG in transcript widgets so agents can render charts and diagrams without active or externally loaded markup.
- Expand Triage Issues (formerly Triage GitHub Issues) to GitHub, GitLab, and Gitea so open/reopen issue webhooks post plan comments across those providers.
- Show OpenRouter credit balance on model settings so operators can see remaining credits next to their provider configuration.
- Expand structured `request_user_input` prompts across Slack, Linear, Teams, and Telegram so agents can collect choices on those surfaces the way they already can on Discord and the web UI.
- Add optional custom instructions to Triage Issues so teams can guide how opened issues are planned.

### Patch changes

- Include the message a Discord user replied to and the thread-starter message in agent context so Discord tasks no longer miss the problem statement the requester pointed at.
- Clear stuck Discord start-eye reactions that blocked later merge checkmarks, and update Discord task thread titles after launch instead of keeping provisional first-message titles.
- Stop Docker task provisioning when a task is canceled so cancelled self-hosted runs do not keep creating sandbox resources.
- Fix self-hosted Docker tasks stuck at Booting environment when workers cannot reach a public TRPC_URL from the task network.
- Make authenticated navigation respond immediately and avoid redundant user profile writes during routine authorization checks.
- Make home and personal settings navigation render without waiting on unrelated provider, GitHub, or repeated authentication lookups.
- Forward `issueNumber` correctly in the manage_source_control tool so agents can read and comment on plain issues instead of those actions rejecting a provided issue number.
- Stop GitHub App setup from emitting unreachable callback URLs when `R_APP_URL` is a loopback address on self-hosted installs.
- Include linked issues and pull requests in agent context when Roomote is mentioned on GitHub issues or PRs.
- Treat invalid or expired authentication cookies as signed-out sessions instead of failing the page render.
- Start tasks correctly when `R_MODEL` is a bare LiteLLM route name instead of failing provider resolution.
- Surface structured Docker boot failures instead of leaving workspaces stuck on Booting environment, preflight the daemon and worker image before spawn, and add a Validate environment button on Local Docker settings.
- Show a minimal usage bar on model settings subscription lines so plan usage is visible at a glance.
- Report the default branch the worker resolves from `origin/HEAD` back to the control plane so stale stored repository metadata self-heals instead of persisting until a manual installation resync.
- Handle the GitHub `repository.edited` webhook so stored repository metadata follows default-branch changes instead of going stale until a manual installation resync.
- Resolve implicit repository branches from the fetched `origin/HEAD` before using stored metadata, and fail clearly when no valid default branch exists.
- Guide Members through secure first-run access: invites show the invited role without exposing tokens and walk email invitees through the correct sign-in path.
- Stop self-hosted task sessions from hanging on the first OpenCode create when the worker cannot complete session bootstrap.
- Show linked issues and work items in the Task Info panel.
- Set the Roomote app icon automatically when creating a Slack app from a config token, and use a Slack-safe near-black manifest background so app saves no longer fail contrast checks.
- Use the configuration-token Slack app setup flow on Settings → Communications so installing Slack matches the guided setup path end to end.

## 0.14.1 (2026-07-19)

### Patch changes

- Quote web UI follow-ups into Discord-linked task threads (name + text blockquote) before the agent's next reply, matching Slack behavior and preserving quotes across web snapshot resume.
- Stop stacking a second empty Discord question shell when request_user_input enriches options; edit the existing prompt so users see one question with real choices.
- Support structured request_user_input on Discord end-to-end: post option buttons, accept button or text answers, and resume the paused agent so answering no longer leaves the run waiting.
- Back off transient provider retry attempts with exponential delay (1s, 2s, 4s) instead of retrying immediately after capacity failures.
- Fix sandbox WebGL by making the home directory traversable for Chromium's GPU process
- Show self-review and PR review feedback summaries in the task web view for web-only tasks by always writing the summary into task message history, not only when a chat route exists.
- Fix controller recovery scans for persisted worker-bootstrap restarts so the query no longer references invalid table aliases and bootstrap recovery can continue.

## 0.14.0 (2026-07-19)

### Minor changes

- Handle @roomote mentions on GitLab issues (not only merge requests): the first mention starts a linked task and later mentions on the same issue resume that task.
- Show ChatGPT, GitHub Copilot, and Kimi for Coding plan usage on Settings > Models, including remaining premium requests or rate-limit window percent used and reset times.

### Patch changes

- Apply the untrusted-content prompt framing to GitLab, Bitbucket, Azure DevOps, and Gitea comment follow-up messages, wrapping the triggering comment in a mention-request block and appending the shared injection-resistance policy

## 0.13.0 (2026-07-19)

### Minor changes

- Make presentational widgets follow the selected Roomote theme and provide native layout classes and CSS variables for agent-generated UI.
- Add an OpenAI-compatible inference provider option for any OpenAI API endpoint, including multiple named connections in Settings > Models.
- Add Triage GitHub Issues automation under Review Code that posts clarifying questions or a proposed plan on env-backed issues when they open or reopen.

### Patch changes

- Stop Discord (and Teams/Telegram) task runs from posting duplicate closeout messages after PR delivery by using the same parent-owned single-closeout lifecycle as Slack.
- Discord account-link setup instructions now arrive by DM with a short channel acknowledgement instead of full setup copy in public channels, deduplicated to one link DM per user per day, and turn Settings → Personal → Linked Accounts into a link to Personal settings
- Rebuild Discord thread context on follow-ups and snapshot resumes so agents receive earlier undelivered messages, the latest Roomote reply, and prior attachments instead of only the latest user text.
- Apply Slack-style unmentioned follow-up gating in Discord task threads so natural replies only work for people already in the conversation until the next @mention.
- Reuse the original Roomote task when a second GitHub issue @mention lands on the same issue.
- Recover stalled worker bootstraps promptly with bounded claim retries, a single fresh sandbox restart, and a provider-neutral bootstrap watchdog instead of waiting for the full orphan-recovery window.
- Strip Discord/Teams/Telegram prompt wrappers so task transcripts show only the user message text.
- Frame third-party text (issue bodies, PR discussion, automation source context) as untrusted data in agent prompts, with escaped delimiter blocks and a shared injection-resistance policy

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
