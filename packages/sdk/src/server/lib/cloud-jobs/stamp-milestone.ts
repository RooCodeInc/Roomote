import type { ComputeProviderLaunchMode } from '@roomote/types';
import { and, db, taskRuns, eq, isNull, sql } from '@roomote/db/server';

export const cloudJobMilestoneFields = [
  'provisionStartedAt',
  'provisionReadyAt',
  'setupCompletedAt',
  'harnessStartedAt',
  'runtimeTaskStartedAt',
  'firstAssistantOutputAt',
] as const;

export type CloudJobMilestoneField = (typeof cloudJobMilestoneFields)[number];

const milestoneColumns = {
  provisionStartedAt: taskRuns.provisionStartedAt,
  provisionReadyAt: taskRuns.provisionReadyAt,
  setupCompletedAt: taskRuns.setupCompletedAt,
  harnessStartedAt: taskRuns.harnessStartedAt,
  runtimeTaskStartedAt: taskRuns.runtimeTaskStartedAt,
  firstAssistantOutputAt: taskRuns.firstAssistantOutputAt,
} as const;

/**
 * Stamp a cloud job timing milestone exactly once.
 *
 * Uses `WHERE <field> IS NULL` so retries and duplicate first-token envelopes
 * do not overwrite the initial transition time. Safe to call concurrently:
 * the DB enforces the single-write invariant.
 *
 * Optionally also sets `launchMode` (typically alongside `provisionStartedAt`).
 * `launchMode` uses COALESCE so it is only written on the first stamp.
 */
export async function stampCloudJobMilestone(input: {
  cloudJobId: number;
  field: CloudJobMilestoneField;
  at?: Date;
  launchMode?: ComputeProviderLaunchMode;
}): Promise<void> {
  const { cloudJobId, field, at = new Date(), launchMode } = input;
  const column = milestoneColumns[field];

  const updates: Record<string, unknown> = { [field]: at };

  if (launchMode !== undefined) {
    updates.launchMode = sql`COALESCE(${taskRuns.launchMode}, ${launchMode})`;
  }

  await db
    .update(taskRuns)
    .set(updates)
    .where(and(eq(taskRuns.id, cloudJobId), isNull(column)));
}
