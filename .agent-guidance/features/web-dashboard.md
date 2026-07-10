---
title: Web Dashboard
status: active
last_reviewed: 2026-07-10
owner: engineering
summary: Technical documentation of the Next.js 16 web dashboard covering route structure, design system components, page architecture, setup sequencing, and state management.
---

# Web Dashboard

The Roomote web dashboard is a Next.js 16 application providing the primary interface for launching tasks, reviewing task history, managing environments, and configuring organization settings and integrations. Built with React 19, it uses tRPC for type-safe client-server communication and a comprehensive design system for consistent UI.

For a cross-surface overview of how work enters Roomote across the web dashboard, Slack, Linear, GitHub, and programmatic launch paths, see [Agent Entry Surfaces](./agent-entry-surfaces.md).

## Technology Stack

| Technology       | Version | Purpose                                           |
| ---------------- | ------- | ------------------------------------------------- |
| **Next.js**      | 16.1    | App Router, SSR, route handlers                   |
| **React**        | 19.2    | UI framework with concurrent features             |
| **TypeScript**   | Latest  | Type safety across components and API calls       |
| **Tailwind CSS** | 4.1     | Utility-first styling with custom design tokens   |
| **tRPC**         | 11.9    | Type-safe RPC between browser and Next.js         |
| **React Query**  | 5.90    | Server state management (via tRPC integration)    |
| **Radix UI**     | Latest  | Headless accessible UI primitives                 |
| **Zustand**      | 5.0     | Client-side state (layout options, sandbox state) |
| **Better Auth**  | 6.37    | Authentication and user management                |
| **Lucide React** | 0.575   | Icon library                                      |
| **Storybook**    | 10.2    | Component development and documentation           |
| **Vitest**       | 4.0     | Unit and integration testing                      |

## Child Surface Inventory

| Sub-surface                         | Kind         | Coverage   | Owning doc                                                              | Notes                                                                                        |
| ----------------------------------- | ------------ | ---------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/web/src/app/`                 | feature      | documented | [Route Structure](#route-structure)                                     | App Router route groups, task view, settings flows, onboarding, and route handlers.          |
| `apps/web/src/trpc/`                | api          | documented | [Web tRPC Router (Browser-to-Next.js)](../api/trpc-web.md)              | Browser-to-Next.js router, commands pattern, and client/server caller helpers.               |
| `apps/web/src/components/system/`   | feature      | documented | [Design System](#design-system)                                         | Shared primitives and design-system composition layer.                                       |
| `apps/web/src/components/sandbox/`  | feature      | documented | [Route Structure](#route-structure)                                     | Live and historical task UI plus the task side-panel surfaces under the sandbox route group. |
| `apps/web/src/components/settings/` | feature      | documented | [Route Structure](#route-structure)                                     | Settings-area UI and deployment/user settings sections under the authenticated route group.  |
| `apps/web/src/hooks/`               | feature      | documented | [Web tRPC Router (Browser-to-Next.js)](../api/trpc-web.md#client-usage) | Hook layer around tRPC queries/mutations and web-only client state helpers.                  |
| `apps/web/src/lib/server/`          | architecture | documented | [Runtime Environment Handling](../architecture/runtime-env.md)          | Server-only env/runtime helpers used by the Next.js host.                                    |

## Route Structure

The app uses Next.js App Router with route groups to organize pages by auth state and purpose.

### Route Groups

```text
apps/web/src/app/
├── (authenticated)/                # Main dashboard (requires Better Auth auth)
│   ├── (cloud-actions)/            # Standalone quick-action dialogs
│   │   └── revert-commit/          # Commit revert workflow
│   ├── analytics/                  # Usage analytics dashboard
│   ├── background-agents/          # Legacy redirect to /settings/automations
│   ├── home/                       # Home page components
│   ├── page.tsx                    # Authenticated root page (renders Home)
│   ├── preview/                    # Repo/sha/pr preview landing page
│   ├── settings/                   # Route-based settings area
│   │   ├── personal/
│   │   ├── environments/
│   │   │   ├── new/
│   │   │   └── [environmentId]/edit/
│   │   ├── cloud-projects/         # Legacy environment-settings redirects
│   │   │   ├── projects/new/
│   │   │   └── projects/[environmentId]/edit/
│   │   ├── agent-guidance/
│   │   ├── automations/
│   │   ├── background-agents/      # Legacy redirect to /settings/automations
│   │   ├── integrations/
│   │   ├── skills/
│   │   └── vibes/
│   ├── tasks/
│   ├── [...missing]/page.tsx       # Authenticated missing-route boundary
│   └── layout.tsx                  # SideNav + setup/onboarding redirects
│
├── (sandbox)/                      # Task execution view
│   └── task/[taskId]/
│       ├── artifacts/
│       │   └── [...path]/          # Artifact browser + deep artifact paths
│       ├── browser/                # Live Preview side-panel alias route
│       ├── diff/
│       ├── info/
│       ├── logs/                   # Logs side-panel alias route
│       ├── previews/[...segments]/ # Deep preview-path alias route
│       └── terminal/               # Terminal side-panel alias route
│
├── (centered)/                     # OAuth callback/success pages
│   ├── authorized/
│   ├── github/callback/
│   ├── linear/auth/success/
│   ├── slack/auth/success/
│   └── slack/callback/
│
├── (onboarding)/
│   ├── onboarding/
│   └── setup/
│
├── (unauthenticated)/
│   └── sign-in/[[...sign-in]]/       # Provider-only local sign-in and account creation
│
├── api/                            # /api/* route handlers
│   ├── artifacts/
│   ├── auth/
│   ├── cloud-jobs/
│   ├── linear/
│   ├── mcp-oauth/
│   ├── slack/
│   ├── tasks/
│   └── trpc/[trpc]/
│
├── auth/dev-login/route.ts         # Non-production one-click login helper
├── webhooks/auth/route.ts         # Better Auth webhook endpoint
├── robots.ts
├── sitemap.ts
└── layout.tsx                      # Root layout (fonts, providers)
```

### Key Pages

#### App Shell And Auth Readiness

`RootProviders` wraps the dashboard in Better Auth, auth, analytics, theme, and tRPC providers. Client auth is intentionally staged: [`AuthProvider`](../../apps/web/src/components/layout/providers/AuthProvider.tsx) blocks only until Better Auth has loaded the active session and user identity, then exposes the signed-in user with deployment-level feature flags plus any user-scoped overrides. Roomote does not use Better Auth workspace management locally.

Authenticated layouts should keep shell chrome visible while slower setup/onboarding checks resolve. [`AuthenticatedLayoutClient`](../../apps/web/src/app/%28authenticated%29/AuthenticatedLayoutClient.tsx) and [`SandboxShell`](../../apps/web/src/app/%28sandbox%29/SandboxShell.tsx) render `NavbarHeader`, `SideNav`, status chrome, and page content once the user is signed in, then redirect from effects only after setup or onboarding queries prove that `/setup` or `/onboarding` is required. A deployment that has completed bootstrap auth and GitHub setup can still browse the dashboard before any environments exist; task launch surfaces nudge environment creation but still allow bare-repo launches, and only environment-dependent launch paths (Auto routing, preview launches) enforce an environment. While initial setup is still incomplete, the shared signed-out redirect helper routes visitors to `/setup` instead of `/sign-in` so the deployment can bootstrap its first auth provider. There is no workspace switcher, Team settings page, or invitation flow in the self-hosted product surface.

Roomote does not embed the hosted Pylon support chat widget in app chrome. The signed-in shells keep the feature-request entry and user menu, but there is no global support-chat provider, custom `Support` nav trigger, or `/api/pylon/chat-settings` route. Pylon remains available only as an optional deployment MCP integration for tasks that need customer-support context.

The signed-in user menu also includes a `Docs` link immediately above `Log Out`. It opens the public documentation site at `https://docs.roomote.dev` in a new tab.

#### Documentation Site (external)

