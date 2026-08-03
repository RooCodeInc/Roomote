import { nanoid } from 'nanoid';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { db, type DatabaseOrTransaction } from '../db';
import { licenseUsageObservations, users } from '../schema';

const OBSERVATION_BATCH_SIZE = 100;

export type LicenseUsageObservation = {
  id: string;
  observedAt: Date;
  activeUsers: number;
};

/** Record the post-mutation active-user count in the caller's transaction. */
export async function recordLicenseUsageObservation(
  executor: DatabaseOrTransaction,
  observedAt: Date = new Date(),
): Promise<LicenseUsageObservation> {
  const [totals] = await executor
    .select({ total: sql<number>`count(*)::int` })
    .from(users)
    .where(isNull(users.deletedAt));
  const observation: LicenseUsageObservation = {
    id: nanoid(),
    observedAt,
    activeUsers: totals?.total ?? 0,
  };

  await executor.insert(licenseUsageObservations).values(observation);
  return observation;
}

/** Adds the daily heartbeat observation and returns undelivered work. */
export async function recordDailyLicenseUsageObservation(): Promise<LicenseUsageObservation> {
  return recordLicenseUsageObservation(db);
}

export async function listPendingLicenseUsageObservations(): Promise<
  LicenseUsageObservation[]
> {
  return db
    .select({
      id: licenseUsageObservations.id,
      observedAt: licenseUsageObservations.observedAt,
      activeUsers: licenseUsageObservations.activeUsers,
    })
    .from(licenseUsageObservations)
    .where(isNull(licenseUsageObservations.deliveredAt))
    .orderBy(asc(licenseUsageObservations.observedAt))
    .limit(OBSERVATION_BATCH_SIZE);
}

export async function markLicenseUsageObservationAttempt(
  id: string,
): Promise<void> {
  await db
    .update(licenseUsageObservations)
    .set({
      attempts: sql`${licenseUsageObservations.attempts} + 1`,
      lastAttemptedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(licenseUsageObservations.id, id),
        isNull(licenseUsageObservations.deliveredAt),
      ),
    );
}

export async function markLicenseUsageObservationDelivered(
  id: string,
): Promise<void> {
  await db
    .update(licenseUsageObservations)
    .set({ deliveredAt: new Date(), updatedAt: new Date() })
    .where(eq(licenseUsageObservations.id, id));
}
