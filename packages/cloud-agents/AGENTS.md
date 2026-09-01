# Cloud Agents Package Guidance

This guidance applies to `packages/cloud-agents` and its descendants.

`packages/cloud-agents` owns Roomote prompt assembly, task routing, workflow
composition, and packaged skill shipping. Small wording changes here can change
behavior across Slack, GitHub, Linear, web-launched tasks, and the worker.

## Dos

- Find the current owner for a behavior before editing: system prompt, default
  style guidance, workflow builder, packaged skill, channel wrapper, or router
  prompt.
- Keep `src/index.ts` client-safe and keep queueing, routing, and workflow
  logic under `src/server/`.
- Tighten or replace existing prompt rules before adding another layer of
  instructions.
- Treat `standardTask()` first-hop routing and packaged-skill contracts as core
  product behavior, not incidental string assembly.
- Run the narrowest useful validation for prompt changes, such as router evals
  or targeted workflow tests.

## Don'ts

- Do not duplicate the same behavior across the system prompt, workflow
  builders, and packaged skills.
- Do not turn repo-local skills into top-level routers for ordinary
  natural-language requests when `standardTask()` already owns that decision.
- Do not add server-only dependencies to the client-safe root export surface.
- Do not edit runtime-copied skill files when the checked-in source lives under
  `packages/cloud-agents/src/server/workflows/skills/` or `.agents/skills/`.
- Do not treat prompt wording here as low-risk copy; it is runtime behavior.

## Conversational setup

The first-admin setup session uses trusted Setup action cards for source
control, sandbox configuration, first-work selection, and automation
recommendations. The renderer owns those controls; the agent's prose should
state the user's goal, the capability it needs, the outcome that changed, or
the decision the user needs to make. It must not name, locate, or instruct the
user to interact with cards, rails, dialogs, panels, buttons, presets, or setup
steps. Credentials never belong in chat; detailed source-control configuration
stays in the trusted UI.
