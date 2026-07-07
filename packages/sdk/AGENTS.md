# SDK Package Guidance

This guidance applies to `packages/sdk` and its descendants.

`packages/sdk` is Roomote's backend contract between the API, controller, and
worker. `@roomote/sdk/client` owns the runtime HTTP client, `@roomote/sdk/server`
owns the router and server helpers, and the root `@roomote/sdk` surface should
stay lightweight and broadly safe to import.

## Dos

- Keep shared types and client-safe barrels in the root or `./client`, and
  keep server-only helpers on `./server`.
- Prefer adding typed router procedures or SDK helpers when multiple runtimes
  need the same capability.
- Preserve worker-facing auth and auth-bypass header behavior in
  `buildWorkerHeaders()` and `workerClient`.
- Extend existing namespaces before inventing one-off SDK entrypoints.

## Don'ts

- Do not pull database, Redis, or env-dependent server helpers into the root
  `@roomote/sdk` surface or `./client`.
- Do not make worker or controller callers hand-assemble bespoke URLs, headers,
  or payload conventions when the SDK can own that contract.
- Do not put browser-only helpers here; this package is for backend and worker
  runtimes.
- Do not add ad hoc HTTP-side contracts when an existing tRPC surface should
  own the shared API.
