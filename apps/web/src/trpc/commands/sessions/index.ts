import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  acquireFastAgentTurnLock,
  fastAgentConversationRepository,
} from '@roomote/cloud-agents/server';
import { SESSION_STATUSES } from '@roomote/types';
import {
  advanceSessionReadCursor,
  cancelSessionWakeupsForConversation,
  db,
} from '@roomote/db/server';
import { captureEvent } from '@roomote/telemetry/server';

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

// Keep polled session payloads stable for the raw route's one-hour cache lifetime.
const ARTIFACT_SIGNATURE_CACHE_WINDOW_SECONDS = 60 * 60;

export const sessionIdInputSchema = z.object({ sessionId: z.string().uuid() });
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
  if (!session || (!auth.isAdmin && session.ownerUserId !== auth.userId)) {
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
