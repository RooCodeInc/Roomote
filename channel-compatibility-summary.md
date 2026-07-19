# Roomote Channel Compatibility Summary

Slack is the baseline (most feature-complete surface). Audited from `develop`, 2026-07-19.

Legend: ✅ full parity · ⚠️ partial or different mechanism · ❌ absent

## Compatibility at a glance

| Feature cluster | Discord | Teams | Telegram |
|---|---|---|---|
| Core loop (mention → route → task → follow-up → snapshot resume) | ✅ | ✅ | ✅ |
| DM / private-chat task entry | ✅ | ✅ | ✅ |
| Unmentioned thread-reply routing | ✅ | ⚠️ live Graph recompute, degrades to explicit mention | ⚠️ topic-ownership model |
| Interactive buttons (routing confirmation, cancel, start-idea) | ✅ | ❌ buttons silently dropped | ✅ |
| request_user_input structured questions | ✅ | ❌ | ⚠️ natural-reply fallback |
| Channel auto-start (auto-respond channels) | ✅ | ❌ | ❌ |
| Outbound messaging (edits, deletes, chunking, reactions) | ✅ | ⚠️ no chunking, no delete, emulated reactions | ✅ (fixed reaction set) |
| Inbound attachments (images + doc text extraction) | ✅ | ⚠️ images only | ✅ |
| Agent tool: reply in thread | ✅ | ✅ | ✅ |
| Agent tool: post to arbitrary channel | ⚠️ own conversation only | ⚠️ own conversation only | ⚠️ own conversation only |
| Automation suggestion cards + follow-up reminders | ✅ | ✅ (text-launch, lowest precedence) | ✅ |
| Per-automation destination targeting | ✅ | ⚠️ primary conversation only | ⚠️ primary chat only |
| Manager-channel ecosystem (MCP suggestions, PR checks, stats) | ❌ | ❌ | ❌ |
| Account linking | ✅ (no post-link resume) | ✅ + post-link resume | ✅ (no post-link resume) |
| Mock test harness + API base URL override | ✅ | ❌ | ✅ |

## Slack-only features

Workflow Builder custom step, Work Object link unfurls, `!fast` inline fast-agent, 👍 reaction-triggered suggestion launch, expandable reply-details toggle, deleted-thread suppression, video descriptions, arbitrary-channel posting (`post_to_slack_channel`), react-to-arbitrary-message tool, question-channel suggestions, and the whole manager-channel automation ecosystem.

## Features Slack lacks that others have

Slash commands (Discord `/new` `/link` `/help`; Telegram `/start` `/new`), typing indicators with heartbeat (Discord, Telegram), edited-message handling (Telegram), Discord's durable WebSocket gateway with leader election and dead-lettering.

## Biggest gaps, ranked

1. **Teams has no interactivity.** Callback buttons are dropped, URL buttons degrade to text links. This cascades into no routing confirmation, no cancel button, no question flow, and the `start idea N` text parser. Adaptive Cards would close roughly a third of the Teams gap in one move.
2. **Teams has no mock harness or `TEAMS_API_BASE_URL`**, making it the only channel that can't be tested offline.
3. **Channel auto-start is Slack + Discord only.**
4. **Arbitrary-channel agent posting is Slack-only** (no channel-membership model elsewhere).
5. **Manager-channel ecosystem is Slack-only.**
6. **request_user_input is uneven:** full on Slack/Discord, natural-reply on Telegram, absent on Teams.

## Per-channel maturity

- **Discord: closest Slack peer.** Full interactivity, channel auto-start, forum posts with LLM tag selection, mock harness, and the most robust inbound transport in the codebase. Gaps are ecosystem features and post-link resume.
- **Telegram: solid mid-tier.** Full buttons, fence-aware 4,096-char chunking, mock harness; constrained by the platform (no history reads, threads only via forum topics, fixed reaction set) and missing auto-start and structured questions.
- **Teams: weakest surface.** Reliable core loop with the most sophisticated resume locking of any channel, but no interactivity, chunking, delete, rate-limit handling, doc extraction, or offline test story.
