---
title: Licensing & Seat Limits
status: active
last_reviewed: 2026-07-07
owner: engineering
summary: FCL-1.0-ALv2 licensing model, the free 10-seat tier, signed license keys, the seat-count enforcement gate, and the admin license surface in Settings → Users.
---

# Licensing & Seat Limits

Roomote is source-available under the Fair Core License 1.0 with an Apache-2.0
future grant (`FCL-1.0-ALv2`, see repository-root `LICENSE`). The FCL is the
FSL plus a license-key clause: recipients may not move, change, disable, or
circumvent the license key functionality. That clause is what legally backs the
seat gate described here, so the in-app enforcement is deliberately simple and
offline rather than DRM-grade.

## Product Model

- A deployment is **free for up to 10 registered users** (active,
  non-soft-deleted `users` rows). The constant is `FREE_SEAT_LIMIT` in
  `apps/web/src/lib/server/license.ts`.
- A **license key** from the Roomote maintainers raises the limit to the key's
  `maxSeats` (never below the free limit).
- The gate only ever blocks **adding** users. Existing users are never locked
  out by an expired, removed, or invalid key — over-limit deployments degrade
  to "no new sign-ups," nothing else.
- A seat is any active `users` row, regardless of which sign-in path or
  surface created it.

## License Keys

Format: `RMLK1.<base64url JSON payload>.<base64url Ed25519 signature>`.

Payload fields: `licenseId`, `licensee`, `maxSeats`, `issuedAt`,
`expiresAt` (null for perpetual keys). Verification is fully offline against an
Ed25519 public key embedded in `apps/web/src/lib/server/license.ts`
(`LICENSE_PUBLIC_KEY_SPKI_B64`); deployments never phone home.

Issuing is licensor-only tooling in `scripts/license.mjs` (`keygen`, `issue`,
`inspect`). The private signing key is never committed; self-hosters cannot
mint keys, which is the entire security model — there is no obfuscation layer
on top.

## Enforcement Points

| Concern | Location |
| --- | --- |
| Key verification & state resolution | `apps/web/src/lib/server/license.ts` (`verifyLicenseKey`, `resolveLicenseState`, `getDeploymentLicenseState`) |
| The gate itself | `assertSeatAvailable(tx)` in `license.ts` — locks the `deployment_settings` row `FOR UPDATE`, counts active users, throws `SeatLimitExceededError`; must run inside the transaction that admits the user so concurrent admissions serialize |
| Seat gate on new-user admission | `ensureDeploymentIdentity()` in `apps/web/src/lib/server/auth-context.ts` — `assertSeatAvailable()` inside the user-insert transaction |
| Seat gate on soft-delete restore | same file, restore branch — `assertSeatAvailable()` plus the `deletedAt`-clearing update in their own transaction |
| Sign-up rejection at capacity | `user.create.before` hook in `apps/web/src/lib/server/auth.ts` throws an `APIError` with the seat-limit message when `hasSeatAvailable()` is false, so the sign-up form shows the error inline and no auth user is created (advisory, read-only check) |
| Sign-in error surfaced to the visitor | `SeatLimitExceededError` caught in `getSignedInAuthContext()` → `AuthError` with `reason: 'seat_limit'`; the `/sign-in` page re-runs the evaluation and shows a seat-limit notice (`noticeMessage` on `AuthForm`) to a bounced session holder |
| Key storage | `deployment_settings.license_key` (nullable text, singleton row; migration `0030`) — verified at read time, never trusted as stored |
| Admin read/write | `accessPolicy.get` (returns a `license` summary with `status`/`seatLimit`/`seatsUsed`) and `accessPolicy.setLicenseKey` tRPC procedures (`apps/web/src/trpc/commands/access-policy/index.ts`); `setLicenseKey` rejects invalid and expired keys at save time |
| Admin UI | License section in Settings → Users (`apps/web/src/components/settings/UsersSettings.tsx`): status badge, seats used/limit, key entry, at-limit warnings |

License state resolution: no key → `unlicensed` (free limit); unverifiable key
→ `invalid` (free limit); expired key → `expired` (free limit); valid key →
`valid` with `seatLimit = max(maxSeats, FREE_SEAT_LIMIT)`.

Unit coverage lives in
`apps/web/src/lib/server/__tests__/license.test.ts` (signature verification,
tamper/forge rejection, payload shape validation, expiry fallback).

## Rules For Changes

- Treat the seat gate as license key functionality: keep enforcement inside
  the admission transaction, and do not add bypasses, env-var overrides, or
  alternate user-creation paths that skip `ensureDeploymentIdentity()`.
  (`/auth/dev-login` is the one deliberate development-only exception.)
- Changing `FREE_SEAT_LIMIT` or key semantics is a product/licensing decision:
  update `LICENSE` messaging surfaces together — README license callout,
  `apps/docs/index.mdx`, `SELF_HOSTING.md` (License And Seats section), and
  this page.
- If a new surface starts creating `users` rows, it must pass through the same
  gate.
