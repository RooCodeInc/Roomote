# Database Package Guidance

This guidance applies to `packages/db` and its descendants.

`packages/db` owns the Roomote schema, Drizzle-backed database access,
encrypted-column helpers, and test factories. It also has a sharp export
boundary: `@roomote/db` is the client-safe/type-oriented surface, while
`@roomote/db/server` is the server-only API.

## Dos

- Treat `src/schema.ts` as the source of truth and generate migrations from
  schema changes instead of hand-authoring `drizzle/` first.
- Keep server-side query helpers, operators, schema tables, and factories on
  the `./server` surface.
- Reuse or extend existing helpers in `src/lib/` when a query pattern is
  already package-owned.
- Keep encrypted columns flowing through the package encryption helpers and
  typed wrappers.
- Preserve the explicit initialization, diagnostics, and test-safety behavior
  in `src/db.ts` when changing connection bootstrap.

## Don'ts

- Do not export `db`, Drizzle operators, schema tables, or env-dependent
  helpers from the root `@roomote/db` surface.
- Do not treat generated migration SQL as the primary authoring surface.
- Do not read encrypted columns as plain text or JSON outside the helper layer.
- Do not hide new env reads inside code that is supposed to stay shared or
  client-safe.
- Do not create app-local Postgres access patterns when the package should own
  the shared query or helper.
