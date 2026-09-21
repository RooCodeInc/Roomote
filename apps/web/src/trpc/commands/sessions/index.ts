import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  acquireFastAgentTurnLock,
  fastAgentConversationRepository,
} from '@roomote/cloud-agents/server';
import {
  activeRunStatuses,
  ARTIFACT_UPLOAD_URL_MAX_AGE_SECONDS,
  RunStatus,
  SESSION_STATUSES,
  fastConversationMemorySlug,
  isExitedRunStatus,
} from '@roomote/types';
import {
  and,
  asc,
  advanceSessionReadCursor,
  cancelSessionWakeupsForConversation,
  db,
  eq,
  fastAgentConversations,
  getSessionGoal,
  inArray,
  markSessionGoal,
  or,
  sessions,
  sessionTasks,
  taskArtifacts,
  taskRuns,
  tasks,
  enqueueBrainPageRetirements,
  enqueueTaskMemoryRetirements,
  isNull,
  markTaskStartParallelCountsEndedAtForTaskIds,
} from '@roomote/db/server';
import { captureEvent } from '@roomote/telemetry/server';
import { settleLiveTaskMessageOnExit, stopTaskRun } from '@roomote/sdk/server';

import type { UserAuthSuccess } from '@/types';
import {
  findAccessibleSession,
  getLatestExternalSessionEvent,
  getSessionById,
  getSessionForTask,
  getSessions,
  getSessionTimeline,
  listSessionPins,
  setSessionPinned,
  updateSessionMetadata,
} from '@/lib/server/sessions';
import {
  currentEpochSeconds,
  signArtifactId,
} from '@/lib/server/artifact-signature';
import { deleteArtifactsBatch } from '@/lib/server/s3-client';

// Keep polled session payloads stable for the raw route's one-hour cache lifetime.
const ARTIFACT_SIGNATURE_CACHE_WINDOW_SECONDS = 60 * 60;
const TASK_STOP_WAIT_MS = 15_000;
const TASK_STOP_POLL_MS = 100;

export const sessionIdInputSchema = z.object({ sessionId: z.string().uuid() });

type AccessibleSession = Awaited<ReturnType<typeof findAccessibleSession>>;

function canManageSession(
  auth: UserAuthSuccess,
  session: AccessibleSession,
): session is NonNullable<AccessibleSession> {
  if (!session) return false;
  return session.privacy === 'private'
    ? session.privateOwnerUserId === auth.userId
    : auth.isAdmin || session.ownerUserId === auth.userId;
}

export async function stopSessionTasksCommand(
  auth: UserAuthSuccess,
  sessionId: string,
) {
  const session = await findAccessibleSession(auth, sessionId);
  if (!canManageSession(auth, session)) {
    return { success: false as const, stoppedCount: 0 };
  }

  const runs = await db
    .select({
      id: taskRuns.id,
      taskId: taskRuns.taskId,
      payload: taskRuns.payload,
      status: taskRuns.status,
      sandboxServerUrl: taskRuns.sandboxServerUrl,
      actingUserId: taskRuns.actingUserId,
    })
    .from(taskRuns)
    .innerJoin(sessionTasks, eq(sessionTasks.taskId, taskRuns.taskId))
    .where(
      and(
        eq(sessionTasks.sessionId, sessionId),
        inArray(taskRuns.status, activeRunStatuses as readonly RunStatus[]),
      ),
    );

  const results = await Promise.all(
    runs.map(async (run) => {
      const result = await stopTaskRun({
        run,
        authUserId: auth.userId,
        terminate: false,
        cancelledBy: { name: auth.name ?? undefined, source: 'web' },
      }).catch(() => null);
      if (result?.success) return true;

      const current = await db.query.taskRuns.findFirst({
        where: eq(taskRuns.id, run.id),
        columns: { status: true },
      });
      return !current || isExitedRunStatus(current.status);
    }),
  );
  const stoppedCount = results.filter(Boolean).length;
  return {
    success: stoppedCount === runs.length,
    stoppedCount,
    ...(stoppedCount === runs.length
      ? {}
      : { failedCount: runs.length - stoppedCount }),
  };
}

