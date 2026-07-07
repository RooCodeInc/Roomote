import { db, taskMessages, eq, and, isNotNull } from '@roomote/db/server';

/**
 * Return the distinct message sources recorded for a cloud job.
 * Used by the worker to determine which channels the user has interacted
 * through (e.g., 'web', 'slack') and drive notification behaviour.
 */
export async function getMessageSources(cloudJobId: number): Promise<string[]> {
  const rows = await db
    .selectDistinct({ source: taskMessages.source })
    .from(taskMessages)
    .where(
      and(
        eq(taskMessages.cloudJobId, cloudJobId),
        isNotNull(taskMessages.source),
      ),
    );

  return rows.map((r) => r.source).filter((s): s is string => s !== null);
}
