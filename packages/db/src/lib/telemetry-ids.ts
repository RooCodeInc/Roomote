import { nanoid } from 'nanoid';

import { db } from '../db';
import { deploymentSettings, users } from '../schema';
import { eq, isNull, and } from 'drizzle-orm';

const DEFAULT_DEPLOYMENT_ID = 'default';

/**
 * Length of the anonymous analytics identifiers. 12 characters of the
 * default nanoid alphabet (64 symbols) is ~71 bits of randomness, which keeps
 * collision odds negligible while staying short.
 */
const ANALYTICS_ID_LENGTH = 12;

export function generateAnalyticsId(): string {
  return nanoid(ANALYTICS_ID_LENGTH);
}

/**
 * Returns the stable anonymous instance analytics id, lazily generating and
 * persisting it on first use. The id lives on the deployment_settings
 * singleton row, is never derived from customer data, and has no
 * user-facing write path.
 *
 * Concurrency-safe: the UPDATE only fills a NULL column, so racing callers
 * converge on whichever id was committed first.
 */
export async function getInstanceAnalyticsId(): Promise<string> {
  const existing = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { instanceAnalyticsId: true },
  });

  if (existing?.instanceAnalyticsId) {
    return existing.instanceAnalyticsId;
  }

  const candidate = generateAnalyticsId();

  if (!existing) {
    await db
      .insert(deploymentSettings)
      .values({
        id: DEFAULT_DEPLOYMENT_ID,
        instanceAnalyticsId: candidate,
        setupCompletedAt: null,
      })
      .onConflictDoNothing({ target: deploymentSettings.id });
  }

  await db
    .update(deploymentSettings)
    .set({ instanceAnalyticsId: candidate, updatedAt: new Date() })
    .where(
      and(
        eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
        isNull(deploymentSettings.instanceAnalyticsId),
      ),
    );

  const settled = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { instanceAnalyticsId: true },
  });

  if (!settled?.instanceAnalyticsId) {
    throw new Error('Failed to initialize the instance analytics id');
  }

  return settled.instanceAnalyticsId;
}

/**
 * Returns the anonymous analytics id for a user, lazily generating and
 * persisting it on first use. Returns null when the user does not exist.
 *
 * Concurrency-safe like getInstanceAnalyticsId: the UPDATE only fills a NULL
 * column, so racing callers converge on the committed id.
 */
export async function getUserAnalyticsId(
  userId: string,
): Promise<string | null> {
  const existing = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { analyticsId: true },
  });

  if (existing === undefined) {
    return null;
  }

  if (existing.analyticsId) {
    return existing.analyticsId;
  }

  const candidate = generateAnalyticsId();

  await db
    .update(users)
    .set({ analyticsId: candidate })
    .where(and(eq(users.id, userId), isNull(users.analyticsId)));

  const settled = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { analyticsId: true },
  });

  return settled?.analyticsId ?? null;
}

/**
 * Persists the latest released version reported by the Ping version-check
 * endpoint. Stored for a future "update available" surface; no UI reads it
 * yet.
 */
export async function recordLatestKnownVersion(
  latestVersion: string,
  checkedAt: Date = new Date(),
): Promise<void> {
  await db
    .insert(deploymentSettings)
    .values({
      id: DEFAULT_DEPLOYMENT_ID,
      latestKnownVersion: latestVersion,
      latestVersionCheckedAt: checkedAt,
      setupCompletedAt: null,
    })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: {
        latestKnownVersion: latestVersion,
        latestVersionCheckedAt: checkedAt,
        updatedAt: checkedAt,
      },
    });
}
