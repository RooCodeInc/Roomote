# Changelog

This file tracks product releases for Roomote (single monorepo version). Automated release entries are prepended by `pnpm run version`.

## 0.0.3 (2026-07-11)

### Patch changes

- Fix the release image publish gate so the first production release can ship: resolve the upgrade baseline from the latest GitHub release safely instead of leaking a 404 error into the image tag, and skip upgrade validation when no previous published release exists (fresh-install validation still runs).

## 0.0.2 (2026-07-10)

### Patch changes

- Seed the product version lineage so the first automated release becomes 0.0.2 above the existing v0.0.1 tag.
