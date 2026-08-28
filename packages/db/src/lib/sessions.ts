import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';

import type { TaskGoalStatus, TaskState } from '@roomote/types';

import type { DatabaseOrTransaction } from '../db';
import {
  sessionParticipants,
  sessions,
  sessionTasks,
  fastAgentConversations,
  taskRuns,
  tasks,
  type SessionStatus,
  type SessionTaskOrigin,
} from '../schema';
import type { Session } from '../types';

import { runInTransactionIfAvailable } from './transaction-utils';

export type SessionStatusInput = {
  conversationResponding: boolean;
  tasks: Array<{
    state: TaskState;
    taskPhase: string | null;
    goalStatus: TaskGoalStatus | null;
  }>;
};

export function deriveSessionStatus(input: SessionStatusInput): SessionStatus {
  if (
    input.tasks.some(
      (task) =>
        task.state === 'active' && task.taskPhase === 'waiting_for_user_input',
    )
  ) {
    return 'needs_input';
  }

  if (
    input.conversationResponding ||
    input.tasks.some((task) => task.state === 'active')
  ) {
    return 'active';
  }

  if (
    input.tasks.some(
      (task) =>
        task.state === 'failed' ||
        task.goalStatus === 'blocked' ||
        task.goalStatus === 'budget_limited',
    )
  ) {
    return 'blocked';
  }

  return 'ready';
}

export function isSessionConversationResponding(
  session: Pick<Session, 'respondingUntil'>,
  now: Date = new Date(),
): boolean {
  return (
    session.respondingUntil !== null &&
    session.respondingUntil.getTime() > now.getTime()
  );
}

export async function touchSessionActivity(
  dbOrTx: DatabaseOrTransaction,
  sessionId: string,
  at: number,
  options: {
    /**
     * Set (a future timestamp) or clear (null) the conversation-responding
     * lease. When omitted, the stored lease decides whether the conversation
     * counts as responding during status recomputation.
     */
    respondingUntil?: Date | null;
    recomputeStatus?: boolean;
  } = {},
): Promise<Session> {
  return runInTransactionIfAvailable(dbOrTx, async (tx) => {
    const [lockedSession] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .for('update');

    if (!lockedSession) {
      throw new Error(`Session ${sessionId} does not exist.`);
    }

    return refreshLockedSession(tx, lockedSession, at, options);
  });
}

async function refreshLockedSession(
  tx: DatabaseOrTransaction,
  lockedSession: Session,
  at: number,
  options: { respondingUntil?: Date | null; recomputeStatus?: boolean },
): Promise<Session> {
  const respondingUntil =
    options.respondingUntil !== undefined
      ? options.respondingUntil
      : lockedSession.respondingUntil;

  let cachedStatus = lockedSession.cachedStatus;
  if (options.recomputeStatus !== false) {
    const linkedTasks = await tx
      .selectDistinctOn([tasks.id], {
        state: tasks.state,
        taskPhase: taskRuns.taskPhase,
        goalStatus: tasks.goalStatus,
      })
      .from(sessionTasks)
      .innerJoin(tasks, eq(tasks.id, sessionTasks.taskId))
      .leftJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
      .where(
        and(
          eq(sessionTasks.sessionId, lockedSession.id),
          isNull(tasks.deletedAt),
        ),
      )
      .orderBy(tasks.id, desc(taskRuns.id));

    cachedStatus = deriveSessionStatus({
      conversationResponding: isSessionConversationResponding({
        respondingUntil,
      }),
      tasks: linkedTasks,
    });
  }

  const nothingChanged =
    at <= lockedSession.activityAt &&
    cachedStatus === lockedSession.cachedStatus &&
    options.respondingUntil === undefined;
  if (nothingChanged) {
    return lockedSession;
  }

  const [updated] = await tx
    .update(sessions)
    .set({
      activityAt: sql`GREATEST(${sessions.activityAt}, ${at})`,
      cachedStatus,
      respondingUntil,
      updatedAt: new Date(),
    })
    .where(eq(sessions.id, lockedSession.id))
    .returning();

  if (!updated) {
    throw new Error(`Session ${lockedSession.id} does not exist.`);
  }

  return updated;
}

export type EnsureSessionForTaskInput = {
  taskId: string;
  fastConversationId?: string | null;
  origin?: SessionTaskOrigin;
  existingTaskReused?: boolean;
};