The public product documentation is **not** served by the web app. It lives in the standalone `@roomote/docs` Mintlify workspace under `apps/docs/` and is published at [docs.roomote.dev](https://docs.roomote.dev). See [Public Docs Site](./public-docs-site.md) for how that workspace is structured and maintained.

To preserve old in-app documentation URLs, `apps/web/next.config.ts` defines permanent redirects from the legacy routes to the external docs site: `/docs` → `https://docs.roomote.dev` and `/docs/:path*` → `https://docs.roomote.dev/:path*`. The web app no longer bundles Fumadocs, docs MDX content, the `createMDX` wrapper, or the `/api/docs-search` endpoint; app-facing docs links resolve through `getDefaultDocsUrl`, which returns `https://docs.roomote.dev`.

#### Dashboard Home (`(authenticated)/home`)

Landing page after sign-in. Shows:

The home route is now a stable destination after auth and setup completion. It no longer bounces users to `/tasks` just because the GitHub-installations query is empty or still refreshing; setup enforcement stays owned by the authenticated layout and `/setup`.

- **Prompt composer**: Primary web entry point for starting delegated Roomote work and the intended long-term `Generalist` / `StandardTask` launch surface for natural-language tasks
- **Onboarding task suggestions**: Optional one-time horizontal suggestion strip under the composer that appears only on `/`, shows four dismissible first-task ideas, and pre-fills the prompt query param when clicked
- **RecentTasksList**: Tasks from the last 7 days with status indicators
- **PullRequestsList**: Recent GitHub PRs created by agents
- **OnboardingCard**: Prompts to install GitHub app if not configured

[`Home.tsx`](../../apps/web/src/app/%28authenticated%29/home/Home.tsx) currently sorts `CloudAgentType.StandardTask` first and defaults to it when a Generalist agent is available and no prior selection is restored. If no Generalist agent is present, Home falls back to the first available filtered agent. Natural-language work on Home now launches through the Generalist-backed `StandardTask` path.

Home supports two launch modes. Explicit launches work with or without an environment; only Auto requires one:

- **Explicit launch**: The user picks an environment, a single repository, or `All Repositories` in the UI, then the web app launches a `Generalist` / `StandardTask` job through the web-router `cloudJobs.createStandardTask` mutation. Repository-only selections launch bare-repo tasks without an `environmentId`; the server command only rejects launches that carry neither an environment nor a repository target. When no environments exist yet, Home shows a warning banner nudging environment creation but still allows bare-repo launches.
- **Auto launch**: When the workspace stays on `Auto`, the Home page first calls the web-router `cloudJobs.routeHomeTask` mutation to choose the environment before the web app launches the task. On this surface, Auto is environment routing only because the delegated agent is fixed to `Generalist`, so Auto requires at least one environment. With zero environments, the send button is disabled and `TaskPromptInput` surfaces the disabled reason as a tooltip on the send button instead of silently ignoring clicks.
- **Specialized GitHub-shaped inputs**: Some GitHub-oriented flows can launch dedicated task types from the web UI instead of relying on GitHub webhooks. These are explicit quick-action paths, not the default natural-language task-entry model.
- **Launch runtime controls**: Home defaults new launches to `OpenCode` through the shared launch-default constant. Task model selection is now deployment-configured instead of hidden in env vars alone: admins manage an allow-list of provider/model pairs plus a default model in `Settings > Models`, and the Home page, preview launch flow, and build-from-artifact dialog all show a model picker seeded from that deployment default. Web launches submit the selected `model` through the shared `resolveEvalHarnessSelection()` path, and tasks keep the chosen model only for the start that created them; changing the allow-list later does not retune already-running work or resumed snapshots because the selected default/model id is persisted into `payload.harnessModelOverrides` at launch time. The compute-provider selector is always available to authenticated users and is no longer gated by the debug UI or a feature flag; the selected compute provider is submitted with every launch and persisted with the restored Home workspace selection.
- **Environment branch pinning**: When the same advanced launch controls are available and the selected environment has exactly one configured repository, Home shows the branch picker for that repository. Branch options come from the existing GitHub branches query, and explicit launches submit the concrete repo plus chosen branch alongside `environmentId` so workspace setup can prepare that branch. Multi-repo environments keep the existing environment-only launch payload and do not show a branch picker.

The onboarding flow launches a hidden Suggested Tasks task over the selected repository set. That task runs in the same scoped single-repo or multi-repo workspace model as setup, submits up to five suggestions through a task-scoped MCP tool, persists the batch in `task_suggestions`, and keeps dismissals deployment-wide so users see the same remaining queue. Each persisted suggestion can now carry optional `category` (`bug`, `security`, `chore`, `feature`, or `improvement`) and `priority` (`P0`, `P1`, `P2`, or `P3`) classifications. Slack renders priority first, then category, as emoji-backed badges on the suggestion title. The prompt also includes any admin-configured suggestion preferences from Agent Guidance. The same prompt contract is now reused by the scheduled Suggest Ideas automation, which scans every active GitHub repository in the deployment, attaches per-suggestion launch metadata to each persisted suggestion, ranks environment-backed suggestions ahead of bare-repo suggestions, and posts its follow-up suggestions through the configured Slack channel.

#### Preview, Redirects, And Access Routes

Several authenticated routes now exist primarily to preserve old URLs or gate preview access:

- **`/preview`** renders `PreviewEnvironment` only when the request includes valid `repo`, `sha`, `pr`, and `branch` query params and the signed-in user has repo access.
- **`/background-agents`** and **`/settings/background-agents`** are legacy client redirects to `/settings/automations`.
- **`/settings/cloud-projects`** and its nested `projects/*` routes are legacy redirects into the current environment settings flows.
  The old workspace-switching, bootstrap-recovery, and preview-allowlist routes have been removed with the local multi-tenant model. Preview access is user-authenticated and tied to the current deployment.

#### Automations (`(authenticated)/settings/automations`)

Automations is the settings subpage for proactive agent work. The page groups controls under `Slack automations`, `Automations for Roomote Managers`, and `Other automations`. Auto-respond channels stay first, while every Slack-posting automation now owns its own searchable `Post results to` destination inside the expanded card instead of relying on a shared Manager Channel block.

- **Auto-respond channels**: Replaces the old single `Roomote Channel` control. Admins can configure multiple Slack channels, each with optional instructions, and removing the last saved channel implicitly turns the automation off. The card stays behind `FeatureFlag.SlackChannelAutoStart`, keeps the existing `slack_channel_auto_start` automation key, stores per-channel instructions on `background_automation_targets.metadata.instructions`, and shows example channels like `#ask-engineering`, `#bugs`, `#support-inbound`, and `#ops-requests` when no channels are configured. Auto-respond channels now always use the baseline `Always start a task` behavior.
- **Slack destination picker**: `SlackChannelSelect` is the shared searchable picker built from the design-system `Popover` and `Command` primitives. `automations.listSlackChannels` now returns structured options with `id`, `name`, `label`, `isPrivate`, and `isMember`, and every Slack-posting automation uses that same option shape instead of freeform channel-name or channel-ID text entry.
- **Weekly Manager Stats**: Configures a weekly digest that posts into its own selected Slack channel on Fridays at 16:00 in the connected Slack workspace timezone and can be triggered manually from Automations. The digest summarizes active users, Roomote PR share, total PR volume, LOC added and removed, the most active repository, and top users. It always links back to the analytics page, and the Slack message always includes a small footer link back to the Weekly Manager Stats automation settings.
- **Review Code**: Manages the singleton Review Code automation stored in `background_automations` under key `review_code`. The page shows reviewer defaults even before the automation row exists, writes enablement plus reviewer settings to that automation row, watches repositories across all environments, and defaults autonomous review to Roomote-authored PRs. Admins can turn on `Review PRs from other authors` in the Review Code card; that persists `reviewAllPullRequestAuthors` on the `review_code` automation settings and allows automatic review for PRs opened by authors outside Roomote.
- **Resolve PR Conflicts**: Configures scheduled merge-conflict scanning and auto-resolution labels.
- **Suggest Self-improvements / Suggest Ideas / Summarize Merged PRs / Alert on Config Errors / beta triage cards**: Every Slack-posting automation persists its own Slack destination through `background_automation_targets` with `provider = 'slack'` and `target_kind = 'slack_channel'`. Runtime delivery prefers that per-automation target first.

Manual `Run now` actions enqueue the scheduled BullMQ job first and treat background-run debug row creation as best-effort bookkeeping, so a transient database write failure after enqueue does not make the UI report a failed trigger or encourage duplicate manual runs.
The page also exposes a `Recent runs` debug panel on automation cards when run history exists. That panel shows the latest run status, trigger kind, BullMQ job id, relative timestamp, any stored error, and a deep link back to the most relevant task or Slack destination when one is available.

This page is the primary dashboard surface for user-facing automation configuration. The ongoing autonomous reviewer settings live in the same automation settings model as the other background automations instead of in cloud-agent rows.

The page is intended for deployment admins. Legacy cloud-agent reviewer rows are not part of the Roomote configuration model; Review Code reads and writes only the `review_code` automation row.

#### Tasks (`(authenticated)/tasks`)

Filterable task list with status badges, pagination, and selection/bulk delete flows.

Task history, side-nav quick access, and other task pickers rank tasks by recent activity (`tasks.activity_at`) instead of creation time, so older tasks with new messages float back to the top.
Task PR badges and the dashboard's PR filters resolve from the task-level `task_pull_requests` linkage first, so a newer `SnapshotResume` job cannot hide an existing linked PR just because that latest `cloud_jobs` row lacks inherited `pr*` metadata.
Task history also supports model filtering. The shared `TaskFilters` control now offers a model dropdown backed by `filters.models`, and the server maps that choice directly to `tasks.model` so users can narrow history to launches that used a specific enabled model.

#### Work Queue Removal

Roomote does not expose the old Work Queue dashboard. The authenticated
`/queue`, `/queue/[queueItemId]`, and `/queue/configure` routes have been
removed, and navigation or command-palette entries must not link to them even
when old queue-related metadata exists.
The old analytics `taskQueue` and `queueProgress` tRPC endpoints plus their
server-side Task Queue projections have also been removed; do not reintroduce a
hidden dashboard data path for them behind analytics flags.
The old web `queue` tRPC router and queue-status polling helpers have also been
removed. Web-created task launches, environment definition runs, snapshot
operations, and suggestion implementation runs must use the direct launch
contract and receive an immediate task id.

The web dashboard should route web-created tasks directly to task pages. If a
launch path cannot return a cloud job and task id immediately, treat it as a
launch error instead of adding a fallback queue UI.

#### Analytics (`(authenticated)/analytics`)

Usage analytics with:

- **AnalyticsObjectSwitcher**: Left-rail object switching between `PRs` and `Tasks`, plus a `Live Queue` route when its narrower flag is enabled.
- **Right-side analytics surface**: Dedicated object header, desktop download action, and card-based chart presentation
- **AnalyticsFilterBar**: Object-specific filters, plus the mobile filter dialog for `Time range`
- **AnalyticsControlRow**: `By` tabs with a desktop `Time range` select
- **AnalyticsGranularitySelector**: Centered in-card chart selector with `By Day`, `By Week`, `By Month`, and `By Year` options
- **PullRequestSummaryCards**: PR-only summary cards for Roomote PR share, merged Roomote PR rate, and per-author throughput normalized by exact elapsed time in the selected range and chart granularity units
- **AnalyticsStackedBarChart**: Card-wrapped time-series chart with segment drill-down for PRs and tasks
- **PR analytics semantics**: PR analytics read from cached GitHub PR facts stored in Postgres and refreshed on a scheduled cadence plus GitHub webhook fast-path updates. For bounded time ranges like `7d` or `30d`, if a selected repository has not finished its first historical backfill yet, the server seeds just that requested recent window on demand before reading from the cache. Full-history backfills stay on the background sync path, so `All Time` views do not block on a synchronous rebuild while still marking the Roomote-created subset via `task_pull_requests`
- **AnalyticsDetailsDialog**: Drill-down rows with PR `Created By` and conditional `Task Link` support for human-created vs Roomote-created PRs

#### Settings (`(authenticated)/settings`)

Settings is now a route-based area with a local settings rail on desktop and a dropdown switcher on mobile.

- **Deployment operators**: Signed-in users hold an `admin` or `member` role (`users.role`). Admins operate the deployment (all admin-only settings pages, user management); members use the product without deployment management. The first user of a deployment is its founding admin.
- **Personal**: Also includes the `Color Theme` preference, which saves immediately as `Light`, `Dark`, or `Auto (System-defined)`, defaults every user to the browser/system setting until changed, and drives the dashboard theme without a separate nav toggle. The user-level `Narration Mode` preference now defaults on for users without a saved setting, hides tool and command rows in task conversations, and renders reasoning inline when enabled. Regardless of whether narration mode is on, reasoning now appears immediately when the worker streams it instead of using the older default-mode reveal delay and short-thought suppression path; the toggle only changes the presentation shell for reasoning, not whether short thoughts are allowed to appear. Linked accounts only show secondary detail once an account is linked; credential-based link flows expand inline setup instructions after the user clicks `Link`, and those setup instructions can include provider docs links from shared linked-account setup metadata when available. Microsoft Teams linked accounts appear here only when Microsoft Entra auth is configured or the user already has a Microsoft Teams auth account.
- **Settings pages**: The settings rail currently includes `Personal`, `Users`, `Models`, `Environments`, `Live Previews`, `Integrations`, `Communications`, `Agent Guidance`, `Automations`, `Skills`, `Vibes`, and `Experimental`.
- **Users**: Adds the admin-only `/settings/users` page controlling who can sign in to the deployment. Membership in the connected Slack workspace or Microsoft tenant always admits (shown as informational rows, with the Slack anchor captured at first sign-in); everyone else joins through invite links managed here via the `accessPolicy` tRPC router (`createInvite` with label/uses, `revokeInvite`, and a list showing usage and joins). Only a hash of each invite token is stored, so the link is copyable exactly once at creation. Invited users can sign up with email/password or any configured provider; the first admin's setup link acts as the system invite. Invites carry an Admin/Member role granted to the users they admit, chosen at creation and shown as a badge on admin invites. The page ends with a list of the deployment's active (non-deleted) users — avatar, name, email, join date, a `You` badge, an Admin/Member role selector (`accessPolicy.updateUserRole`), and a remove button (`accessPolicy.removeUser`) behind a confirmation dialog — returned by the same `accessPolicy.get` query. Role and remove controls are locked on your own row and for the last remaining admin, mirroring the server-side guards; removal signs the user out immediately, keeps their task history, and frees their email for a future re-signup. Enforcement details live in [Authentication & Authorization](../architecture/auth.md).
- **Settings confirmations**: Settings-page destructive actions, credential removal, disconnect flows, and other user-confirmed mutations should use the design-system `Dialog` primitive with a controlled `open` state, `DialogHeader`, `DialogDescription`, and `DialogFooter`. Do not use browser-native confirmation APIs such as `window.confirm`; they are hard to test, bypass Roomote styling/accessibility conventions, and can interfere with browser automation.
- **Environments**: Groups source control, environments, and environment variables, and owns the `/settings/environments`, `/settings/environments/new`, and `/settings/environments/[environmentId]/edit` routes.
- **Agent Guidance**: Stores shared deployment-wide guidance that is included in every task before environment-specific agent instructions, plus a separate `Authorship Rules` section that saves natural-language authorship guidance, shows the compiled rule preview and compiler issues, and persists the compiled output on `background_agent_settings` for launch-time authorship evaluation. That page still includes the separate `Task Suggestions` section for admin-only suggestion preferences that shape Suggested Tasks prompts without affecting every other task.
- **Automations**: The `Relay review results to linked Roomote tasks` reviewer toggle remains a deployment-level control, and admins pair it with a manual creator picker. Actual GitHub review relays only fire for PRs whose reusable PR owner task was created by a user selected in the `review_code` automation settings. Slack-posting automations own their destinations through `background_automation_targets`. Background jobs such as Review Code, Suggest Ideas, Triage Sentry Issues, and Triage Dependabot Alerts persist deployment-level enablement, schedule/last-run state, or feature settings in `background_automations`, wake from BullMQ on an hourly scheduler, verify prerequisites once for the deployment, enqueue hidden automation tasks, and then update the matching `lastRunAt` after the enqueue succeeds. Suggestion-producing automations use `CloudTaskType.SuggestedTasks` so actionable Slack replies can be tracked and launched by reaction. Admins manage durable background automations from the standard automations settings surface.
- **Integrations**: Splits deployment enablement into `Installed` and `Available` sections, rendered in a one-column mobile grid and two-column desktop grid. Slack, Microsoft Teams, and Linear are pinned first as first-class deployment integrations. Teams is status-only here: the card reads `TEAMS_BOT_APP_ID` / `TEAMS_BOT_APP_PASSWORD`, shows the public `/api/webhooks/teams` Azure Bot messaging endpoint when bot config is missing, and points users to Personal settings for Microsoft Teams account linking when `ROOMOTE_AUTH_MICROSOFT_*` is also configured. Curated OAuth-backed MCPs still use the existing redirect flow, while Snowflake appears as an admin-configured card that opens a generic credential dialog, captures an account identifier, username, Programmatic Access Token, role, optional warehouse, and optional database, keeps stored secrets server-side during edits, preserves the active Snowflake credential when the field is left blank so legacy key-pair-backed connections can still be updated without forced conversion, keeps warehouse optional so Snowflake can fall back to the account default, shows connected account and role details, and exposes the edit dialog from a gear button beside the disconnect action. Connected MCP cards can also open `Manage tools`, which lists the current upstream tool inventory, lets admins disable individual tools while keeping the connection active, and still shows each raw tool id under its human-readable label. Sentry setup is MCP-only in Settings > Integrations: the deployment-level Sentry connection powers both interactive Sentry context and scheduled Sentry triage.
- **Models**: Adds the admin-only `/settings/models` page. It opens with an `Inference Providers` section, backed by `taskModels.providerSetup` / `taskModels.saveProvider`: it lists only the connected providers (those with a saved or runtime-env API key) from the shared setup catalog (OpenRouter, Vercel AI Gateway, Requesty, Baseten, Together AI, OpenAI, Anthropic, Moonshot AI, MiniMax, OpenCode, Amazon Bedrock, Google Vertex AI, Google Gemini) with per-row key rotation, plus an `Add provider` button that reveals a picker of unconnected providers and a key field (shown directly when nothing is connected yet), so admins can connect multiple providers at once. Providers whose catalog entry declares `additionalEnvFields` (Amazon Bedrock's AWS region, Google Vertex AI's project ID and location) render those extra inputs in the add-provider form and the setup wizard step; required extras gate the save, and every value is persisted as its own encrypted env var. Vertex accepts pasted service-account JSON in `GOOGLE_APPLICATION_CREDENTIALS` (materialized to a file at the opencode spawn points) or a host file path via runtime env. Keys show masked when saved and locked with an env-managed badge when supplied via runtime env vars. Saving encrypts the key into the `environment_variables` table and records the provider in `deployment_settings.setup_new_state.modelProvider` (keeping the setup wizard preselection in sync) but, unlike the setup step's `setupNew.saveModelConfig`, does not reset `runtime_model_config`, so existing default/helper/vision/code-review/planning model choices are preserved. Connecting a provider the deployment has no configured models for yet also auto-adds that provider's recommended models into `task_model_settings` (`buildAutoAddedTaskModelSettings` in `apps/web/src/trpc/commands/task-models/auto-add-models.ts`): recommendations come from the centralized `RECOMMENDED_TASK_MODELS` list in `packages/types/src/recommended-task-models.ts` — one shared list of models with display names and families, mapped per provider to that provider's slugs (`mapRecommendedTaskModels`; OpenRouter's map doubles as the default `TASK_MODEL_CATALOG`) — release-based by design, always include the provider's `defaultRoomoteModel`, and are enabled on add without metadata (the metadata refresh action backfills it); on deployments that never persisted model settings the implicit default catalog is first filtered to connected providers so the seeded list only contains usable models. Re-saving credentials for a provider that already has configured models never reseeds (deliberately removed models stay removed), the existing default model is kept whenever it survives, and the save response's `addedRecommendedModelCount` drives the success toast, model-list refresh, and a scroll to the Models section. The setup wizard's `setupNew.saveModelConfig` runs the same auto-add so the first launch offers a usable model list. Below that, the page edits the singleton `deployment_settings.task_model_settings` record, lets admins enable or disable models, and requires the default model to stay inside the enabled set. The `taskModels.get` catalog additionally appends every connected provider's full recommended list (`appendRecommendedTaskModels`), including the ChatGPT subscription's `openai/`-prefixed recommendations: not-yet-persisted entries render as disabled metadata-less rows, and recommended models of connected providers show a lock instead of a delete action (they rejoin the catalog on the next read anyway; disabling is the way to stop using them, and deleting the provider still cascades them away). Model ids are `provider/model` slugs: adding a model asks for the provider (offering only connected providers, with a hint to connect one when none are) and the model slug separately, bare `author/model` slugs still normalize to `openrouter/author/model`, and bare slugs whose prefix is another known provider id (see `DIRECT_TASK_MODEL_PROVIDER_IDS` in `@roomote/types`, which includes direct labs plus the Vercel AI Gateway) are kept under that provider instead of being rewritten to OpenRouter. The available-models list and the default/helper/vision/code-review/planning dropdowns are grouped by provider. Each saved model can carry optional metadata in the same JSONB settings payload: context window, max output tokens, input modality types, per-token input/output prices, and `lastRefreshedAt`. The page can refresh that metadata from `models.dev` in one batched catalog fetch; gateway-routed models (`openrouter/...`, `vercel/...`) prefer their gateway's models.dev provider entry for pricing, OpenRouter models also prefer a live OpenRouter price override when `OPENROUTER_API_KEY` is available, and add-model lookup resolves OpenRouter models from the OpenRouter model API and all other providers (Vercel AI Gateway and direct labs) from the models.dev catalog. Operators should use the refresh action after deploy or after adding custom models so the list shows current metadata without requiring a database migration. The same page persists optional helper, vision, code review, and planning model selections into `deployment_settings.runtime_model_config`; env-managed role model and reasoning selectors are disabled, and each locked control gets a lock icon with a tooltip naming the runtime env var that owns it so DB saves cannot pretend to override runtime env. The code review model overrides the default coding model for GitHub PR and GitLab MR initial review and review-sync tasks when set, and falls back to the default coding model when unset (PR review follow-ups always use the default coding model). Each default-model row also carries a compact per-role `Reasoning` selector (`Low`, `Medium`, `High`, `Extra high`) persisted into the same `runtime_model_config` record (`roomote*ReasoningEffort` fields, reusing the shared `ReasoningEffort` enum); when no level is persisted the selector shows the Roomote role default from `DEFAULT_MODEL_ROLE_REASONING_EFFORTS` (coding `medium`, helper `low`, vision `low`, code review `high`, planning `high`), and the same defaults are applied at runtime by `resolveEffectiveModelRuntimeEnv` whenever no explicit level is configured; the selector is hidden and runtime defaults are skipped when the role's resolved model has metadata reporting `supportsReasoning: false` (a `TaskModelMetadata` flag parsed from the models.dev `reasoning` boolean and the OpenRouter `supported_parameters` list), while unknown support keeps the selector visible and the default applied; the resolved values flow to workers and non-task calls as `ROOMOTE_*_REASONING_EFFORT` env vars (runtime env overrides win over persisted values) and are materialized into the generated OpenCode config as per-model provider options (OpenRouter `reasoning.effort`, Anthropic thinking budgets, generic `reasoningEffort` elsewhere), with the vision level scoped to the hidden visual subagent, the planning level applied to Roomote's `architect` planning agent, and a role's level applied only when the exact configured model is in play (coding model wins when roles share a model). Those settings affect only new task starts; currently running tasks and snapshot resumes keep the model that was persisted into their launch payload. The page always shows a `Planning model` row persisted as `roomotePlanningModel` / `roomotePlanningModelReasoningEffort`; at runtime the resolved value flows to workers as `ROOMOTE_PLANNING_MODEL` / `ROOMOTE_PLANNING_MODEL_REASONING_EFFORT` and overrides Roomote's `architect` planning agent in the generated config, falling back to the coding model when unset.
- **Skills**: Adds the admin-only `/settings/skills` page (feature-flagged by `CustomSkills`) with an `Installed` union view derived from environment YAML, CLI-backed marketplace search (`npx skills find`), a manual `SKILL.md` paste flow for inline skills, and multi-environment availability editing that patches `config.skills` for marketplace installs plus `config.manualSkills` for pasted skills. Those environment skills are installed during workspace setup and then refreshed into the worker's active runtime skill directory on task start, with Roomote's packaged skills winning if a name collides and unrelated existing runtime skills left in place. Manual skills stay separated by exact pasted content so one environment's YAML variant is not overwritten just because another environment uses the same manual-skill name.
- **Vibes**: Adds the operator-only `/settings/vibes` page after `Skills`. It auto-saves normalized Slack emoji names for summon, acknowledgement, and completion reactions, includes same-origin placeholder PNG downloads that operators can turn into custom Slack emoji, and shows an explicit-save `Custom style` textarea. That textarea stores up to 400 characters of tone-of-voice guidance, validates the text server-side as style-only guidance before persistence, and layers onto the default Roomote tone for fast-agent prompts. It does not change execution, tooling, or workflow behavior.

