---
title: Microsoft Teams Integration
status: active
last_reviewed: 2026-07-08
owner: engineering
summary: Teams bot task entry, app/bot setup, Entra account linking, reply flow, and parity notes.
---

# Microsoft Teams Integration

Teams is a task entry surface backed by a Bot Framework bot plus a Microsoft
Entra sign-in app. Unlike Telegram there is no launch-owner fallback:
inbound senders must be linked to a Roomote account (via Entra sign-in)
before they can start tasks, and the webhook drives that linking flow
itself.

## Configuration

Two Entra app registrations are involved:

| Env var                                              | Purpose                                                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `TEAMS_BOT_APP_ID`                                   | Bot app registration (client) ID. Audience for webhook JWT verification.                                                      |
| `TEAMS_BOT_APP_PASSWORD`                             | Bot app client secret, used for Bot Framework token exchange (outbound).                                                      |
| `TEAMS_BOT_TENANT_ID`                                | Optional; switches token exchange to the tenant-specific endpoint (single-tenant bots).                                       |
| `TEAMS_BOT_TOKEN_ENDPOINT` / `TEAMS_BOT_OAUTH_SCOPE` | Optional overrides; default to Microsoft login and `.botframework.com/.default`.                                              |
| `ROOMOTE_AUTH_MICROSOFT_CLIENT_ID`                   | Entra sign-in app for user auth + account linking (all three required together).                                              |
| `ROOMOTE_AUTH_MICROSOFT_CLIENT_SECRET`               | Sign-in app secret.                                                                                                           |
| `ROOMOTE_AUTH_MICROSOFT_TENANT_ID`                   | Sign-in app tenant. Registers the `microsoft-entra-id` provider (scopes include `offline_access` for delegated Graph tokens). |

Bot credentials resolve through `resolveTeamsBotRuntimeCredentials`
(`packages/db/src/lib/teams-runtime-credentials.ts`): per variable, process
env wins and settings-UI-saved deployment env vars fill gaps; when no
complete `TEAMS_BOT_APP_ID`/`TEAMS_BOT_APP_PASSWORD` pair is configured, the
Microsoft sign-in app doubles as the bot app (id/secret/tenant taken as a
unit — sources are never mixed). Values are cached ~30s and invalidated when
the comms settings save or clear the `microsoft` provider. Server-side
callers build providers via
`createTeamsCommunicationProviderFromRuntimeCredentials` (`packages/sdk`).

### Setup runbook (single Entra app)

1. **Entra app**: register one Entra app, add a Web redirect URI
   `<ROOMOTE_APP_URL>/api/auth/oauth2/callback/microsoft-entra-id`, create a
   client secret, and save client/tenant IDs plus the secret in the comms
   settings card (or the `ROOMOTE_AUTH_MICROSOFT_*` env vars). The same app
   serves user sign-in and the bot; in the setup wizard, Roomote requires this
   single-app path and stores hidden `TEAMS_BOT_APP_ID`,
   `TEAMS_BOT_APP_PASSWORD`, and `TEAMS_BOT_TENANT_ID` values copied from the
   Microsoft Client ID/secret/tenant. Dedicated `TEAMS_BOT_*` env vars and the
   optional `TEAMS_BOT_TOKEN_ENDPOINT` / `TEAMS_BOT_OAUTH_SCOPE` overrides are
   still available from Settings or environment variables for deployments that
   intentionally diverge after setup.
2. **Microsoft values**: paste the Client ID, client secret, and Tenant ID in
   setup. Roomote stores these for Microsoft sign-in and copies them into the
   hidden setup-only bot fields for the single-app path.
