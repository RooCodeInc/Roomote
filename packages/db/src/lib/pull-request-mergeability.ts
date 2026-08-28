import { and, eq, inArray, isNull, lt, ne, or, type SQL } from 'drizzle-orm';

import { db } from '../db';
import { taskPullRequests } from '../schema';

export type PullRequestMergeabilityStatus = 'unknown' | 'clean' | 'conflicting';

export type TrackedPullRequestMergeabilityCandidate = {
  id: string;
  taskId: string;
  repository: string;
  prNumber: number;
  prUrl: string;
  prTitle: string | null;
  prBaseRef: string | null;
  mergeabilityStatus: PullRequestMergeabilityStatus;
  conflictDetectedAt: Date | null;
  conflictNotifiedAt: Date | null;
};

export async function listTrackedPullRequestsForMergeability(input: {
  repository: string;
  baseRef?: string;
  prNumber?: number;
  ids?: string[];
  skipNotifiedConflicts?: boolean;
}): Promise<TrackedPullRequestMergeabilityCandidate[]> {
  const scope: SQL[] = [];
  if (input.baseRef !== undefined) {
    scope.push(eq(taskPullRequests.prBaseRef, input.baseRef));
  }
  if (input.prNumber !== undefined) {
    scope.push(eq(taskPullRequests.prNumber, input.prNumber));
  }
  if (input.ids !== undefined) {
    if (input.ids.length === 0) return [];
    scope.push(inArray(taskPullRequests.id, input.ids));
  }
  if (scope.length === 0) {
    throw new Error('A pull request mergeability lookup requires a scope.');
  }

  const rows = await db.query.taskPullRequests.findMany({
    where: and(
      eq(taskPullRequests.sourceControlProvider, 'github'),
      eq(taskPullRequests.repository, input.repository),
      eq(taskPullRequests.createdByRoomote, true),
      eq(taskPullRequests.status, 'open'),
      ...scope,
      input.skipNotifiedConflicts
        ? or(
            ne(taskPullRequests.mergeabilityStatus, 'conflicting'),
            isNull(taskPullRequests.conflictNotifiedAt),
          )
        : undefined,
    ),
    columns: {
      id: true,
      taskId: true,
      repository: true,
      prNumber: true,
      prUrl: true,
      prTitle: true,
      prBaseRef: true,
      mergeabilityStatus: true,
      conflictDetectedAt: true,
      conflictNotifiedAt: true,
    },
  });

  return rows.filter(
    (row): row is TrackedPullRequestMergeabilityCandidate =>
      row.prNumber !== null && row.repository !== null,
  );
}

export async function updateTrackedPullRequestBaseRef(input: {
  repository: string;
  prNumber: number;
  baseRef: string;
}): Promise<void> {
  await db
    .update(taskPullRequests)
    .set({ prBaseRef: input.baseRef, updatedAt: new Date() })
    .where(
      and(
        eq(taskPullRequests.sourceControlProvider, 'github'),
        eq(taskPullRequests.repository, input.repository),
        eq(taskPullRequests.prNumber, input.prNumber),
        eq(taskPullRequests.createdByRoomote, true),
        eq(taskPullRequests.status, 'open'),
      ),
    );
}