#### Sandbox View (`(sandbox)/task/[taskId]`)

Real-time task execution interface. Routes resolve `taskId` aliases (e.g., `current`, `latest`) to canonical IDs. Session state drives UI:

- **booting**: Shows `Startup` component with progress indicator
- **boot-failed**: Error state with retry option
- **interactive**: `LiveContent` with chat plus sidebar panels for terminal, logs, previews, diff, artifacts, and task info
- **historical**: `HistoricalContent` with read-only snapshots
- **resuming**: Transition state from snapshot to interactive
- **not-found** (route-level fallback): Permission denied or invalid task

The main task page is also the backing surface for several URL-addressable side-panel aliases:

- `/task/[taskId]/artifacts` and `/task/[taskId]/artifacts/[...path]` for artifact browsing
- `/task/[taskId]/diff` and `/task/[taskId]/info` for direct panel linking
- `/task/[taskId]/logs` and `/task/[taskId]/terminal` for side-panel state restoration
- `/task/[taskId]/browser` for the Live Preview panel
- `/task/[taskId]/previews/[...segments]` for deep preview paths preserved from older links

These alias pages re-export the main sandbox page and let the route parser restore the intended side-panel state without duplicating task-view logic.
The Terminal side panel is always available for interactive cloud jobs; its sidebar button, command-palette action, and `/terminal` route parsing are not gated by a feature flag (the legacy `TaskTerminal` flag has been removed).

