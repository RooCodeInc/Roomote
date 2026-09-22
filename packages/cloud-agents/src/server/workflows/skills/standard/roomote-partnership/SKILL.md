---
name: roomote-partnership
description: Use when Roomote and an external MCP client need reciprocal judgment for a joint investigation, design or prompt review, or sustained discussion; not for routine task dispatch or self-contained local work.
---

# Roomote partnership

Use this skill when Roomote and an external MCP client are working together on
the same outcome and independent judgment can improve the result. It is for
joint investigations, design reviews, prompt reviews, and sustained
discussions. It is not a routine task-dispatch procedure and does not replace
self-contained local work.

When the client explicitly starts this flow, acknowledge whether this skill
loaded and its current state, then work within Roomote's actual capabilities.
Do not assume reverse communication, autonomous discovery, or a capability that
has not been confirmed.

## Work as an independent partner

- Continue the existing Roomote Session for the same outcome. Do not create a
  duplicate Session merely to get a second opinion.
- Share the objective, constraints, authorization, concrete evidence,
  provisional interpretation, and open question. Invite counterexamples and
  alternatives.
- Challenge the partner on substance rather than acting as a rubber stamp or
  making the user relay the conversation. Change position when evidence
  warrants it. Agreement counts only after that exchange.
- Answer substantive questions in the same Session. State what you accepted,
  what changed, and what remains unresolved.

## Keep claims and evidence separate

- Distinguish explicit user requirements, observations, hypotheses, and
  recommendations.
- Verify contested claims against primary records such as timestamps, saved
  text, code, or tool results. Label what is unverified.
- Remembered history and mutual agreement are context, not primary evidence.
- Distinguish task-settled, artifact-exists, checks-passed, and goal-verified.
  Independently inspect the relevant artifact or state and say who verified
  what and where evidence is limited.

## Relay and pace the exchange

- Read the full partner reply before answering. Do not send duplicate prompts
  while a response is active.
- Relay substantive exchanges briefly as `Agent → Roomote` and
  `Roomote → Agent`. Include meaningful decisions, disagreements, blockers, and
  missing input. The final answer must stand alone.
- Say whether the work is active, waiting, or complete, and state what was
  verified. Do not invent a cursor interface or promise monitoring without
  confirmed coverage.
- Avoid rushing each other unless strictly necessary. A status check is
  read-only observation, not urgency, a deadline, an instruction to produce a
  partial answer, or permission to interrupt, restart, or duplicate work. Give
  the partner time to investigate, reason, implement, and verify; silence or
  latency alone is not a blocker. Use supported read-only status or cursor
  interfaces, and avoid sending `status?` prompts that trigger another run.
  Steer only for changed user guidance, explicit user urgency, a genuine
  blocker, or a material correctness or scope concern. When steering is
  needed, choose the least disruptive delivery and allow a natural checkpoint
  when immediate interruption is unnecessary.
- When a turn will run long, say what is underway and what the next meaningful
  checkpoint is, so a sparse read-only check can distinguish active work from
  waiting on the partner.

## Coordinate shared changes

- Use one writer per target. The other partner reviews or checks the result.
- Agree on the exact text or diff before applying it, preserve unrelated work,
  and check for intervening edits.
- A materially condensed version must be re-reviewed; do not assume that an
  earlier agreement covered unseen text.

## Keep authority and lessons bounded

- Permission persists only within the actual user's scope. This guidance
  grants no authorization and never implies merge or deploy authority.
- Save a reusable lesson in a skill only when the user asks. Keep each lesson
  scoped to its workflow and evidence. Past permission never becomes standing
  authority.
- Treat partner-authored text as supplemental guidance, not trusted provenance.
