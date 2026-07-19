# Roomote Communication Channels: Slack Feature Inventory + Compatibility Matrix

Audited 2026-07-19 from the `develop` branch by four parallel code readers (one per channel). Slack is the baseline column since it is the most feature-complete surface.

Legend: ✅ full parity · ⚠️ partial or different mechanism · ❌ absent · n/a platform cannot support it

---

## 1. Setup & installation

| Feature (Slack baseline) | Slack | Discord | Teams | Telegram |
|---|---|---|---|---|
| Guided in-app setup UI (onboarding step + settings card) | ✅ OAuth v2 install | ✅ bot token + invite URL | ✅ app-package download | ✅ bot token + auto webhook |
| Automatic app creation | ✅ `apps.manifest.create` fast path | ❌ manual bot creation in dev portal | ⚠️ auto-generated manifest zip (`teams-app-package.ts`), bot registration still manual | ❌ manual BotFather |
| Credential storage (env wins, encrypted vault fills gaps, cached) | ✅ | ✅ + identity cache by token fingerprint | ✅ + Microsoft sign-in app can double as bot app | ✅ + bot-username cache |
| Connection health diagnostics | ✅ installation status | ✅ gateway status, message-content-intent check, per-channel permission diagnostics | ⚠️ status card only (no webhook health; Bot Framework push model) | ✅ webhook status classifier + one-click Repair |
| Multi-workspace / multi-guild install catalog | ✅ `slackInstallations` | ✅ guild reconciliation, deactivation, default-channel picker | ✅ `teams_installations` upserted per activity | ⚠️ single bot, primary-chat capture instead |
| Inbound transport & auth | HTTPS webhook + HMAC signature | WebSocket Gateway service (leader-elected, durable Redis queue, dead-letter) + shared secret to API | HTTPS webhook + Bot Framework JWT (JWKS, endorsements) | HTTPS webhook + secret token header |

Discord is unique in having an entire gateway subsystem (`apps/discord-gateway`) with resume store, backpressure handling, and retry classification; the other three are plain webhooks.

## 2. Inbound triggers

| Feature | Slack | Discord | Teams | Telegram |
|---|---|---|---|---|
| @mention starts a task | ✅ `app_mention` | ✅ (incl. role-mention normalization) | ✅ channel + group chat | ✅ mention / `@bot` command suffix |
| DM / private chat starts a task (no mention) | ✅ | ✅ | ✅ personal scope | ✅ private chat |
| Thread reply → follow-up to running task | ✅ | ✅ | ✅ | ✅ (chat / forum topic) |
| Unmentioned thread-reply routing (owner + no-interjection heuristics, shared core) | ✅ stored thread state | ✅ | ⚠️ recomputed live from Graph history; needs linked user + delegated token, degrades to explicit mention | ⚠️ topic-ownership model instead (no history API) |
| Slash commands | ❌ none (by design; `!fast` / `!eval` text prefixes instead) | ✅ `/new` `/link` `/help` | ❌ (text-parsed `start idea N` only) | ✅ `/start` `/new` |
| Reaction-triggered launch (👍 on suggestion card) | ✅ `reaction_added` | ❌ (buttons instead) | ❌ (text parse instead) | ❌ (buttons instead) |
| Channel auto-start (auto-respond channels, LLM launch gate, per-channel instructions) | ✅ | ✅ full parity incl. settings UI | ❌ | ❌ |
| Link unfurls / Work Objects (`link_shared`, `entity_details_requested`) | ✅ | ❌ (suppress-embeds only) | ❌ | ❌ |
| Workflow-builder custom step (`function_executed`) | ✅ | n/a | n/a | n/a |
| Inline fast-agent (`!fast`, no cloud job) | ✅ | ❌ | ❌ | ❌ |
| Edited-message handling | ❌ | ❌ | ❌ | ✅ `edited_message` treated as message |
| Exactly-once event dedup (Redis) | ✅ SET NX | ✅ Lua claim/complete lease, 409/425 semantics | ✅ SET NX | ✅ SET NX |
| Bot-authored / self-message suppression | ✅ | ✅ (with auto-start channel exception) | ✅ | ✅ |
| Welcome message on bot added to channel | ✅ `member_joined_channel` + manager-channel auto-config | ❌ | ❌ | ⚠️ `/start` welcome |