The sandbox uses:

- `SandboxProvider`: WebSocket connection, IPC state sync. When the live connection's retry budget is exhausted, `useSandboxLiveConnection` auto-recovers instead of waiting for a manual Reconnect click: a browser `online` event, the tab becoming visible again, or a slow 60s background interval re-triggers the reconnect path (throttled, and only while disconnected with a surfaced connection error; see `hooks/services/sandbox-live-auto-recovery.ts`).
- `ConnectionStatusBanner` (`ErrorFallback.tsx`): live-connection status above the transcript. The banner now carries an explicit connection-failure category instead of collapsing every disconnect into one generic error: initial attach exhaustion maps to `backend_unavailable`, established retry exhaustion maps to `client_reconnect_failed`, auth or token refresh problems map to `auth_error`, and token/bootstrap fetch failures that are not auth-shaped map to `transport_error`. The banner copy uses those buckets to distinguish `Could not reach the live task`, `Could not restore the live task connection`, and auth-specific access-refresh failures without naming the sandbox server. While a sleep snapshot is in progress or the job already has a snapshot (`isCloudJobSnapshotting` / `snapshotId`), all connection banners are suppressed because sleep transitions tear down the live connection on purpose and the transcript renders the `Going to sleep` row for exactly that window (`SleepWakeMessages` shares the same predicate). `sleepRequestedAt`-only teardowns (non-resumable tasks) keep the banner so the page never goes statusless.
- `HistoricalSandboxProvider`: Snapshot-based read-only view
- `useSandboxStore`: Zustand store for UI state (active tab, panel visibility)
- `TaskInfoPanel`: Task metadata sidebar. It shows the current inference cost by reading `task.inferenceUsage.costMicroUsd`, which the web tRPC task lookup computes from raw `task_inference_usage_events` rows on each fetch. The value refreshes with the task page's existing session polling; there is no denormalized task-level inference-cost rollup to maintain.
- `TaskInfoPanel` derives Participants only from transcript messages that carry a persisted user identity. System and automation prompts keep a null user identity at the web read boundary, so automatic Roomote-agent work does not appear as an `Unknown user`; its agent attribution remains in the Creator row.
- When preview URLs exist, the task view exposes a `Live Preview` entry point.
  It opens the preview side panel against the cloud job's current preview URL,
  keeps the same-origin iframe auth trampoline, and includes an `Open` action
  for launching the same preview in an external browser tab.
