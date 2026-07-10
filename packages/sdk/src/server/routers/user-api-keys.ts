import { z } from 'zod';

import { db, userApiKeys, eq, and } from '@roomote/db/server';
import { decryptText } from '@roomote/db/encryption';

import { authenticatedProcedure, router } from '../trpc';
import { resolveActorScopedUserContext } from '../lib/auth';

export const userApiKeysRouter = router({
  /**
   * Returns whether an API key exists for the given provider and current
   * user, without decrypting or transmitting the key value.
   * Use this when you only need to know if a key is configured (e.g., to
   * enable an MCP proxy toggle) but don't need the actual secret.
   */
  hasKey: authenticatedProcedure
    .input(z.object({ provider: z.string() }))
    .query(async ({ ctx, input }) => {
      const { userId } = await resolveActorScopedUserContext(ctx.auth);

      if (!userId) {
        return false;
      }

      const row = await db.query.userApiKeys.findFirst({
        where: and(
          eq(userApiKeys.userId, userId),
          eq(userApiKeys.provider, input.provider),
        ),
        columns: {
          id: true,
        },
      });

      return row != null;
    }),

  /**
   * Returns the decrypted API key for the given provider and current user.
   * Accessible from worker via a run-scoped run token; the effective user is
   * the run's live acting user (falling back to the token's mint-time user).
   *
   * The run's acting user is server-controlled: `taskRuns.update` refuses to
   * let a run token reassign `task_runs.actingUserId`, so a compromised
   * sandbox cannot pivot this lookup to another user's key.
   */
  getDecryptedKey: authenticatedProcedure
    .input(z.object({ provider: z.string() }))
    .query(async ({ ctx, input }) => {
      const { userId } = await resolveActorScopedUserContext(ctx.auth);

      if (!userId) {
        return null;
      }

      const row = await db.query.userApiKeys.findFirst({
        where: and(
          eq(userApiKeys.userId, userId),
          eq(userApiKeys.provider, input.provider),
        ),
        columns: {
          apiKey: true,
        },
      });

      if (!row?.apiKey) {
        return null;
      }

      const decrypted = decryptText(row.apiKey);
      return decrypted;
    }),
});