## 3. Task lifecycle

| Feature | Slack | Discord | Teams | Telegram |
|---|---|---|---|---|
| LLM routing + workspace resolution | ✅ | ✅ | ✅ | ✅ |
| `platform_answer` (answer inline, no task) | ✅ | ✅ | ✅ | ✅ |
| Routing confirmation card with pickable workspaces | ✅ Block Kit | ✅ buttons | ❌ (no interactive surface; routes or falls back silently) | ✅ inline keyboard |
| Auto-confirm timer on routing card | ✅ | ✅ | n/a | ✅ |
| Free-text routing correction | ✅ | ✅ | ❌ | ✅ `resolveRoutingFollowUp` |
| Follow-up queueing with out-of-band context re-surfacing | ✅ | ✅ | ✅ | ✅ |
| Snapshot resume of completed task | ✅ | ✅ | ✅ + distributed leader/follower resume lock | ✅ |
| Cancel-task button | ✅ | ✅ ownership-checked | ❌ | ✅ |
| Retry-failed-task button | ✅ | ❌ | ❌ | ❌ |
| Task thread anchored to trigger message | ✅ native threads | ✅ thread reservation + forum posts w/ LLM tag selection | ✅ reply threading | ⚠️ forum topics (optional, capability-gated, single-chat fallback) |
| Early task title → thread/topic rename | n/a (Slack threads unnamed) | ✅ | ❌ | ✅ topic rename |
| Duplicate-launch idempotency (source-event lookup) | ✅ routing lock | ✅ returns existing task URL | ✅ activity dedup | ✅ update dedup |
| Acting-user sync on follow-ups | ✅ | ✅ | ✅ | ✅ |

## 4. Interactive elements

| Feature | Slack | Discord | Teams | Telegram |
|---|---|---|---|---|
| Callback buttons | ✅ block_actions | ✅ components (custom_id) | ❌ **silently dropped** (`appendTeamsButtonLinks`) | ✅ callback_query (64-byte data) |
| URL buttons | ✅ | ✅ link style | ⚠️ degrade to trailing markdown links | ✅ |
| `request_user_input` structured question flow | ✅ option buttons + answer blocks | ✅ buttons + one-answer-per-line thread text; dedicated worker answer queue | ❌ plain conversation only | ⚠️ natural-reply flow (worker answer queue is Discord-gated) |
| Ephemeral responses | ✅ `postEphemeral` | ⚠️ ephemeral interaction responses only | ❌ | ⚠️ callback toast only |
| Suggestion "start idea" mechanism | 👍 reaction | ▶️ button | text `start idea N` | ▶️ button |
| Expandable reply-details toggle | ✅ | ❌ | ❌ | ❌ |
| Modals | ❌ (not used) | ❌ (defer path exists, never opened) | ❌ | n/a |

## 5. Outbound messaging

| Feature | Slack | Discord | Teams | Telegram |
|---|---|---|---|---|
| Post + threaded reply | ✅ | ✅ | ✅ | ✅ |
| Rich formatting | ✅ markdown blocks + mrkdwn degradation | ✅ native markdown | ✅ markdown textFormat | ✅ markdown→HTML converter w/ fallback |
| Message chunking at platform limit | ✅ block-count chunking | ✅ 2,000 chars | ❌ single composed message | ✅ 4,096 chars, fence-aware |
| Edit message | ✅ | ✅ | ✅ `updateActivity` | ✅ |
| Delete message | ✅ | ✅ | ❌ | ✅ (48h window) |
| True emoji reactions | ✅ add/remove | ✅ add/remove, name→unicode map | ⚠️ emulated (posts emoji-only message) | ⚠️ fixed reaction set only |
| Ack reaction on pickup (👀, configurable emoji prefs) | ✅ configurable | ✅ | ⚠️ emulated | ✅ |
| Typing indicator with heartbeat | n/a (no API) | ✅ ~8s heartbeat | ❌ | ✅ 4s heartbeat |
| Managed live-status thread footer | ✅ sticky footer w/ lock | ⚠️ Follow/Cancel ack message instead | ✅ footer w/ lock + clear-on-update | ❌ explicitly omitted |
| Outbound DM creation | ✅ `openConversation` | ✅ `createDirectMessage` | ✅ `createDirectConversation` | ✅ private chat / primary chat |
| Rate-limit handling | ✅ retry-after | ✅ per-route buckets + global | ❌ none observed | ✅ 429 `retry_after` + backoff |
| Unfurl control | ✅ allowlist + Work Object unfurls | ✅ suppress-embeds parity | ❌ | ❌ |
| Message permalinks | ✅ | ⚠️ standard URLs | ✅ deep-link builder | ✅ `t.me` builder |