- User-authored text bubbles render as plain text so prompts keep literal markdown characters, while assistant text continues to use the markdown/Streamdown renderer.
- Transcript visibility for session prompts and Roomote runtime envelopes now comes from a server-stamped `visibleInTranscript` flag carried in the sandbox/session message model. Bootstrap, harness-command, slash-command, `$skill` kickoff prompts, and automation-started `act` task launch prompts are hidden by the backend when written, and `Messages.tsx` only consumes that flag instead of parsing prompt text in the browser.
- Roomote runtime plan updates still drive the task todo list UI, and explicit `in_progress` transitions also insert a lightweight divider-style transcript row that shows the started todo text with a trailing rule so major plan steps remain visible in the chat history without looking like a full assistant bubble.
- `Narration Mode` now defaults on for users who do not yet have a saved personal preference. When it is enabled, transcript surfaces that route through `Messages.tsx` hide Roomote runtime tool and command rows, keep sleep/wake rows visible, and render reasoning inline with a static `Thought` label. Reasoning visibility is now aligned across both transcript modes: live and short-lived thoughts render immediately whether narration mode is on or off, while the toggle still controls whether reasoning uses the inline narrated shell or the default collapsible shell. If a task is still `running` but narration mode has no visible streaming assistant output yet, the transcript appends a delayed reasoning-style `Thinking...` row so long-running hidden tool or command work still reads as active. The same preference applies to live tasks, historical/resuming views, and environment-definition agent conversations.
- Internal-only sandbox controls can now opt into the same user preference by using Tailwind `debug:` utilities. The first shipped use is `SandboxLogsTerminal`, whose root message now applies `debug:hidden` so startup-only raw logs remain available for internal debugging without polluting the default user-facing startup UI.

Secure environment-variable requests:

- Web dashboard tasks can now request missing organization environment variables through the built-in Roomote MCP tool as soon as the agent knows they will be needed, instead of waiting for a failed command or asking users to paste secrets into chat.
- After the request tool result reaches task history, Roomote stops the live task through the same resumable sandbox path as the red stop button, so the agent does not keep running against missing secrets while the request is pending.
- The live task view now keeps a first-class pending env-var request state in the sandbox store, sourced from the worker/runtime's normalized `request_environment_variables` tool results in Roomote runtime envelopes, and renders a dedicated secure form panel above `PromptInput`, outside the conversation transcript, when a request is active. That keeps the setup UI independent of transcript rendering as long as the runtime persists the canonical `ToolResult` shape.
- For live tasks, the sandbox runtime serves that pending state from harness memory through `getRuntimeState()`. The normalized `request_environment_variables` `ToolResult` is the durable history/backfill path the client uses to reconstruct the same state.
- Submitted values go straight from the browser form to the encrypted `environment_variables` store; the task transcript only sees non-secret metadata and a canned retry prompt.
- Non-admin viewers see a read-only handoff state telling them that an organization admin must fulfill the request.
- After save, the dashboard attempts an in-place sandbox reload and then sends the canned retry prompt, which resumes the stopped task so subsequent shell/tool executions pick up the new values without recreating the task.
- In the prompt composer, clipboard pastes that contain only image files but also include tabular text are treated as a spreadsheet or table paste, not as an image-attachment paste. That lets users paste spreadsheet ranges into the task input without the attachment handler swallowing the clipboard.

Task-level quick actions:

- The wrench icon in the prompt composer opens the `Task Tools` menu.
- People may refer to this same UI as the `wrench menu`, `quick actions`, `quick action buttons`, or `task quick actions`.
- In the codebase and UI copy, the canonical name is `Task Tools`.
- Clicking a Task Tools button sends a structured `taskTool.actionId` payload into the running task; it does not open a separate page or dialog.
- The worker runtime maps each Task Tool action ID to the correct harness-specific packaged-skill invocation, so ordinary users do not need to know or choose `/` versus `$`.
- The current source of truth for those buttons is [`apps/web/src/app/(sandbox)/task/[taskId]/task-tools.ts`](../../apps/web/src/app/%28sandbox%29/task/[taskId]/task-tools.ts).

Current built-in Task Tools buttons:

- `Simplify changed code` -> `simplify`
- `Commit + push` -> `push`
- `Push to a draft PR` -> `create-draft-pr`
- `Push to a ready PR` -> `create-pr`
- `Review code` -> `review-code`
- `Review code and fix issues` -> `review-and-fix`
- `Address PR feedback` -> `address-pr-feedback`
- `Capture visual proof` -> `capture-visual-proof`

This is distinct from the `(cloud-actions)` route group above, which contains standalone flows such as `revert-commit`.

Sub-routes:

