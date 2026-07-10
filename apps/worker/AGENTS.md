# Worker Guidance

This guidance applies to `apps/worker` and its descendants.

`apps/worker` is a Roomote-managed task runtime. It owns sandbox setup,
workspace preparation, service startup, runtime env construction, harness
startup, task callbacks, MCP wiring, and snapshot or sandbox control. It is not
the place for general Roomote app-server internals or product business logic.

## Dos

- Prefer `@roomote/types`, `@roomote/sdk/client`, and other explicit
  worker-safe root or `./client` exports.
- Pass Roomote state through task-run payloads, environment config, injected
  env vars, or SDK calls.
- Keep subprocess environments explicit and minimal.
- Treat nested sandbox behavior as a first-class constraint when touching env
  propagation, auth material, and preview wiring.
- Add a worker-safe export when a shared helper is genuinely needed.

## Don'ts

- Do not import `@roomote/env`, `@roomote/db/server`, `@roomote/redis`, or
  workspace `./server` entrypoints into worker runtime code.
- Do not add direct database or Redis access from the worker just because the
  data is convenient upstream.
- Do not couple worker code to Roomote web, API, or controller implementation
  details when a runtime contract or SDK call would do.
- Do not leak worker-only secrets or broad launcher `process.env` state into
  task subprocesses.
- Do not put product or policy logic here when it belongs in prompt builders,
  the API layer, or the controller.

When in doubt, treat new Roomote-internal dependencies in `apps/worker` as a
code smell and either add a worker-safe export or route the operation through
`@roomote/sdk/client`.