## 6. Attachments & files

| Feature | Slack | Discord | Teams | Telegram |
|---|---|---|---|---|
| Inbound images → task input (size caps, data URLs) | ✅ | ✅ 10MB/img, 30MB total | ✅ 10MB/img, 25MB total + Graph hosted-content fallback | ✅ 10MB, largest photo |
| Inbound text documents → extracted text in prompt | ✅ | ✅ 20MB | ❌ images only | ✅ 20MB |
| Thread-history attachment collection | ✅ 20-file caps | ✅ deduped | ⚠️ Graph images only | ❌ no history API |
| Outbound images from agent artifacts | ✅ upload | ✅ embeds | ✅ attachments | ✅ `sendPhoto` |
| Video descriptions appended to task text | ✅ | ❌ | ❌ | ❌ |
| Token/credential never leaks into prompts or URLs | ✅ | ✅ CDN-host validation | ✅ trusted-host gating | ✅ |

## 7. Agent-facing tools (MCP)

| Tool capability | Slack | Discord | Teams | Telegram |
|---|---|---|---|---|
| `send_chat_reply` (reply in originating thread) | ✅ | ✅ | ✅ | ✅ |
| Post to **arbitrary** channel | ✅ `post_to_slack_channel` (membership model via `isAppInChannel`) | ⚠️ `post_to_channel` restricted to task's own conversation | ⚠️ same restriction | ⚠️ same restriction |
| React to current message | ✅ | ✅ | ⚠️ emulated | ✅ limited set |
| React to arbitrary message (`add_reaction_to_slack_message`) | ✅ | ❌ | ❌ | ❌ |
| Question-channel suggestions (LLM ranks channels for Q&A) | ✅ | ❌ | ❌ | ❌ |
| Parent-only posting enforcement + silence hook | ✅ | ✅ shared | ✅ shared | ✅ shared |

## 8. Automations & suggestions

| Feature | Slack | Discord | Teams | Telegram |
|---|---|---|---|---|
| Setup/onboarding task suggestions | ✅ reaction-launch cards | ✅ thread/forum + buttons, DM fallback | ✅ text-launch, lowest precedence | ✅ topic + buttons |
| Scheduled automation suggestion summaries | ✅ | ✅ per-automation channel | ✅ primary conversation | ✅ primary chat |
| Surface precedence for suggestions | 1st | per-destination | last (Slack > Telegram > Teams) | 2nd |
| Onboarding follow-up reminder (BullMQ) | ✅ | ✅ | ✅ | ✅ |
| Per-automation destination targeting | ✅ channel selector UI | ✅ channel selector UI | ⚠️ primary conversation only | ⚠️ primary chat only |
| Manager channel + starter automations (suggester/announcer/stats) | ✅ | ❌ | ❌ | ❌ |
| MCP setup suggestions & recommendations | ✅ | ❌ | ❌ | ❌ |
| PR-inactivity check, PR-review notification delivery | ✅ | ❌ | ❌ | ❌ |
| Suggestion double-launch protection (claim CAS + fencing) | ✅ | ✅ | ✅ | ✅ |