- **artifacts/**: File browser with syntax highlighting and image preview
- **diff/**: Git changes with side-by-side comparison
- **info/**: Task metadata and environment details
- **logs/**: Interactive side-panel log viewer with a log-file dropdown and filterable search UI
- **previews/[...segments]**: Embedded preview ports via iframe
- **terminal/**: Interactive side-panel terminal with support for multiple terminal sessions

## Design System

All UI components live in `apps/web/src/components/system` and are re-exported from a central index. The design system enforces consistent styling, accessibility, and dark mode support.

### Primitives (`components/system/primitives`)

Built on Radix UI with Tailwind styling. Most primitives include `.stories.tsx` files for Storybook.

| Component         | Base              | Purpose                                          |
| ----------------- | ----------------- | ------------------------------------------------ |
| **Button**        | `<button>`        | Primary, secondary, ghost, destructive variants  |
| **Input**         | `<input>`         | Text input with validation states                |
| **Select**        | Radix Select      | Dropdown with keyboard nav                       |
| **Dialog**        | Radix Dialog      | Modal with backdrop and close handling           |
| **Drawer**        | Vaul              | Mobile-friendly bottom sheet                     |
| **Dropdown Menu** | Radix Dropdown    | Context menus and action menus                   |
| **Tooltip**       | Radix Tooltip     | Hover-based help text                            |
| **Badge**         | `<span>`          | Status indicators with color variants            |
| **Card**          | `<div>`           | Content containers with header/footer            |
| **Table**         | `<table>`         | Data tables with sorting and filtering           |
| **Tabs**          | Radix Tabs        | Tabbed navigation                                |
| **Form**          | React Hook Form   | Form field wrappers with error states            |
| **Checkbox**      | Radix Checkbox    | Accessible checkboxes with indeterminate support |
| **Switch**        | Radix Switch      | Toggle switches                                  |
| **Skeleton**      | `<div>`           | Loading placeholders                             |
| **Spinner**       | `<svg>`           | Loading indicator                                |
| **Separator**     | Radix Separator   | Horizontal/vertical dividers                     |
| **ScrollArea**    | Radix Scroll Area | Custom scrollbars                                |
| **Popover**       | Radix Popover     | Floating content containers                      |
| **HoverCard**     | Radix Hover Card  | Rich hover previews                              |
| **Collapsible**   | Radix Collapsible | Expandable sections                              |
| **Command**       | cmdk              | Command palette (Cmd+K)                          |
| **Slider**        | Radix Slider      | Range inputs                                     |
| **RadioGroup**    | Radix Radio Group | Radio button sets                                |
| **Breadcrumb**    | `<nav>`           | Navigation breadcrumbs                           |
| **Alert**         | `<div>`           | Informational banners                            |
| **Sonner**        | Sonner            | Toast notifications                              |

### Custom Components (`components/system/custom`)

Domain-specific components built on primitives:

| Component             | Purpose                                     |
| --------------------- | ------------------------------------------- |
| **MultiSelect**       | Multi-select dropdown with search           |
| **SimpleMultiSelect** | Tag-based multi-select                      |
| **CursorPagination**  | Cursor-based pagination controls            |
| **AsciiSpinner**      | Terminal-style loading animation            |
| **ImagePreview**      | Image viewer with zoom and download         |
| **EmptyState**        | Placeholder for empty lists/views           |
| **ErrorState**        | Error display with retry actions            |
| **StateContainer**    | Conditional wrapper for loading/error/empty |

### Icons

All icons from `lucide-react` are re-exported through `components/system/primitives/icons.ts` to centralize imports:

```tsx
import { Circle, AlertTriangle, Check } from '@/components/system';
```

### Usage Guidelines

**Always use design system components instead of raw HTML:**

```tsx
// ✅ Correct
import { Button, Input, Dialog } from '@/components/system';

<Button variant="primary" onClick={handleClick}>
  Save Changes
</Button>

// ❌ Incorrect
<button onClick={handleClick}>Save Changes</button>
```

The system components handle:

- Dark mode with `next-themes`
- Accessibility (ARIA attributes, keyboard nav)
- Focus management
- Loading and disabled states
- Consistent spacing and typography

Use the design-system `Dialog` primitive for in-app confirmations and modal decision points, including settings deletion/removal/disconnect actions. Browser-native `alert`, `confirm`, and `prompt` dialogs should not be introduced in dashboard UI; prefer controlled React state so mutation pending states, cancel buttons, copy, focus management, and tests stay inside the app surface.

## State Management

### tRPC + React Query

The primary state management pattern. Server state is fetched via tRPC procedures and cached by React Query.

**Client-side hook pattern:**

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/trpc/client';

const trpc = useTRPC();
const queryClient = useQueryClient();

const tasksQuery = useQuery(
  trpc.tasks.list.queryOptions({
    limit: 20,
    filters: [],
  }),
);

const updateTaskTitle = useMutation(
  trpc.tasks.updateTitle.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: trpc.tasks.list.queryKey(),
      });
    },
  }),
);
```

**Server-side usage (Server Components):**

```tsx
import { createServerCaller } from '@/trpc/server';

const caller = await createServerCaller();
const task = await caller.tasks.byId({ taskId });
```

See [Web tRPC Router](../api/trpc-web.md) for full details on routers, commands, middleware, and the current `useTRPC()` + React Query pattern.

### Zustand Stores

Client-only state that doesn't need server sync:

| Store                      | Location                                                 | Purpose                                                              |
| -------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| **useLayoutStore**         | `hooks/useLayoutOptions.ts`                              | Header visibility/sticky state + persisted desktop SideNav expansion |
| **useSandboxStore**        | `app/(sandbox)/task/[taskId]/hooks/use-sandbox-store.ts` | Active tab, panel state, terminal settings                           |
| **useLogFiles**            | `app/(sandbox)/task/[taskId]/hooks/use-log-files.ts`     | Log file derivation + sandbox-store sync                             |
| **useLiveTaskStatusStore** | `hooks/tasks/useLiveTaskStatus.ts`                       | WebSocket-based task status updates                                  |

**Example: Layout options hook**

```tsx
import { useLayoutOptions } from '@/hooks/useLayoutOptions';

// In a page component:
useLayoutOptions({
  header: { visible: false, sticky: true },
});

// Layout automatically resets on unmount
```

The desktop `SideNav` keeps the narrow icon rail as its default/collapsed state. On `md` and larger screens, hovering the kangaroo logo reveals an open control; the expanded state widens the rail to show nav labels and recent task titles, and `useLayoutStore.isSideNavExpanded` persists that preference in `localStorage`. The bottom of the rail also includes a `Feature Request` action beside the user avatar that opens a prompt-submission dialog, captures the page URL from the moment the user opened it, and stores the submitted idea against the deployment and current user. Mobile navigation continues to use `NavbarHeader` and the existing drawer/sheet flows, with the same feature-request dialog reachable from the drawer footer.

### React Context

Used for providers that need to wrap the entire app or route group:

- **TRPCReactProvider**: tRPC client + React Query setup
- **ThemeProvider**: Dark mode state (next-themes)
- **Better AuthProvider**: Auth session management
- **UserAnalyticsContext**: Authenticated Sentry user context; Roomote does not initialize hosted third-party browser analytics, GTM, HubSpot, or cookie-consent tracking from the app shell.
- **TelemetryProvider**: Opt-out anonymous page-view tracking; dynamic-imports the tracker only when the deployment has anonymous analytics enabled (see [Anonymous Analytics & Version Checks](./anonymous-analytics.md)).
- **CommandPaletteProvider**: Command palette state (Cmd+K)

All providers are nested in `RootProviders` in the root layout.

## Component Organization

```
apps/web/src/components/
├── system/                   # Design system primitives + custom
│   ├── primitives/           # Radix UI wrappers
│   ├── custom/               # Domain components (multi-select, states)
│   └── index.ts              # Central export
│
├── layout/                   # App shell components
│   ├── side-nav/             # Desktop side navigation
│   ├── navbar/               # Mobile/navigation header components
│   ├── providers/            # Root providers + contexts
│   └── ...                   # Status banner, command palette, loading, etc.
│
├── sandbox/                  # Task execution UI
│   ├── TaskStatusIndicator.tsx
│   ├── TerminalOutput.tsx
│   └── FileBrowser.tsx
│
├── tasks/                    # Task-related components
│   ├── TaskCard.tsx
│   ├── TaskFilters.tsx
│   └── TaskActions.tsx
│
├── ai-elements/              # AI-specific UI (message bubbles, tool calls)
│   ├── message.tsx
│   ├── tool-result.tsx
│   └── thinking-indicator.tsx
│
└── settings/                 # Settings pages
    ├── IntegrationCard.tsx
    ├── EnvironmentSettings.tsx
    └── ModelRoutingConfig.tsx
```

## Styling

### Viewport Height Contract

Dashboard layouts should use the shared viewport utilities and variables from [`apps/web/src/app/globals.css`](../../apps/web/src/app/globals.css) instead of raw `100vh` math. Use `.h-viewport` and `.min-h-viewport` for outer shells, and use `.h-effective-viewport`, `.min-h-effective-viewport`, `.h-below-header`, or `calc(var(--effective-viewport-height) - ...)` for fixed-height content below the header, scroll panels, dialogs, and centered states so individual routes do not need to reimplement viewport math.

### Tailwind Configuration

The app uses Tailwind CSS v4 with tokens defined directly in `app/globals.css` via `@theme inline` and CSS variables (rather than a checked-in `tailwind.config.ts` file in `apps/web`).

### Fonts

- **Inter**: Sans-serif for body text (`--font-sans`)
- **Noto Sans Mono**: Monospace for code and terminal (`--font-mono`)

Loaded via `next/font/google` in the root layout to optimize FOUT and font subsetting.

### Utility Libraries

- **`tailwind-merge`**: Merge Tailwind classes without conflicts
- **`class-variance-authority`**: Type-safe variant APIs for components
- **`clsx`**: Conditional class concatenation

**Example: Button with variants**

```tsx
import { cva } from 'class-variance-authority';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md font-medium transition-colors',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-10 px-4 text-sm',
        lg: 'h-12 px-6 text-base',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);
```

## Storybook

Component development environment at `pnpm --filter @roomote/web storybook`.

### Configuration

Located in `apps/web/.storybook/`:

- **main.ts**: Vite-based setup with Next.js integration
- **preview.ts**: Global decorators (theme toggle and Storybook runtime params)

Key features:

- **Legacy `'use server'` Mocking**: Vite plugin can stub `'use server'` modules in Storybook so Node.js dependencies (database, Redis, etc.) never end up in the browser bundle
- **Addon Integration**: a11y, themes, docs, vitest
- **Chromatic**: Visual regression testing

### Writing Stories

```tsx
import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './button';

const meta: Meta<typeof Button> = {
  title: 'Primitives/Button',
  component: Button,
  tags: ['autodocs'],
  argTypes: {
    variant: { control: 'select', options: ['primary', 'secondary', 'ghost'] },
  },
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Primary: Story = {
  args: { variant: 'primary', children: 'Click me' },
};
```

Most primitives in `components/system/primitives` have accompanying `.stories.tsx` files.

## Data Fetching Patterns

### Server Components

`apps/web` now includes `createServerCaller()` in `trpc/server.ts` for route handlers and selected server components that should share the web-router contract. Server components still commonly use direct server utilities for lower-level reads and then render client components that use `useTRPC()` + React Query.

### Client Components (Interactive)

Use tRPC hooks for reactive queries:

```tsx
'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/trpc/client';

export function TaskList() {
  const trpc = useTRPC();
  const { data, isLoading, error } = useQuery(
    trpc.tasks.list.queryOptions({
      limit: 20,
      filters: [],
    }),
  );

  if (isLoading) return <Skeleton />;
  if (error) return <ErrorState error={error.message} />;

  return (
    <div>
      {data.map((task) => (
        <TaskCard key={task.id} task={task} />
      ))}
    </div>
  );
}
```

### Real-time Updates

For live data, use polling or WebSocket-based queries:

```tsx
const taskQuery = useQuery(
  trpc.tasks.byId.queryOptions(
    { taskId },
    {
      refetchInterval: (query) =>
        query.state.data?.currentCloudJob?.status === 'running' ? 2000 : false,
    },
  ),
);
```

The sandbox view uses WebSockets directly via `SandboxProvider` for sub-second updates.

### User Display Names

When web UI surfaces need to show a user name, they should use the shared Better Auth fallback order rather than reading `fullName` directly. The fallback is full name, username, email local-part, then `Unknown`. Stored database users are normalized on Better Auth sync and webhook writes, but read/render paths that receive a stored `users.name` plus `users.email` should still call `getUserDisplayName` so older email/password users with blank names display consistently in task cards, filters, analytics labels, and task metadata.

## Testing

### Unit Tests

Vitest with two environments (see `vitest.config.ts`):

- **server**: Node.js env for `*.test.ts` (database tests, command tests)
- **client**: jsdom env for `*.client.test.ts` (hooks, components)

**Example: Component test**

```tsx
// SideNav.client.test.tsx
import { render, screen } from '@testing-library/react';
import { SideNav } from './SideNav';

vi.mock('@/hooks/useUser', () => ({
  useUser: () => ({ user: { id: '1', email: 'test@example.com' } }),
}));

it('renders navigation links', () => {
  render(<SideNav />);
  expect(screen.getByText('Tasks')).toBeInTheDocument();
  expect(screen.getByText('Settings')).toBeInTheDocument();
});
```

### Storybook Vitest Integration

Component behavior can also be exercised in Storybook alongside the package's normal Vitest coverage when interactive verification is useful.

### Test Database

Server tests use a real PostgreSQL test database configured via `.env.test`. Global setup truncates tables before each test run. See [Testing](../operations/testing.md) for full testing patterns.

## Authentication & Authorization

### Better Auth Integration

Better Auth provides:

- **Sign-in flow**: The managed component at `(unauthenticated)/sign-in` starts Slack or Microsoft Teams auth. Provider availability is resolved from both runtime env vars and saved deployment env vars so the auth credentials entered during `/setup` immediately make the provider available without requiring every auth env var up front. Better Auth creates new allowed users automatically during provider sign-in, so Roomote does not keep a separate public sign-up or early-access route.
- **Session management**: `useUser()` hook wraps Better Auth's `useUser()` with deployment context
- **Route/layout gating**: Route-group layouts and server auth utilities redirect unauthenticated users

**Protected routes:**

All routes in `(authenticated)` require sign-in. The layout redirects signed-out sessions to `/sign-in` after Better Auth finishes loading, so Better Auth-backed sessions do not bounce between the app shell and sign-in.

**Admin checks:**

Admin-only mutations and commands enforce `auth.isAdmin` server-side. Roomote currently has one deployment-level operator role rather than a separate organization-admin route group.

### Setup & Onboarding

New users are redirected through a two-step flow:

1. **Setup** (`/setup`): Admin-first setup flow that configures a communication provider, model provider, source-control provider, first repository set, and environment setup, then keeps `/setup` as the status plus secure-follow-up console until the first environment exists
2. **Onboarding** (`/onboarding`): Member onboarding flow for integrations and first actions

Signed-out visits to `/onboarding` are sent to `/sign-in`; onboarding no longer routes unauthenticated users through the public sign-up page.

The `(authenticated)` layout checks `setupStatus` and `onboardingStatus` and redirects if incomplete. A connected source-control provider and at least one environment are required before operators can continue into the app, even when `setupCompletedAt` was never written.

### `/setup` Admin Flow

The app now ships a single admin setup route at **`/setup`**. The older project-wizard implementation and the separate `/setup-new` route were removed, so incomplete admins and manual replays both use the same task-driven flow.

`/setup` now acts as the durable operator setup console while the configured communication provider drives the main setup conversation. The route persists a single selected repository set in deployment state, opens a provider conversation with the installing operator, starts a real setup task from the existing `$environment-setup` kickoff prompt, and then keeps the operator on `/setup` for setup status, secure follow-up, and recovery until the first environment exists.

The setup sequence now starts with deferred communication-provider configuration before model setup:

1. `Welcome`
2. `Choose communication provider`
3. `Configure provider`
4. `Configure model`
5. Source-control provider choice and configuration
6. Source-control connection, repository selection, and environment setup

The provider-setup portion intentionally mirrors the deferred model-provider step on the same route:

- admins choose one communication provider first from Slack, Microsoft Teams, or Telegram
- `/setup` asks for the provider fields Roomote needs for that provider's current capabilities, not just browser sign-in
- runtime env vars that fully configure a communication or source-control provider lock that category to the prioritized provider and hide the chooser/configuration screens; the setup status exposes `runtimeConfiguredProvider`, `runtimeConfiguredProviders`, and `lockReason: "runtime_env"` so UI code does not infer locking from selected-provider fields
- saved encrypted deployment env vars can preselect a provider and satisfy its fields, but they do not lock the category or hide other provider choices unless the operator has explicitly saved a setup-state provider choice
- fields already satisfied by runtime env vars stay disabled
- fields already satisfied by saved deployment env vars stay masked until replaced
- the model step's OpenRouter choice also offers a `Connect with OpenRouter` button that runs OpenRouter's PKCE OAuth flow: `/api/openrouter-oauth/initiate` stores a one-time verifier in a short-lived HTTP-only cookie and redirects to `openrouter.ai/auth`, then `/api/openrouter-oauth/callback` exchanges the returned code for a user-controlled API key and saves it through the same encrypted `OPENROUTER_API_KEY` deployment env-var path as a pasted key before redirecting back to `/setup?step=env-vars` with a success or error toast
- Slack setup now includes `SLACK_SIGNING_SECRET` in addition to the shared `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET`; `SLACK_APP_ID` is optional, and `SLACK_REDIRECT_URI` is inferred from `ROOMOTE_APP_URL` when omitted
- the communication connect step is provider-aware for Slack and Microsoft Teams: runtime-configured Slack shows the Slack app-install CTA, while runtime-configured Teams reads `teams.integrationStatus` and either opens the Teams bot URL or shows a blocked state when the bot app ID is missing; the communication provider chooser and both connect variants also expose a subtle `Do this later` link that records a `communicationStep: 'skipped'` marker in the localStorage setup session (`setup-session.ts`) so communication setup stays skipped for the rest of the browser session instead of bouncing back on the next status refresh
- source-control connect routes runtime-configured GitHub to the GitHub App installation flow and runtime-configured GitLab, Gitea, or Azure DevOps to token-backed repository sync
- If the visitor is still signed out, `/setup` now exposes only this bootstrap provider-configuration segment first. After those values are saved, the route starts the selected provider sign-in directly from the page, then resumes the signed-in setup flow on the same `/setup` URL.
- When the deployment sets `SETUP_TOKEN` (the one-command installer always generates one), the signed-out bootstrap segment is token-gated: `setupBootstrap.status` returns a redacted payload and the bootstrap save mutations reject until the visitor presents the token, either via the `?token=` query param in the installer's printed setup link or through the dedicated token entry step (`StepSetupToken`). The check lives in `apps/web/src/lib/server/setup-token.ts`; deployments without `SETUP_TOKEN` behave exactly as before.

For the exact proactive Slack message timeline that this flow can emit, including setup updates and starter-task suggestions, see [Slack Onboarding Timeline](./slack-onboarding.md).

Key behaviors:

- The happy path is now `Welcome` -> communication provider setup -> model setup -> source-control provider setup -> repository selection -> `Environment setup` -> `Linear` -> `Invoke`.
- The signed-in setup flow keeps the active step in the URL as the canonical `/setup?step=<step-id>` query shape (built by `getSetupStepPath` in `apps/web/src/app/(onboarding)/setup/types.ts`), and that query string is the source of truth for navigation. `useSetupFlow` reads `step` from the URL on load, uses `router.push` for user-driven step changes (`goToStep`, `goToNextStep`, post-onboarding advances) so deliberate navigation and OAuth/callback returns get history entries, and uses `router.replace` for automatic corrections when a requested step is invalid, gated by an earlier required step, or auto-skipped by the state watchdog. Browser back/forward is honored by reacting to `popstate` and re-resolving the URL step against the same skip/gating rules. The step ID is preserved in the URL after initialization; only the transient callback params (`slack`, `openrouter`, `reason`) are consumed and stripped. Revisitable config steps (`auth-env-vars`, `env-vars`, `compute-provider`, `compute-config`, `source-control-config`) stay visible when deep-linked even if their saved values already satisfy the flow, and the signed-out bootstrap `?token=` path is unaffected.
- `setupNew.status` qualifies the current operator before the rest of the funnel continues. It requires an active GitHub organization installation for the deployment based on the persisted GitHub installation `accountType`; the work-email check has been removed.
- Qualification failures are persisted per user in `setup_qualification_blocks`, so the same state can gate `/setup` and be lifted manually for a specific user.
- When setup is blocked, `/setup` routes to a friendly qualification step instead of throwing an error. That step explains why access is still limited, tells the user they will be emailed when broader access opens up, reminds them to use the support chat in the bottom right if Roomote got it wrong, and offers a recovery action (`Use another GitHub account` restarts the GitHub install flow).
- A connected source-control provider and communication provider are both required before repo selection. Those steps are skipped automatically when the integration is already connected, and both the communication provider chooser and the communication connect step can also be skipped manually via their `Do this later` links.
- After repo selection, `setupNew.startOnboardingTask` opens or reuses the configured provider's conversation with the mapped installer account, posts the kickoff message there, and enqueues a real provider-backed onboarding task instead of a web `StandardTask`. When the deployment has no active Slack installation or the admin has no linked Slack account (for example after skipping communication setup), the command falls back to the Telegram primary chat and then the primary Teams conversation, posting the same kickoff and enqueueing a `StandardTask` that carries provider-neutral communication metadata; the persisted setup state records the destination in the `chatHandoff*` fields while the legacy `slackTeamId`/`slackChannel`/`slackThreadTs` fields stay null. Only when no chat surface exists at all does the kickoff run as a web-only `StandardTask` with every handoff field null.
- The dedicated onboarding step is now a companion console rather than the primary transcript surface. It shows the chat handoff state (naming Slack, Telegram, or Microsoft Teams as the destination), task status, selected repos, and the existing secure task panel below that summary. For web-only onboarding tasks (no chat handoff metadata), the console copy points at the in-page task panel instead of a chat surface.
- Once the first environment is ready, `/setup` resumes the remaining in-product onboarding checklist instead of ending immediately. Suggested starter tasks are handled through Slack, and the web flow continues directly to the final invoke step.
- If Slack handoff fails, `/setup` stays recoverable: the admin can retry the handoff or clear the current repo selection and start over without leaving the page.
- If the remote onboarding task later fails or completes without creating a matching environment, `/setup` routes the admin back to `Environment setup`, keeps the previous repo selection and setup guidance filled in, and shows a retry banner explaining why setup needs another pass.
- Setup launches the same hidden Suggested Tasks task over the selected repositories, and starter-task interaction now happens in Slack: the setup DM gets a new parent message plus one threaded `Suggestion N` reply per suggestion, with optional priority and category emoji badges on the title, and `:thumbsup:` reactions on those replies enqueue and launch follow-up tasks.
- Setup no longer blocks on a separate in-product Starter tasks step; after onboarding is unlocked, the flow continues directly to Linear and Invoke while Slack handles suggestion selection.
- Admins who already completed setup can still manually revisit `/setup` and replay the flow.
- Repository selection is a plain checkbox list for one initial setup target made from one or more repos.
- The selected repo set, onboarding task pointer, and Slack DM metadata (`slackChannel`, `slackThreadTs`) are persisted on the organization (`organizations.setup_state`) so the route can resume after refreshes or OAuth returns.
- The first setup run can also persist a one-time Suggested Tasks pointer in `organizations.setup_state` so setup can distinguish `pending`, `empty`, and `ready` suggestion states without launching duplicate suggestion jobs on setup replays.
- The onboarding task uses a normal single-repo workspace for one selected repo, or a scoped multi-repo workspace for several selected repos, so the worker only checks out the repos the admin chose.
- Setup launches a one-time hidden Suggested Tasks task over that same selected repository set. The task inspects the repos, looks for no-brainer bugs, typos, TODOs, and similarly obvious wins, and submits up to five small first-task briefs through the dedicated `submit_task_suggestions` MCP submission tool instead of relying on transcript scraping.
- The onboarding chat hides the raw `$environment-setup` kickoff prompt because the setup session marks that bootstrap prompt as not visible in the transcript when it is created; the dashboard only renders the remaining agent transcript.
- Slack-started setup tasks can now request secure organization environment variables through the same Roomote MCP request flow as web-started tasks. The agent can still explain which keys are needed in Slack, and when that structured request succeeds, Roomote auto-posts the secure `/setup` link handoff so the actual secret entry still happens in the `/setup` secure web panel rather than in Slack.
- The same `/setup` panel now owns deferred communication-provider configuration, so minimum bootstrap env requirements are lower than before. Before `setupCompletedAt` exists, `/setup` is also the public bootstrap entrypoint for first-time operators. Once the first provider is configured and the operator signs in, the chosen provider defines the deployment's future sign-in path.
- The same environment-definition agent transcript surface is also reused in the Environments settings flows: creating an environment now defaults to the agent path with YAML as an escape hatch, while editing an environment still defaults to YAML but can also launch the agent to revise the existing definition.
- The global authenticated-layout guard still forces admins back to `/setup` until a source-control provider is connected and the first environment exists, so the async change only removes dead time inside `/setup`.
- Setup is still only marked complete when the reused `How to work with your agents` step finishes and redirects to Home.

Primary implementation files:

- `apps/web/src/app/(onboarding)/setup/page.tsx`
- `apps/web/src/app/(onboarding)/setup/hooks.ts`
- `apps/web/src/app/(onboarding)/setup/StepSlack.tsx`
- `apps/web/src/app/(onboarding)/setup/StepRepoSelection.tsx`
- `apps/web/src/app/(onboarding)/setup/StepOnboardingAgent.tsx`
- `apps/web/src/app/(onboarding)/setup/SetupOnboardingTaskQueue.tsx`
- `apps/web/src/components/settings/environments/EnvironmentDefinitionAgentTask.tsx`
- `apps/web/src/components/settings/environments/CreateEnvironmentPage.tsx`
- `apps/web/src/components/settings/environments/EditEnvironmentPage.tsx`
- `apps/web/src/trpc/commands/setup-new/index.ts`

## Performance Optimizations

### Code Splitting

- **Route-based splitting**: Next.js automatically code-splits by route
- **Dynamic imports**: Heavy components (terminal, diff viewer) use `next/dynamic`

```tsx
const Terminal = dynamic(() => import('./Terminal'), { ssr: false });
```

### Image Optimization

- **next/image**: Automatic resizing and WebP conversion
- **Placeholder blur**: Low-quality image placeholders for above-the-fold images

### React Query Caching

- **Stale time**: Long stale times (30s+) for static data (environments, agents)
- **Refetch intervals**: Conditional polling for running tasks
- **Invalidation**: Mutations invalidate related queries to keep UI in sync

### Memoization

- **React.memo**: Wrap expensive components to prevent re-renders
- **useMemo/useCallback**: Memoize computed values and callbacks in hot paths

Example from sandbox:

```tsx
export const MemoizedLiveContent = React.memo(LiveContent);
```

## Environment Variables

All env vars are validated via `@roomote/env` (Zod schemas). Always import `Env` instead of accessing `process.env` directly:

```tsx
import { Env } from '@roomote/env';

const githubAppSlug = Env.NEXT_PUBLIC_GITHUB_APP_SLUG;
```

**Public vars** (prefixed with `NEXT_PUBLIC_`) are bundled into the client. Server-only vars are only accessible in Server Components and route handlers.

See `apps/web/.env` and root `.env.*` files referenced by web scripts for local configuration.

## Key Files Reference

| File                                  | Purpose                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `app/layout.tsx`                      | Root layout (fonts, providers, metadata)                                              |
| `app/(authenticated)/layout.tsx`      | Main dashboard layout (SideNav, auth checks)                                          |
| `app/(sandbox)/layout.tsx`            | Sandbox shell (minimal chrome for task execution)                                     |
| `components/system/index.ts`          | Central export for design system components                                           |
| `components/layout/RootProviders.tsx` | Nested context providers (tRPC, Better Auth, theme, analytics)                        |
| `trpc/client.tsx`                     | tRPC React hooks (`useTRPC`, `TRPCReactProvider`)                                     |
| `trpc/routers/_app.ts`                | Web-specific tRPC router (all sub-routers)                                            |
| `app/api/trpc/[trpc]/route.ts`        | Next.js route handler exposing the web tRPC router                                    |
| `app/(onboarding)/setup/page.tsx`     | Admin-only `/setup` onboarding route                                                  |
| `trpc/commands/setup-new/index.ts`    | `setupNew` command surface backing the persisted `/setup` state                       |
| `hooks/useLayoutOptions.ts`           | Layout state (header visibility/sticky options + persisted desktop SideNav expansion) |
| `hooks/useUser.ts`                    | Wrapped Better Auth user hook with deployment context                                 |
| `lib/server/`                         | Server-side utilities (S3, artifact handling)                                         |
| `app/globals.css`                     | Tailwind v4 theme tokens, CSS variables, and global styles                            |
| `vitest.config.ts`                    | Test setup (server + client environments)                                             |
| `.storybook/main.ts`                  | Storybook configuration                                                               |

## Development Workflow

### Running Locally

```bash
# Start all services (requires Docker with Compose, ngrok)
pnpm dev

# Run just the web app
pnpm --filter @roomote/web dev

# Open Storybook
pnpm --filter @roomote/web storybook
```

### Adding a New Page

1. Create page component in appropriate route group:

   ```tsx
   // apps/web/src/app/(authenticated)/my-page/page.tsx
   export default function MyPage() {
     return <div>My Page</div>;
   }
   ```

2. Add navigation link in `SideNav` or `NavbarHeader` if needed

3. Add tRPC queries/mutations in `trpc/routers/_app.ts`

4. Update tests and Storybook stories

### Adding a New Component

1. **Primitive**: Add to `components/system/primitives/` with Radix UI base
2. **Custom**: Add to `components/system/custom/` for domain-specific logic
3. Write `.stories.tsx` for Storybook
4. Write `.client.test.tsx` for unit tests
5. Export from `components/system/index.ts`

### Code Formatting

Run `pnpm format` before committing to auto-fix Prettier violations. Pre-commit hooks enforce lint, and pre-push hooks enforce lint, type checks, and knip.

## Common Patterns

### Loading States

Use `StateContainer` for consistent empty/loading/error states:

```tsx
import { StateContainer } from '@/components/system';

<StateContainer
  isLoading={isLoading}
  isEmpty={data.length === 0}
  error={error?.message}
  emptyState={<EmptyState description="No tasks found" />}
>
  <TaskList tasks={data} />
</StateContainer>;
```

### Form Handling

React Hook Form with Zod validation:

```tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

const schema = z.object({
  name: z.string().min(1, 'Name is required'),
});

const form = useForm({
  resolver: zodResolver(schema),
  defaultValues: { name: '' },
});

const onSubmit = form.handleSubmit((data) => {
  updateTask.mutate(data);
});
```

### Toast Notifications

Use `sonner` for success/error messages:

```tsx
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

const deleteTask = useMutation(
  trpc.tasks.delete.mutationOptions({
    onSuccess: () => {
      toast.success('Task deleted');
    },
    onError: (error) => {
      toast.error(`Failed to delete task: ${error.message}`);
    },
  }),
);
```

### Responsive Design

Mobile-first with Tailwind breakpoints:

```tsx
<div className="flex flex-col md:flex-row gap-4">
  <div className="w-full md:w-1/2">Column 1</div>
  <div className="w-full md:w-1/2">Column 2</div>
</div>
```

## Related Documentation

- [Web tRPC Router](../api/trpc-web.md) — tRPC routers, commands, middleware
- [Testing](../operations/testing.md) — Test patterns and database factories
- [Deployment](../operations/deployment.md) — Build and deployment process
- [Monorepo Setup](../architecture/monorepo-structure.md) — Workspace structure and tooling