export async function deleteSessionCommand(
  auth: UserAuthSuccess,
  sessionId: string,
) {
  const readableSession = await findAccessibleSession(auth, sessionId);
  if (!readableSession) {
    return { deleted: false };
  }
  const isPrivate = readableSession.privacy === 'private';
  if (
    isPrivate
      ? readableSession.privateOwnerUserId !== auth.userId
      : !auth.isAdmin && readableSession.ownerUserId !== auth.userId
  ) {
    return { deleted: false };
  }
  const sessionOwnership = isPrivate
    ? and(
        eq(sessions.privacy, 'private'),
        eq(sessions.privateOwnerUserId, auth.userId),
      )
    : auth.isAdmin
      ? eq(sessions.privacy, 'shared')
      : and(
          eq(sessions.privacy, 'shared'),
          eq(sessions.ownerUserId, auth.userId),
        );

  let releaseTurnLock;
  if (readableSession.fastConversationId) {
    const record = await fastAgentConversationRepository.findById({
      id: readableSession.fastConversationId,
    });
    if (record) {
      releaseTurnLock = await acquireFastAgentTurnLock({
        conversation: record.conversation,
        maxWaitMs: 2_000,
      });
      if (!releaseTurnLock) {
        return { deleted: false, reason: 'session_busy' as const };
      }
    }
  }

  try {
    const runsToStop = await db.transaction(async (tx) => {
      const [session] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), sessionOwnership))
        .for('update');
      if (!session) return null;

      const linkedTasks = await tx
        .select({ taskId: sessionTasks.taskId })
        .from(sessionTasks)
        .where(eq(sessionTasks.sessionId, session.id));
      const taskIds = linkedTasks.map(({ taskId }) => taskId);
      if (taskIds.length === 0) return [];

      return tx
        .select({
          id: taskRuns.id,
          taskId: taskRuns.taskId,
          payload: taskRuns.payload,
          status: taskRuns.status,
          sandboxServerUrl: taskRuns.sandboxServerUrl,
          actingUserId: taskRuns.actingUserId,
        })
        .from(taskRuns)
        .where(
          and(
            inArray(taskRuns.taskId, taskIds),
            inArray(taskRuns.status, activeRunStatuses as readonly RunStatus[]),
          ),
        );
    });
    if (!runsToStop) return { deleted: false };

    for (const run of runsToStop) {
      const stopped = await stopTaskRun({
        run,
        authUserId: auth.userId,
        terminate: true,
        allowDirectCancelWithoutSandbox: true,
        cancelledBy: { name: auth.name ?? undefined, source: 'web' },
      }).catch(() => null);
      if (!stopped?.success) {
        const current = await db.query.taskRuns.findFirst({
          where: eq(taskRuns.id, run.id),
          columns: { status: true },
        });
        if (current && !isExitedRunStatus(current.status)) {
          return { deleted: false, reason: 'stop_failed' as const };
        }
      } else if (stopped.mode === 'direct_cancel') {
        void settleLiveTaskMessageOnExit(run, RunStatus.Canceled);
      }

      const deadline = Date.now() + TASK_STOP_WAIT_MS;
      for (;;) {
        const current = await db.query.taskRuns.findFirst({
          where: eq(taskRuns.id, run.id),
          columns: { status: true },
        });
        if (!current || isExitedRunStatus(current.status)) break;
        if (Date.now() >= deadline) {
          return { deleted: false, reason: 'stop_failed' as const };
        }
        await new Promise((resolve) => setTimeout(resolve, TASK_STOP_POLL_MS));
      }
    }

    const prepared = await db.transaction(async (tx) => {
      const [session] = await tx
        .select({
          id: sessions.id,
          fastConversationId: sessions.fastConversationId,
        })
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), sessionOwnership))
        .for('update');
      if (!session) return { deleted: false };

      const linkedTasks = await tx
        .select({ taskId: sessionTasks.taskId })
        .from(sessionTasks)
        .where(eq(sessionTasks.sessionId, session.id));
      const linkedTaskIds = linkedTasks.map(({ taskId }) => taskId);
      const lockedTasks =
        linkedTaskIds.length > 0
          ? await tx
              .select({ id: tasks.id })
              .from(tasks)
              .where(
                and(
                  inArray(tasks.id, linkedTaskIds),
                  isPrivate ? eq(tasks.privacy, 'private') : undefined,
                  isPrivate
                    ? eq(tasks.privateOwnerUserId, auth.userId)
                    : undefined,
                ),
              )
              .orderBy(asc(tasks.id))
              .for('update')
          : [];
      const taskIds = lockedTasks.map(({ id }) => id);
      const activeRuns =
        taskIds.length === 0
          ? []
          : await tx
              .select({ id: taskRuns.id })
              .from(taskRuns)
              .where(
                and(
                  inArray(taskRuns.taskId, taskIds),
                  inArray(
                    taskRuns.status,
                    activeRunStatuses as readonly RunStatus[],
                  ),
                ),
              )
              .limit(1);
      if (activeRuns.length > 0) {
        return { deleted: false, reason: 'stop_failed' as const };
      }
      const artifacts = await tx
        .select({
          id: taskArtifacts.id,
          taskId: taskArtifacts.taskId,
          sessionId: taskArtifacts.sessionId,
          path: taskArtifacts.path,
          version: taskArtifacts.version,
          uploadUrlExpiresAt: taskArtifacts.uploadUrlExpiresAt,
        })
        .from(taskArtifacts)
        .where(
          or(
            eq(taskArtifacts.sessionId, session.id),
            taskIds.length > 0
              ? inArray(taskArtifacts.taskId, taskIds)
              : undefined,
          ),
        );
      const now = new Date();
      const legacyExpiry = new Date(
        now.getTime() + ARTIFACT_UPLOAD_URL_MAX_AGE_SECONDS * 1_000,
      );
      const legacyArtifactIds = artifacts
        .filter(
          (artifact) =>
            artifact.taskId !== null && artifact.uploadUrlExpiresAt === null,
        )
        .map((artifact) => artifact.id);
      if (legacyArtifactIds.length > 0) {
        await tx
          .update(taskArtifacts)
          .set({ uploadUrlExpiresAt: legacyExpiry, updatedAt: now })
          .where(inArray(taskArtifacts.id, legacyArtifactIds));
      }
      const latestExpiry = artifacts.reduce((latest, artifact) => {
        const expiry =
          artifact.uploadUrlExpiresAt ??
          (artifact.taskId === null ? now : legacyExpiry);
        return expiry > latest ? expiry : latest;
      }, now);
      if (latestExpiry > now) {
        return {
          deleted: false,
          retryAfter: latestExpiry.toISOString(),
          reason: 'artifact_uploads_pending' as const,
        };
      }
      return { ready: true as const, session, taskIds, artifacts };
    });

    if (prepared.ready !== true) return prepared;

    let deletion = prepared;
    while (true) {
      const result = await deleteArtifactsBatch(
        deletion.artifacts.map((artifact) => ({
          ...(artifact.taskId
            ? { taskId: artifact.taskId }
            : { sessionId: artifact.sessionId! }),
          artifactId: artifact.id,
          path: artifact.path,
          version: artifact.version,
        })),
      );
      if (result.errors > 0) {
        throw new Error(
          `Failed to delete ${result.errors} session artifact object(s).`,
        );
      }

      if (deletion.artifacts.length > 0) {
        await db
          .delete(taskArtifacts)
          .where(
            or(
              ...deletion.artifacts.map((artifact) =>
                and(
                  eq(taskArtifacts.id, artifact.id),
                  eq(taskArtifacts.version, artifact.version),
                ),
              ),
            ),
          );
        // Rows that changed version or arrived during object deletion remain
        // visible to the final recheck and are deleted on the next loop.
        deletion = { ...deletion, artifacts: [] };
      }

      const finalized = await db.transaction(async (tx) => {
        const [session] = await tx
          .select({
            id: sessions.id,
            fastConversationId: sessions.fastConversationId,
          })
          .from(sessions)
          .where(and(eq(sessions.id, sessionId), sessionOwnership))
          .for('update');
        if (!session) return { deleted: false };

        const linkedTasks = await tx
          .select({ taskId: sessionTasks.taskId })
          .from(sessionTasks)
          .where(eq(sessionTasks.sessionId, session.id));
        const linkedTaskIds = linkedTasks.map(({ taskId }) => taskId).sort();
        const lockedTasks =
          linkedTaskIds.length === 0
            ? []
            : await tx
                .select({ id: tasks.id })
                .from(tasks)
                .where(
                  and(
                    inArray(tasks.id, linkedTaskIds),
                    isPrivate ? eq(tasks.privacy, 'private') : undefined,
                    isPrivate
                      ? eq(tasks.privateOwnerUserId, auth.userId)
                      : undefined,
                  ),
                )
                .orderBy(asc(tasks.id))
                .for('update');
        const taskIds = lockedTasks.map(({ id }) => id);
        if (taskIds.length !== linkedTaskIds.length) {
          return { deleted: false, reason: 'session_changed' as const };
        }

        const activeRuns =
          taskIds.length === 0
            ? []
            : await tx
                .select({ id: taskRuns.id })
                .from(taskRuns)
                .where(
                  and(
                    inArray(taskRuns.taskId, taskIds),
                    inArray(
                      taskRuns.status,
                      activeRunStatuses as readonly RunStatus[],
                    ),
                  ),
                )
                .limit(1);
        if (activeRuns.length > 0) {
          return { deleted: false, reason: 'stop_failed' as const };
        }

        const artifacts = await tx
          .select({
            id: taskArtifacts.id,
            taskId: taskArtifacts.taskId,
            sessionId: taskArtifacts.sessionId,
            path: taskArtifacts.path,
            version: taskArtifacts.version,
            uploadUrlExpiresAt: taskArtifacts.uploadUrlExpiresAt,
          })
          .from(taskArtifacts)
          .where(
            or(
              eq(taskArtifacts.sessionId, session.id),
              taskIds.length > 0
                ? inArray(taskArtifacts.taskId, taskIds)
                : undefined,
            ),
          );
        const now = new Date();
        const latestExpiry = artifacts.reduce(
          (latest, artifact) =>
            artifact.uploadUrlExpiresAt && artifact.uploadUrlExpiresAt > latest
              ? artifact.uploadUrlExpiresAt
              : latest,
          now,
        );
        if (latestExpiry > now) {
          return {
            deleted: false,
            retryAfter: latestExpiry.toISOString(),
            reason: 'artifact_uploads_pending' as const,
          };
        }
        const artifactIds = artifacts.map(({ id }) => id).sort();
        const preparedArtifactIds = deletion.artifacts
          .map(({ id }) => id)
          .sort();
        if (
          taskIds.join('\0') !== deletion.taskIds.join('\0') ||
          artifactIds.join('\0') !== preparedArtifactIds.join('\0')
        ) {
          return { ready: true as const, session, taskIds, artifacts };
        }

        if (taskIds.length > 0) {
          await enqueueTaskMemoryRetirements(tx, taskIds);
          if (isPrivate) {
            await tx
              .delete(tasks)
              .where(
                and(
                  inArray(tasks.id, taskIds),
                  eq(tasks.privacy, 'private'),
                  eq(tasks.privateOwnerUserId, auth.userId),
                ),
              );
          } else {
            await markTaskStartParallelCountsEndedAtForTaskIds(tx, {
              taskIds,
              endedAt: now,
            });
            await tx
              .update(tasks)
              .set({ deletedAt: now, updatedAt: now })
              .where(and(inArray(tasks.id, taskIds), isNull(tasks.deletedAt)));
          }
        }
        if (session.fastConversationId) {
          await enqueueBrainPageRetirements(tx, [
            fastConversationMemorySlug(session.fastConversationId),
          ]);
        }
        await tx.delete(sessions).where(eq(sessions.id, session.id));
        if (session.fastConversationId) {
          await tx
            .delete(fastAgentConversations)
            .where(eq(fastAgentConversations.id, session.fastConversationId));
        }
        return { deleted: true };
      });
      if (finalized.ready !== true) return finalized;
      deletion = finalized;
    }
  } finally {
    await releaseTurnLock?.();
  }
}
const sessionTimelineCursorSchema = z.object({
  at: z.number().nonnegative(),
  seenIdsAtTimestamp: z.array(z.string()),
});
export const sessionTimelineInputSchema = sessionIdInputSchema.extend({
  since: z.union([z.number(), sessionTimelineCursorSchema]).optional(),
  cursor: sessionTimelineCursorSchema.optional(),
});
export const sessionsListInputSchema = z.object({
  scope: z.enum(['all', 'tasks', 'reviews', 'automations']).optional(),
  status: z.enum(SESSION_STATUSES).optional(),
  user: z.string().nullish(),
  repository: z.string().nullish(),
  pullRequest: z.string().nullish(),
  source: z.string().nullish(),
  model: z.string().nullish(),
  period: z.union([z.literal('all'), z.number().int().positive()]).optional(),
  q: z.string().max(200).nullish(),
  ids: z.array(z.string().uuid()).max(20).optional(),
  ownedOnly: z.boolean().optional(),
  before: z.string().nullish(),
  limit: z.number().int().min(1).max(200).optional(),
});

