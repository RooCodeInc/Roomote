# Changelog

This file tracks product releases for Roomote (single monorepo version). Automated release entries are prepended by `pnpm run version`.

## 0.0.5 (2026-07-11)

### Patch changes

- Surface worker base-image provisioning on Settings → Sandboxes: the save button now reads "Provisioning..." while a run is in flight (matching the setup wizard), a failed run shows its error inline with a "Retry provisioning" action, and a note explains that provisioning can take a few minutes. Previously the page kept a generic "Saving..." spinner during the run and never displayed provisioning failures.

## 0.0.4 (2026-07-11)

### Patch changes

- Ship the post-0.0.3 develop backlog toward production, including Daytona environment/task snapshot resume with legacy env aliases, default-deny API authorization, R_* public env canonicalization, CI status in PR review feedback replies, sandbox provider UX fixes, and other already-merged fixes.

## 0.0.3 (2026-07-11)

### Patch changes

- Fix the release image publish gate so the first production release can ship: resolve the upgrade baseline from the latest GitHub release safely instead of leaking a 404 error into the image tag, and skip upgrade validation when no previous published release exists (fresh-install validation still runs).

## 0.0.2 (2026-07-10)

### Patch changes

- Seed the product version lineage so the first automated release becomes 0.0.2 above the existing v0.0.1 tag.
