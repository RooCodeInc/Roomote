# Changelog

This file tracks product releases for Roomote (single monorepo version). Automated release entries are prepended by `pnpm run version`.

## 0.31.0 (2026-08-03)

This release expands Amazon Bedrock and deployment controls, refreshes Automations and self-hosted licensing, and makes task startup and provider connections more reliable.

### Highlights

- Use native Amazon Bedrock Runtime models alongside Mantle, including regional inference profiles and supported reasoning settings.
- Find and manage custom and built-in automations through a redesigned, filterable Automations experience.
- Disable curated integrations through a deployment policy without deleting saved credentials or affecting other provider types.
- Purchase or renew self-hosted licenses directly from settings with timely seat and expiry guidance.

### Minor changes

- Redesign Automations settings around scannable Custom, Enabled, and Available sections, with permalinked configuration dialogs, responsive custom automation controls, and category and provider-aware filtering.
- Let deployment operators disable the curated integrations catalog and its existing connections through an environment policy without deleting saved credentials or affecting other provider types.
- Let operators use native Amazon Bedrock Runtime models alongside Mantle, including regional inference profiles and supported reasoning settings, without changing existing Mantle configurations.
- Add direct Roomote Cloud purchase and renewal paths to self-hosted License settings, including low-seat and upcoming-expiry guidance for administrators.
- Show useful, dismissible product tips alongside task startup progress so users can discover Roomote capabilities while an environment boots.

### Patch changes

- Keep Azure Container Apps sandboxes suspended until Roomote deliberately wakes them, recover cleanly from leftover workers, and stop retrying runs whose sandboxes were deleted. Thanks to @tebieshi for contributing this improvement.
- Stop ChatGPT subscription connections from waiting forever on expired or blocked device codes, explain why authorization stopped, and offer a clean restart. Thanks to @daniel-lxs for contributing this improvement.
- Recommend Claude Sonnet 5 at medium reasoning for code review when operators apply supported provider presets, while retaining Opus for planning.
- Keep Discord task requests through account linking, focus onboarding on the required personal account connection, and preserve automation reply threads when tasks resume.
- Keep the Users settings invite list focused on links that still have uses remaining while retaining consumed invite records.
- Add a direct Personal settings shortcut to the signed-in user menu.
- Make ChatGPT, xAI, and GitHub Copilot device connections handle expiry, rate limits, restarts, and stale polling consistently, with clearer terminal errors across all three providers. Thanks to @daniel-lxs for contributing this improvement.
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

- Let interrupted MCP OAuth connections resume safely after sign-in, route GitHub issue links to their matching environment, and keep source-control attribution and review follow-up behavior accurate. Thanks to @daniel-lxs for contributing the MCP OAuth improvement.
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