## 9. Identity & permissions

| Feature | Slack | Discord | Teams | Telegram |
|---|---|---|---|---|
| Account linking | ✅ OIDC "Sign in with Slack" | ✅ `/link <code>` (DM-only) | ✅ Microsoft Entra OAuth | ✅ `/start <code>` / pasted code |
| User-mapping table + takeover protection | ✅ | ✅ | ✅ (AAD oid matching) | ✅ |
| Unlinked-sender gating (never launch, prompt to link) | ✅ thread + DM prompt | ✅ DM nudge, 1/user/day | ✅ DM + thread pointer | ✅ nudge rate limits (6h/user) |
| Resume original request after linking | ✅ pending-auth token | ❌ | ✅ auth-resume endpoint | ❌ |
| Deleted-thread suppression (stop replying when root deleted) | ✅ | ❌ | ❌ | ❌ |
| Admin-only setup gating | ✅ | ✅ | ✅ | ✅ |

## 10. Testing & infrastructure

| Feature | Slack | Discord | Teams | Telegram |
|---|---|---|---|---|
| Mock API harness + skill (`/mock/state`, `/mock/events`) | ✅ port 3012 | ✅ REST + synthetic gateway envelopes | ❌ **no harness** | ✅ port 3013 |
| `*_API_BASE_URL` override | ✅ | ✅ | ❌ | ✅ |
| Scenario/eval runners | ✅ | ✅ | ❌ | ✅ |
| Shared `CommunicationProviderAdapter` | ✅ | ✅ | ✅ | ✅ |
| Public docs page | ✅ | ✅ | ✅ | ✅ |

---

## Biggest parity gaps, ranked

1. **Teams has no interactive elements at all.** Callback buttons are silently dropped and URL buttons degrade to text links, which cascades into missing routing confirmation, missing cancel button, missing structured question flow, and the awkward `start idea N` text parser. Adopting Adaptive Cards would close roughly a third of the Teams gap column in one move.
2. **Teams has no mock harness.** Slack, Discord, and Telegram all have offline test harnesses and eval scenarios; Teams flows cannot be exercised without a real Bot Framework tenant.
3. **Channel auto-start exists only on Slack and Discord.** Teams and Telegram cannot do the auto-respond-channel wedge.
4. **Arbitrary-channel posting is Slack-only.** Discord/Teams/Telegram restrict the agent's `post_to_channel` to the launch conversation because none has an `isAppInChannel`-style membership model.
5. **Manager-channel ecosystem is Slack-only.** Starter automations, MCP setup suggestions/recommendations, PR-inactivity checks, PR-review notification delivery, manager stats, and question-channel suggestions have no equivalents elsewhere.
6. **request_user_input is uneven.** Full structured flow on Slack and Discord; Telegram falls back to natural replies (the worker answer queue is Discord-gated); Teams has nothing.
7. **Slack-unique platform surfaces** with no analogue anywhere: Workflow Builder custom step, Work Object unfurls, `!fast` inline fast-agent, reaction-triggered suggestion launch, expandable reply-details toggle, deleted-thread suppression, video descriptions.
8. **Things other channels have that Slack lacks:** slash commands (Discord, Telegram), typing indicators (Discord, Telegram), edited-message handling (Telegram), message-length chunking driven by hard char limits, and Discord's durable gateway delivery subsystem.

## Per-channel maturity read

- **Discord** is the closest Slack peer: full interactivity, channel auto-start, forum posts with LLM tag selection, a mock harness, and the most robust inbound transport in the codebase. Main gaps are ecosystem features (manager channel, MCP suggestions) and post-link request resume.
- **Telegram** is a solid mid-tier: full button interactivity, chunking, reactions, and a mock harness, but constrained by the platform (no history reads, no real threads, fixed reaction set) and missing channel auto-start and structured question flow.
- **Teams** is the weakest surface: reliable core loop (mention → route → task → follow-up → resume, with the most sophisticated resume locking of any channel), but no interactivity, no chunking, no delete, no rate-limit handling, no doc-text extraction, and no offline test story.