export async function markSessionReadCommand(
  auth: UserAuthSuccess,
  input: {
    sessionId: string;
    throughEventAt?: number;
    throughEventId?: string;
  },
) {
  if (
    input.throughEventAt !== undefined &&
    input.throughEventId !== undefined
  ) {
    if (!(await findAccessibleSession(auth, input.sessionId))) return null;
    return advanceSessionReadCursor(db, {
      sessionId: input.sessionId,
      userId: auth.userId,
      eventAt: input.throughEventAt,
      eventId: input.throughEventId,
    });
  }

  // No explicit cursor: resolve the latest external event server-side so
  // clients can mark a session read without fetching its timeline.
  const latest = await getLatestExternalSessionEvent(auth, input.sessionId);
  if (!latest) return null;
  return advanceSessionReadCursor(db, {
    sessionId: input.sessionId,
    userId: auth.userId,
    eventAt: latest.at,
    eventId: latest.id,
  });
}

export async function getSessionByIdCommand(
  auth: UserAuthSuccess,
  sessionId: string,
) {
  const session = await getSessionById(auth, sessionId);
  if (!session) return null;

  const artifactSignatureTimestamp =
    Math.floor(
      currentEpochSeconds() / ARTIFACT_SIGNATURE_CACHE_WINDOW_SECONDS,
    ) * ARTIFACT_SIGNATURE_CACHE_WINDOW_SECONDS;

  // Session access was already established by getSessionById's scope check,
  // and getSessionTasks inner-joins live tasks only — the previous per-task
  // access resolution had no additional predicate and cost ~5 queries per
  // task on the workspace's polling path.
  const hydrateArtifact = <T extends { id: string; contentType: string }>(
    artifact: T,
  ) => {
    const isImage = artifact.contentType.startsWith('image/');
    const isVideo = artifact.contentType.startsWith('video/');
    const previewUrl =
      isImage || isVideo
        ? `/api/artifacts/${artifact.id}/raw?sig=${signArtifactId(artifact.id, artifactSignatureTimestamp)}&ts=${artifactSignatureTimestamp}`
        : undefined;
    return {
      ...artifact,
      thumbnailUrl: isImage ? previewUrl : undefined,
      previewUrl: isVideo ? previewUrl : undefined,
    };
  };

  return {
    ...session,
    artifacts: (session.artifacts ?? []).map(hydrateArtifact),
    tasks: session.tasks.map((task) => ({
      ...task,
      artifacts: task.artifacts.map(hydrateArtifact),
      canAccessDetails: true as const,
    })),
  };
}

