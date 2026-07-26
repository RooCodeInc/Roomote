import { eq, sql } from 'drizzle-orm';

import { type DatabaseOrTransaction, db } from '../db';
import { userRoutingPreferences } from '../schema';

export async function getUserRoutingPreference(
  userId: string,
  options: { executor?: DatabaseOrTransaction } = {},
) {
  const executor = options.executor ?? db;

  return executor.query.userRoutingPreferences.findFirst({
    where: eq(userRoutingPreferences.userId, userId),
    columns: {
      environmentId: true,
      correctionCount: true,
      lastCorrectedAt: true,
    },
  });
}

export async function recordUserRoutingPreference(
  input: { userId: string; environmentId: string },
  options: { executor?: DatabaseOrTransaction } = {},
): Promise<void> {
  const executor = options.executor ?? db;
  const now = new Date();

  await executor
    .insert(userRoutingPreferences)
    .values({
      userId: input.userId,
      environmentId: input.environmentId,
      correctionCount: 1,
      lastCorrectedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userRoutingPreferences.userId,
      set: {
        environmentId: input.environmentId,
        correctionCount: sql`case when ${userRoutingPreferences.environmentId} = excluded.environment_id then ${userRoutingPreferences.correctionCount} + 1 else 1 end`,
        lastCorrectedAt: now,
        updatedAt: now,
      },
    });
}