export async function ensureSessionForFastConversation(
  tx: DatabaseOrTransaction,
  fastConversationId: string,
): Promise<Session> {
  const [conversation] = await tx
    .select({
      id: fastAgentConversations.id,
      userId: fastAgentConversations.userId,
      surface: fastAgentConversations.surface,
      title: fastAgentConversations.title,
      updatedAt: fastAgentConversations.updatedAt,
    })
    .from(fastAgentConversations)
    .where(eq(fastAgentConversations.id, fastConversationId))
    .for('update');

  if (!conversation) {
    throw new Error(`Fast conversation ${fastConversationId} does not exist.`);
  }

  const existing = await getSessionForFastConversation(tx, conversation.id);
  if (existing) {
    return existing;
  }

  const activityAt = Math.floor(conversation.updatedAt.getTime() / 1000);
  const [inserted] = await tx
    .insert(sessions)
    .values({
      title: conversation.title?.trim() || 'New session',
      ownerKind: 'user',
      ownerUserId: conversation.userId,
      sourceSurface: conversation.surface,
      sourceTrigger:
        conversation.surface === 'automation' ? 'schedule' : 'message',
      fastConversationId: conversation.id,
      visibility: 'visible',
      activityAt,
      cachedStatus: 'ready',
    })
    .onConflictDoNothing()
    .returning();

  const session =
    inserted ?? (await getSessionForFastConversation(tx, conversation.id));
  if (!session) {
    throw new Error(
      `Failed to create a Session for Fast conversation ${conversation.id}.`,
    );
  }

  await tx
    .insert(sessionParticipants)
    .values({
      sessionId: session.id,
      userId: conversation.userId,
      role: 'owner',
    })
    .onConflictDoNothing();

  return session;
}

/**
 * Ensures a visible task has one canonical Session inside the caller's
 * transaction. The tables are additive and ignored by N-1 application code.
 */
export async function ensureSessionForTask(
  tx: DatabaseOrTransaction,
  input: EnsureSessionForTaskInput,
): Promise<Session | null> {
  const [task] = await tx
    .select({
      id: tasks.id,
      title: tasks.title,
      state: tasks.state,
      goalStatus: tasks.goalStatus,
      initiatorKind: tasks.initiatorKind,
      initiatorUserId: tasks.initiatorUserId,
      initiatorAutomation: tasks.initiatorAutomation,
      surface: tasks.surface,
      trigger: tasks.trigger,
      visibility: tasks.visibility,
      activityAt: tasks.activityAt,
    })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .for('update');

  if (!task) {
    throw new Error(`Task ${input.taskId} does not exist.`);
  }

  if (task.visibility !== 'visible') {
    return null;
  }

  const existing = await getSessionForTask(tx, task.id);
  if (existing) {
    return existing;
  }

  let session = input.fastConversationId
    ? await getSessionForFastConversation(tx, input.fastConversationId)
    : null;
  let createdCandidate = false;

  if (!session) {
    const owner =
      task.initiatorKind === 'user' && task.initiatorUserId
        ? {
            ownerKind: 'user' as const,
            ownerUserId: task.initiatorUserId,
            ownerAutomation: null,
          }
        : task.initiatorKind === 'automation' && task.initiatorAutomation
          ? {
              ownerKind: 'automation' as const,
              ownerUserId: null,
              ownerAutomation: task.initiatorAutomation,
            }
          : {
              ownerKind: 'system' as const,
              ownerUserId: null,
              ownerAutomation: null,
            };

    const [inserted] = await tx
      .insert(sessions)
      .values({
        title: task.title,
        ...owner,
        sourceSurface: task.surface,
        sourceTrigger: task.trigger,
        fastConversationId: input.fastConversationId ?? null,
        visibility: task.visibility,
        activityAt: task.activityAt,
        cachedStatus: deriveSessionStatus({
          conversationResponding: false,
          tasks: [
            {
              state: task.state,
              taskPhase: null,
              goalStatus: task.goalStatus,
            },
          ],
        }),
      })
      .onConflictDoNothing()
      .returning();

    session =
      inserted ??
      (input.fastConversationId
        ? await getSessionForFastConversation(tx, input.fastConversationId)
        : null);
    createdCandidate = inserted !== undefined;
  }

  if (!session) {
    throw new Error(`Failed to create a Session for task ${task.id}.`);
  }

  const [attached] = await tx
    .insert(sessionTasks)
    .values({
      sessionId: session.id,
      taskId: task.id,
      origin: input.origin ?? 'direct_launch',
    })
    .onConflictDoNothing({ target: sessionTasks.taskId })
    .returning({ sessionId: sessionTasks.sessionId });

  if (!attached) {
    const canonical = await getSessionForTask(tx, task.id);
    if (!canonical) {
      throw new Error(`Failed to attach task ${task.id} to a Session.`);
    }

    if (createdCandidate && canonical.id !== session.id) {
      await tx.delete(sessions).where(eq(sessions.id, session.id));
    }

    return touchSessionActivity(tx, canonical.id, task.activityAt);
  }

  if (session.ownerUserId) {
    await tx
      .insert(sessionParticipants)
      .values({
        sessionId: session.id,
        userId: session.ownerUserId,
        role: 'owner',
      })
      .onConflictDoNothing();
  }

  return touchSessionActivity(tx, session.id, task.activityAt);
}