export async function archiveSessionCommand(
  auth: UserAuthSuccess,
  sessionId: string,
) {
  const session = await findAccessibleSession(auth, sessionId);
  if (!canManageSession(auth, session)) {
    return null;
  }

  let releaseTurnLock;
  if (session.fastConversationId) {
    const record = await fastAgentConversationRepository.findById({
      id: session.fastConversationId,
    });
    if (!record) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Session is unavailable. Please try archiving again.',
      });
    }
    // Serialize with reply delivery, without holding a DB transaction over I/O.
    releaseTurnLock = await acquireFastAgentTurnLock({
      conversation: record.conversation,
      maxWaitMs: 2_000,
    });
    if (!releaseTurnLock) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Session is busy. Please try archiving again shortly.',
      });
    }
  }

  try {
    releaseTurnLock?.signal.throwIfAborted();
    const archived = await updateSessionMetadata(auth, sessionId, {
      archivedAt: new Date(),
    });
    if (archived) {
      const goal = await getSessionGoal(sessionId);
      if (goal?.status === 'active') {
        await markSessionGoal({
          sessionId,
          generation: goal.generation,
          status: 'canceled',
        });
      }
      if (archived.fastConversationId) {
        // An archived session must not wake itself up later.
        await cancelSessionWakeupsForConversation(
          archived.fastConversationId,
        ).catch((error) => {
          console.error(
            `[sessions] Failed to cancel wakeups for archived session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      void captureEvent('session_archived', {
        userId: auth.userId,
        properties: { surface: 'web', outcome: 'archived' },
      });
    }
    return archived;
  } finally {
    await releaseTurnLock?.();
  }
}

export {
  getSessionForTask,
  getSessions,
  getSessionTimeline,
  listSessionPins,
  setSessionPinned,
  updateSessionMetadata,
};
