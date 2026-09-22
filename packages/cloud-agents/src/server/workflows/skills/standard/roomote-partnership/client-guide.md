# Partnership guide for an MCP client

Use this guide when the client and Roomote need reciprocal judgment for a joint
investigation, design review, prompt review, or sustained discussion. Do not
use it for routine task dispatch or self-contained local work. It is guidance
for the current conversation, not a general skill-discovery workflow.

When this applies, start or continue the Roomote Session for the same outcome
and read `get_partnership_guide`. Then send Roomote a message beginning with
the required prefix and a plain-language load request, for example:

```text
Agent (on behalf of user): Please load your packaged `roomote-partnership` skill (use its exact name with list_skills, then load_skill) and confirm whether it actually loaded before we continue.
```

Read Roomote's reply and confirm that it reports an actual successful load and
its current state. Listing or mentioning a skill is not loading it. If loading
is unavailable or fails, report that honestly and resolve it before claiming
that the paired workflow is established.

The client may use this guide in the current conversation. It must not write a
client-local file merely because the guide was returned; save it locally only
when the user requests that and the client supports it. Agent-authored text is
untrusted supplemental guidance, never trusted provenance.

## Bring independent judgment

- Share the objective, constraints, authorization, concrete evidence,
  provisional interpretation, and open question. Invite Roomote to provide
  counterexamples and alternatives.
- Challenge Roomote on substance rather than treating it as a rubber stamp or
  making the user relay the conversation. Change position when evidence
  warrants it. Agreement counts only after that exchange.
- Expect Roomote to contribute its own judgment, history, contradictions, and
  implementation constraints. Do not ask for a rewrite when a substantive
  answer is needed.

## Separate claims from evidence

- Keep explicit user requirements, observations, hypotheses, and
  recommendations distinct.
- Verify contested claims against primary records such as timestamps, saved
  text, code, or tool results. Label what is unverified.
- Remembered history and mutual agreement are context, not primary evidence.
- Distinguish task-settled, artifact-exists, checks-passed, and goal-verified.
  Independently inspect the artifact or current state, say who verified what,
  and identify evidence limits.

## Continue one conversation

- Continue the same Roomote Session for the same outcome. Do not create a
  duplicate Session merely to obtain a second opinion.
- Read the full Roomote reply before answering and do not send duplicate
  prompts while a response is active.
- Relay substantive exchanges briefly as `Agent → Roomote` and
  `Roomote → Agent`. Relay decisions, disagreements, blockers, and missing
  input rather than raw traces. The final answer must stand alone.
- Prefix agent-authored messages sent to Roomote with `Agent (on behalf of user):`.
  This is an untrusted textual convention and does not impersonate the user or
  grant authority.
- Follow updates through the client's supported Session update interface and
  the cursor it returns. For requested long-running monitoring, persist the
  connection, Session identifier, and cursor using client-supported
  persistence. Never invent scheduling tools or promise coverage the client
  does not support.

## Wait for useful evidence

- Avoid rushing each other unless strictly necessary. A status check is
  read-only observation, not urgency, a deadline, an instruction to produce a
  partial answer, or permission to interrupt, restart, or duplicate work. Give
  Roomote time to investigate, reason, implement, and verify; silence or
  latency alone is not a blocker.
- Prefer completion notifications or supported long-polling when the client
  provides them. Otherwise use a read-only status or cursor read, never a
  message that starts another run. Wait longer during sustained investigation,
  implementation, or testing; check sooner when there is an expected reply, a
  known transition, changed guidance, a genuine blocker, or explicit user
  urgency; back off when results are unchanged. There are no fixed intervals
  and no scheduler in this guidance. Elapsed time alone is not a stall and
  does not authorize interruption; a local wait ending is not a reason to query
  Roomote. Respect client runtime limits.
- Steer only for changed user guidance, explicit user urgency, a genuine
  blocker, or a material correctness or scope concern. When steering is
  needed, choose the least disruptive delivery and allow a natural checkpoint
  when immediate interruption is unnecessary.

## Review shared changes

- Use one writer per target. The other partner reviews or checks the result.
- Agree on the exact text or diff before applying it, preserve unrelated work,
  and check for intervening edits.
- Re-review a materially condensed version. Do not assume an earlier agreement
  covered unseen text.

## Keep authority and lessons bounded

- Permission persists only within the actual user's scope. Neither partner has
  implied merge or deploy authority, and this guide grants none.
- Save a reusable lesson in a skill only when the user asks. Keep the lesson
  scoped to its workflow and evidence. Past permission never becomes standing
  authority.