3. **Teams app package**: download the generated app package (manifest + icons zip,
   bot id and deployment URLs pre-filled, built by
   `apps/web/src/lib/server/teams-app-package.ts`) and upload it in Teams
   (Apps → Manage your apps → Upload an app) or import it in the Developer
   Portal. Two routes serve it: `GET /api/teams/app-package` (authed; resolves
   the stored bot credentials, linked from the comms settings card and the
   setup communication-connect step) and
   `GET /api/setup/teams-app-package?botAppId=<guid>` (unauthenticated;
   builds from the caller-supplied GUID so the setup env-vars step can offer
   the download before credentials are saved, including bootstrap mode). The
   manifest declares Teams RSC application permissions
   `ChannelMessage.Read.Group` and `ChatMessage.Read.Chat` under
   `authorization.permissions.resourceSpecific`, plus `webApplicationInfo`, so
   a consented team/chat installation can deliver unmentioned channel and chat
   messages to the bot. Existing Teams installations need an app package
   upgrade or reinstall before Teams grants those new permissions.
4. **Bot capability**: in the Teams Developer Portal, open the imported
   Roomote app and add a bot capability that uses the same Microsoft Client ID
   as the bot app ID. Set the bot messaging endpoint to
   `<ROOMOTE_APP_URL>/api/webhooks/teams`.
5. For Graph-backed history reads, the sign-in app needs delegated
   `ChannelMessage.Read.All` and `Chat.Read` permissions (admin consent).

## Inbound Flow

`POST /api/webhooks/teams` (`apps/api/src/handlers/teams/index.ts`):

1. Verify the Bot Framework JWT (`bot-framework-auth.ts`): issuer
   `api.botframework.com`, audience `TEAMS_BOT_APP_ID`, serviceUrl claim
   match, JWKS cached ~5 minutes.
2. Deduplicate by activity ID in Redis; upsert `teams_installations`
   (per-team and per-tenant rows with the service URL).
3. Resolve the sender: `teams_user_mappings` first, else an indexed
   `microsoft_auth_user_mappings` / Better Auth account lookup by tenant +
   AAD object id (auto-seeding the Teams mapping when found).
4. **Unlinked senders** get the account-linking flow instead of a task: the
   original activity is stored in Redis (`teams:auth:<token>`, 15-minute
   TTL) and the bot DMs a link to `/api/teams/auth?state=<token>` (falling
   back to a thread reply when the DM cannot be created).
5. Linked senders: follow-ups queue to the active job for the conversation;
   otherwise task-entry signals (personal message, channel/group message
   mentioning the bot, or a consented RSC-delivered channel/chat message)
   route via the LLM router — inline `platform_answer` or a standard task
   launch — with snapshot resume support. Without the RSC grant, Teams only
   delivers channel/group-chat messages that directly mention the bot.
   Unmentioned channel-thread replies in Roomote-owned threads mirror the
   Slack no-mention window
   (`apps/api/src/handlers/teams/unmentioned-thread-reply.ts`): replying to
   the bot needs no @-mention unless somebody else posted or was mentioned
   since the bot's last message, the sender must already be in conversation
   with the bot (thread task owner, thread root author, or an earlier bot
   mention in the thread), and the decision is computed from delegated Graph
   thread history on each webhook (no stored thread state; unavailable
   history falls back to requiring a mention). This applies to channel
   threads only — group chats have no reply threading, so they keep the
   explicit-mention requirement. Prompt-safe
   image attachments are downloaded with Bot Framework credentials and
   converted to data URLs before the message is queued or the task is
   launched, so Teams screenshots reach the task as prompt images instead of
   raw authenticated attachment URLs. The Bot Framework bearer token is only
   sent to trusted hosts (the activity `serviceUrl` host and the Bot
   Framework connector/traffic-manager suffixes); attachment URLs on other
   hosts are downloaded without the `Authorization` header so a crafted
   attachment cannot exfiltrate the bot token. Downloads are capped per image
   (10 MB), per task (10 images), and in aggregate (25 MB) to bound memory
   and prompt size.

### Account linking flow

`GET /api/teams/auth?state=…` (`apps/web/src/app/api/teams/auth/route.ts`):

- No session → start Entra **sign-in** via Better Auth; signed in but Teams
  identity unlinked (resume returns 409 `account_link_required`) → start
  Entra **link**. Both re-enter the route with the state token afterwards
  and `POST /api/webhooks/teams/auth/resume` replays the original activity.
