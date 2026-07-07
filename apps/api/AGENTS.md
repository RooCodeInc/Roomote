# API Guidance

This guidance applies to `apps/api` and its descendants.

`apps/api` is the Hono host for webhook intake, MCP and task-control routes,
artifact APIs, and the backend tRPC surface. It should stay a thin app
host with clear handler ownership.

## Dos

- Keep `src/server.ts` focused on middleware and route mounting, and put
  endpoint behavior in handlers or middleware modules.
- Preserve the current middleware contract: request observability first, then
  the `/api/*` and `/trpc/*` `cors()` layers, then the public OIDC carve-out
  inside the bearer-token auth stack, with `/admin` basic auth added
  in non-development before route handling.
- Extend the existing owning surface (`/trpc`, a webhook family, `/api/mcp/*`,
  or artifacts) instead of creating overlapping endpoints.
- Keep long-lived worker and MCP paths compatible with the observed-fetch and
  bearer or job-token auth expectations already used by the runtime.

## Don'ts

- Do not bury new business logic in `server.ts` or scatter the same behavior
  across multiple API surfaces.
- Do not accidentally protect the public OIDC discovery and JWKS endpoints or
  skip auth on routes that should inherit the normal stack.
- Do not widen actor or permission context for automated relays without
  checking the existing acting-user and handoff rules.
- Do not add browser-only concerns to the API host process.