export async function recordPullRequestMergeability(input: {
  id: string;
  status: PullRequestMergeabilityStatus;
}): Promise<{
  shouldNotify: boolean;
  conflictDetectedAt: Date | null;
}> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        mergeabilityStatus: taskPullRequests.mergeabilityStatus,
        conflictDetectedAt: taskPullRequests.conflictDetectedAt,
        conflictNotifiedAt: taskPullRequests.conflictNotifiedAt,
        status: taskPullRequests.status,
        createdByRoomote: taskPullRequests.createdByRoomote,
      })
      .from(taskPullRequests)
      .where(eq(taskPullRequests.id, input.id))
      .limit(1)
      .for('update');

    if (!current || !current.createdByRoomote || current.status !== 'open') {
      return { shouldNotify: false, conflictDetectedAt: null };
    }

    if (input.status === 'unknown') {
      if (current.mergeabilityStatus !== 'conflicting') {
        await tx
          .update(taskPullRequests)
          .set({ mergeabilityStatus: 'unknown', updatedAt: new Date() })
          .where(eq(taskPullRequests.id, input.id));
      }
      return { shouldNotify: false, conflictDetectedAt: null };
    }

    if (input.status === 'clean') {
      await tx
        .update(taskPullRequests)
        .set({
          mergeabilityStatus: 'clean',
          conflictDetectedAt: null,
          conflictNotificationClaimedAt: null,
          conflictNotifiedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(taskPullRequests.id, input.id));
      return { shouldNotify: false, conflictDetectedAt: null };
    }

    if (current.mergeabilityStatus === 'conflicting') {
      return {
        shouldNotify: current.conflictNotifiedAt === null,
        conflictDetectedAt: current.conflictDetectedAt,
      };
    }

    const conflictDetectedAt = new Date();
    await tx
      .update(taskPullRequests)
      .set({
        mergeabilityStatus: 'conflicting',
        conflictDetectedAt,
        conflictNotificationClaimedAt: null,
        conflictNotifiedAt: null,
        updatedAt: conflictDetectedAt,
      })
      .where(eq(taskPullRequests.id, input.id));

    return { shouldNotify: true, conflictDetectedAt };
  });
}

export async function markPullRequestConflictNotified(input: {
  id: string;
  conflictDetectedAt: Date;
  conflictNotificationClaimedAt: Date;
}): Promise<boolean> {
  const [updated] = await db
    .update(taskPullRequests)
    .set({
      conflictNotificationClaimedAt: null,
      conflictNotifiedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(taskPullRequests.id, input.id),
        eq(taskPullRequests.mergeabilityStatus, 'conflicting'),
        eq(taskPullRequests.conflictDetectedAt, input.conflictDetectedAt),
        eq(
          taskPullRequests.conflictNotificationClaimedAt,
          input.conflictNotificationClaimedAt,
        ),
        isNull(taskPullRequests.conflictNotifiedAt),
      ),
    )
    .returning({ id: taskPullRequests.id });

  return Boolean(updated);
}

const CONFLICT_NOTIFICATION_CLAIM_TTL_MS = 5 * 60 * 1000;

export async function claimPullRequestConflictNotification(input: {
  id: string;
  conflictDetectedAt: Date;
}): Promise<Date | null> {
  const claimedAt = new Date();
  const staleBefore = new Date(
    claimedAt.getTime() - CONFLICT_NOTIFICATION_CLAIM_TTL_MS,
  );
  const [claimed] = await db
    .update(taskPullRequests)
    .set({ conflictNotificationClaimedAt: claimedAt, updatedAt: claimedAt })
    .where(
      and(
        eq(taskPullRequests.id, input.id),
        eq(taskPullRequests.status, 'open'),
        eq(taskPullRequests.mergeabilityStatus, 'conflicting'),
        eq(taskPullRequests.conflictDetectedAt, input.conflictDetectedAt),
        isNull(taskPullRequests.conflictNotifiedAt),
        or(
          isNull(taskPullRequests.conflictNotificationClaimedAt),
          lt(taskPullRequests.conflictNotificationClaimedAt, staleBefore),
        ),
      ),
    )
    .returning({ id: taskPullRequests.id });

  return claimed ? claimedAt : null;
}

export async function releasePullRequestConflictNotificationClaim(input: {
  id: string;
  conflictDetectedAt: Date;
  conflictNotificationClaimedAt: Date;
}): Promise<void> {
  await db
    .update(taskPullRequests)
    .set({ conflictNotificationClaimedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(taskPullRequests.id, input.id),
        eq(taskPullRequests.conflictDetectedAt, input.conflictDetectedAt),
        eq(
          taskPullRequests.conflictNotificationClaimedAt,
          input.conflictNotificationClaimedAt,
        ),
        isNull(taskPullRequests.conflictNotifiedAt),
      ),
    );
}
