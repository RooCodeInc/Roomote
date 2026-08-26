import { and, desc, eq, sql } from 'drizzle-orm';

import type { TaskGoalStatus, TaskState } from '@roomote/types';

import type { DatabaseOrTransaction } from '../db';
import {
  sessionParticipants,
  sessions,
  sessionTasks,
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

export async function touchSessionActivity(
  dbOrTx: DatabaseOrTransaction,
  sessionId: string,
  at: number,
  options: { conversationResponding?: boolean } = {},
): Promise<Session> {
  return runInTransactionIfAvailable(dbOrTx, async (tx) => {
    const [lockedSession] = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .for('update');

    if (!lockedSession) {
      throw new Error(`Session ${sessionId} does not exist.`);
    }

    return refreshLockedSession(tx, sessionId, at, options);
  });
}

async function refreshLockedSession(
  tx: DatabaseOrTransaction,
  sessionId: string,
  at: number,
  options: { conversationResponding?: boolean },
): Promise<Session> {
  const linkedTasks = await tx
    .selectDistinctOn([tasks.id], {
      state: tasks.state,
      taskPhase: taskRuns.taskPhase,
      goalStatus: tasks.goalStatus,
    })
    .from(sessionTasks)
    .innerJoin(tasks, eq(tasks.id, sessionTasks.taskId))
    .leftJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(eq(sessionTasks.sessionId, sessionId))
    .orderBy(tasks.id, desc(taskRuns.id));

  const [updated] = await tx
    .update(sessions)
    .set({
      activityAt: sql`GREATEST(${sessions.activityAt}, ${at})`,
      cachedStatus: deriveSessionStatus({
        conversationResponding: options.conversationResponding ?? false,
        tasks: linkedTasks,
      }),
      updatedAt: new Date(),
    })
    .where(eq(sessions.id, sessionId))
    .returning();

  if (!updated) throw new Error(`Session ${sessionId} does not exist.`);

  return updated;
}

export type EnsureSessionForTaskInput = {
  taskId: string;
  fastConversationId?: string | null;
  origin?: SessionTaskOrigin;
  existingTaskReused?: boolean;
};

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

  const existing = await findSessionForTask(tx, task.id);
  if (existing) {
    return existing;
  }

  let session = input.fastConversationId
    ? await findSessionForFastConversation(tx, input.fastConversationId)
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
        ? await findSessionForFastConversation(tx, input.fastConversationId)
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
    const canonical = await findSessionForTask(tx, task.id);
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

async function findSessionForTask(
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

async function findSessionForFastConversation(
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