export async function getSessionForTask(
  tx: DatabaseOrTransaction,
  taskId: string,
): Promise<Session | null> {
  const [session] = await tx
    .select({ session: sessions })
    .from(sessionTasks)
    .innerJoin(sessions, eq(sessions.id, sessionTasks.sessionId))
    .where(eq(sessionTasks.taskId, taskId))
    .limit(1);

  return session?.session ?? null;
}

export async function getSessionForFastConversation(
  tx: DatabaseOrTransaction,
  fastConversationId: string,
): Promise<Session | null> {
  const [session] = await tx
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.fastConversationId, fastConversationId),
        eq(sessions.visibility, 'visible'),
      ),
    )
    .limit(1);

  return session ?? null;
}

export async function touchSessionForTask(
  tx: DatabaseOrTransaction,
  taskId: string,
  at: number,
): Promise<Session | null> {
  const session = await getSessionForTask(tx, taskId);
  return session ? touchSessionActivity(tx, session.id, at) : null;
}

export async function advanceSessionReadCursor(
  dbOrTx: DatabaseOrTransaction,
  input: {
    sessionId: string;
    userId: string;
    eventAt: number;
    eventId: string;
  },
) {
  return runInTransactionIfAvailable(dbOrTx, async (tx) => {
    const [lockedSession] = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .for('update');
    if (!lockedSession) {
      throw new Error(`Session ${input.sessionId} does not exist.`);
    }

    const [participant] = await tx
      .insert(sessionParticipants)
      .values({
        sessionId: input.sessionId,
        userId: input.userId,
        role: 'member',
        lastReadEventAt: input.eventAt,
        lastReadEventId: input.eventId,
      })
      .onConflictDoUpdate({
        target: [sessionParticipants.sessionId, sessionParticipants.userId],
        set: {
          lastReadEventAt: input.eventAt,
          lastReadEventId: input.eventId,
          updatedAt: new Date(),
        },
        setWhere: or(
          sql`${sessionParticipants.lastReadEventAt} IS NULL`,
          sql`${sessionParticipants.lastReadEventAt} < ${input.eventAt}`,
          and(
            eq(sessionParticipants.lastReadEventAt, input.eventAt),
            or(
              sql`${sessionParticipants.lastReadEventId} IS NULL`,
              sql`${sessionParticipants.lastReadEventId} < ${input.eventId}`,
            ),
          ),
        ),
      })
      .returning();

    if (participant) return participant;

    const [current] = await tx
      .select()
      .from(sessionParticipants)
      .where(
        and(
          eq(sessionParticipants.sessionId, input.sessionId),
          eq(sessionParticipants.userId, input.userId),
        ),
      );
    if (!current) {
      throw new Error('Failed to advance Session read cursor.');
    }
    return current;
  });
}

export async function advanceSessionNotifiedCursor(
  tx: DatabaseOrTransaction,
  input: { sessionId: string; eventAt: number; eventId: string },
): Promise<void> {
  await tx
    .update(sessionParticipants)
    .set({
      lastNotifiedEventAt: input.eventAt,
      lastNotifiedEventId: input.eventId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessionParticipants.sessionId, input.sessionId),
        or(
          sql`${sessionParticipants.lastNotifiedEventAt} IS NULL`,
          sql`${sessionParticipants.lastNotifiedEventAt} < ${input.eventAt}`,
          and(
            eq(sessionParticipants.lastNotifiedEventAt, input.eventAt),
            or(
              sql`${sessionParticipants.lastNotifiedEventId} IS NULL`,
              sql`${sessionParticipants.lastNotifiedEventId} < ${input.eventId}`,
            ),
          ),
        ),
      ),
    );
}
