// Real-database guard for the raw SQL in claimDueSandboxOidcTargets. The
// query is hand-written (grouped SKIP LOCKED claim), so a schema rename slips
// past TypeScript and past the fully mocked sandbox-oidc tests — this is how
// `task_run_id` -> `run_id` broke the refresh sweep in dev without any gate
// noticing. Running the statement against the real test database makes
// Postgres parse every identifier.
//
// pnpm exec dotenvx run -f .env.test -- pnpm --filter @roomote/sdk exec vitest run src/server/lib/__tests__/sandbox-oidc-claim.db.test.ts
import { claimDueSandboxOidcTargets } from '../sandbox-oidc';

describe('claimDueSandboxOidcTargets (real database)', () => {
  it('executes the raw claim SQL against the live schema', async () => {
    const now = new Date();

    // No fixture rows needed: the value of this test is that Postgres parses
    // the statement. A stale column or table name fails here with 42703/42P01
    // regardless of row count.
    const claimed = await claimDueSandboxOidcTargets({
      now,
      claimUntil: new Date(now.getTime() + 60_000),
      limit: 1,
    });

    expect(Array.isArray(claimed)).toBe(true);
  });
});
