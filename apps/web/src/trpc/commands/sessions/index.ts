import { z } from 'zod';
import { SESSION_STATUSES } from '@roomote/types';
import { advanceSessionReadCursor, db } from '@roomote/db/server';
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
import { resolveTaskByIdAccessCommand } from '../tasks/by-id';

export const sessionIdInputSchema = z.object({ sessionId: z.string().uuid() });
export const sessionsListInputSchema = z.object({
  scope: z.enum(['all', 'tasks', 'reviews', 'automations']).optional(),
  status: z.enum(SESSION_STATUSES).optional(),
  user: z.string().nullish(),
  repository: z.string().nullish(),
  environment: z.string().nullish(),
  pullRequest: z.string().nullish(),
  source: z.string().nullish(),
  model: z.string().nullish(),
  period: z.union([z.literal('all'), z.number().int().positive()]).optional(),
  q: z.string().max(200).nullish(),
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

  const taskAccess = await Promise.all(
    session.tasks.map((task) =>
      resolveTaskByIdAccessCommand(auth, {
        taskId: task.taskId,
        includeArtifacts: true,
      }),
    ),
  );

  return {
    ...session,
    tasks: session.tasks.map((task, index) =>
      taskAccess[index]?.kind === 'resolved'
        ? { ...task, canAccessDetails: true as const }
        : {
            ...task,
            canAccessDetails: false as const,
            latestRun: null,
            latestOutput: null,
            inferenceCostMicroUsd: 0,
            artifacts: [],
            pullRequests: [],
          },
    ),
  };
}

export async function archiveSessionCommand(
  auth: UserAuthSuccess,
  sessionId: string,
) {
  const archived = await updateSessionMetadata(auth, sessionId, {
    archivedAt: new Date(),
  });
  if (archived) {
    void captureEvent('session_archived', {
      userId: auth.userId,
      properties: { surface: 'web', outcome: 'archived' },
    });
  }
  return archived;
}

export {
  getSessionForTask,
  getSessions,
  getSessionTimeline,
  listSessionPins,
  setSessionPinned,
  updateSessionMetadata,
};
