# Mock Slack Scenarios

Use this file to choose the closest scenario before creating a custom one.

## `app-mention-fast`

- Use for: fresh `@roomote !fast ...` mentions handled inline without a cloud job.
- Minimum setup:
  - one channel
  - one human user
  - one app-mention replay event
- Drive with: scenario `replay` or `POST /mock/events`
- Success looks like:
  - the mention is accepted by the webhook target
  - the mock state contains the expected thread or channel reply

## `app-mention-standard`

- Use for: normal Slack task kickoff flows that create or resume Roomote work.
- Minimum setup:
  - one channel or DM
  - one human user mapping in the target Roomote environment if the flow needs auth
  - one `app_mention` replay event
- Drive with: scenario `replay` or `POST /mock/events`
- Success looks like:
  - the webhook accepts the event
  - the resulting Slack-side acknowledgment or routed follow-up is visible in mock state

## `interactive-button`

- Use for: block action payloads such as routing confirmation, configure buttons, or follow-up interactions.
- Minimum setup:
  - a message in state that the interactive payload refers to
  - the payload body expected by the Slack handler
- Drive with: `POST /mock/events` using `kind: "interactive"`
- Success looks like:
  - the interactive payload is accepted
  - the expected message update, follow-up message, or side effect is visible in mock state

## `url-verification`

- Use for: Slack webhook handshake validation.
- Minimum setup:
  - webhook target only
- Drive with: `kind: "url_verification"`
- Success looks like:
  - the webhook target returns the challenge response without signature failures

## `deleted-thread-suppression`

- Use for: flows that must stop posting once the thread root is deleted.
- Minimum setup:
  - a thread root message
  - optional existing replies
- Drive with:
  - create initial state
  - delete the root through the harness
  - verify reply lookup behavior
- Success looks like:
  - `conversations.replies` returns `thread_not_found`
  - no further Slack-thread success claim is made without accounting for the deleted root

## `outbound-thread-reply`

- Use for: worker or API code that should post a reply into an existing Slack thread.
- Minimum setup:
  - a thread root in state
  - the Roomote service under test pointed at the harness via `R_SLACK_API_BASE_URL`
- Drive with: the real Roomote code path that emits the outbound Slack call
- Success looks like:
  - the expected reply appears in `/mock/state`
  - message ordering and `thread_ts` placement are correct

## `post-to-slack-channel`

- Use for: explicit outbound channel posts, including Roomote MCP-powered Slack posting.
- Minimum setup:
  - a target channel that exists in mock state
  - the service under test pointed at the harness
- Drive with: the real Roomote posting path
- Success looks like:
  - the expected top-level message or threaded channel post is recorded in `/mock/state`