- The server-side Better Auth calls must carry an `Origin` header (Better
  Auth rejects them with `MISSING_OR_NULL_ORIGIN` otherwise) — see
  `startMicrosoftOAuth`.
- Behind TLS-terminating proxies/tunnels the Next server can report
  `x-forwarded-proto: http`, which used to downgrade OAuth redirect URIs to
  http:// and fail token exchange (Entra `AADSTS500112`).
  `withCanonicalForwardedProto` (`apps/web/src/lib/server/canonical-forwarded-proto.ts`)
  pins the scheme to the configured `ROOMOTE_APP_URL` for canonical-host
  requests inside `handleAuthRequest`.

## Outbound Flow

- `TeamsCommunicationProvider` (`packages/communication/src/teams-provider.ts`)
  posts via the Bot Framework REST API (client-credentials token exchange in
  `teams-bot-framework-client.ts`): markdown messages, thread replies,
  image attachments from signed Roomote artifact URLs, direct messages
  (creates DM conversations), message edits, and emoji-only reaction fallback
  messages. Bot Framework has no native outbound reaction API, so reactions
  appear as bot messages whose body is only the mapped emoji.
- Worker `send_chat_reply` dispatches by the job's communication provider
  through `POST /api/mcp/slack/thread_reply`, same as Telegram.
- Channel/thread history reads use Microsoft Graph with a **delegated**
  token minted from the linked user's stored Entra refresh token
  (`teams-graph-client.ts`; rotation-safe) — no app-only Graph permissions
  required.

## Slack/Telegram Parity Notes

Supported: task entry (DM + mention, plus unmentioned team/chat messages after
RSC consent), unmentioned thread replies to the bot in Roomote-owned channel
threads (Slack-parity no-mention window computed from Graph history),
follow-ups to active jobs, snapshot resume, account linking with
activity resume, image attachment/screenshot ingestion, outbound image
attachments from `send_chat_reply`, message edits, emoji-only reaction fallback
messages, Graph history reads, per-user attribution.

## Automations

Teams is the last automation fallback (Slack > Telegram > Teams, so output
never splits across surfaces). When the deployment has no active Slack
installation and no Telegram destination, scheduled-automation run
summaries post as one markdown message to the primary Teams conversation —
the most recently active installation, preferring team (channel) scopes
(`findTeamsPrimaryConversation` in
`apps/api/src/handlers/teams/automation-messaging.ts`,
`postScheduledSuggestionsToTeams` in `automation-suggestions.ts`). Teams
has no inline start buttons yet, so suggestions link to the automations
page. Act-disposition work items launch execution tasks with
`communicationProvider: 'teams'` (+ conversation id and service URL) so
closeouts land back in the conversation, and launch failures post there
too (`automation-work-items/teams.ts`).

## Onboarding

Deployments without a Slack or Telegram destination get the setup kickoff
message in the primary Teams conversation (the `/setup` onboarding task then
carries Teams communication metadata so agent progress replies thread under
the kickoff), the starter-suggestions intro in the same conversation
(`setup-suggestions.ts`; one markdown message, up to five ideas, reply-based
start since there are no inline buttons yet), and about 24 hours later a
delayed BullMQ job (`teams-suggested-tasks-onboarding-followup`) replies to
the intro with an Automations link unless the suggester is already enabled.
See `slack-onboarding.md` for the timeline contract.

Teams tasks run the same turn-satisfaction machinery as Slack/Telegram
(ack/closeout enforcement; enabled in `mcp-task-env.ts` and the worker
turn-start recorders), including current-turn emoji reactions on follow-up
turns. `send_chat_reaction_emoji` posts a Teams message containing only the
emoji and reports the targeted user activity id back to the worker so the turn
is considered satisfied. Initial task-entry turns still require a real reply,
not just an emoji.
Reply footers work (posted with the reply and refreshed via message edits).

Not supported yet: inline start buttons on automation summaries and the
onboarding intro (needs Adaptive Card action handling in the webhook),
messaging-endpoint auto-registration (the endpoint is set on the bot
resource by hand).
