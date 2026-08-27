import {
  and,
  db,
  desc,
  ensureSessionForFastConversation,
  ensureSessionForTask,
  eq,
  fastAgentConversations,
  gt,
  isNull,
  or,
  sessionBackfillState,
  sessions,
  sessionTasks,
  sql,
  taskRuns,
  tasks,
  touchSessionActivity,
} from '@roomote/db/server';
import {
  evaluateDeploymentFeatureFlag,
  FeatureFlag,
} from '@roomote/feature-flags/server';

const LOG_PREFIX = '[sessions]';
const BACKFILL_KEY = 'unified-sessions-v1';
const BATCH_SIZE = 100;

type Cursor = { createdAt: Date; id: string } | null;

function afterCursor<TCreatedAt, TId>(
  createdAt: TCreatedAt,
  id: TId,
  cursor: Cursor,
) {
  return cursor
    ? or(
        gt(createdAt as never, cursor.createdAt),
        and(
          eq(createdAt as never, cursor.createdAt),
          gt(id as never, cursor.id),
        ),
      )
    : undefined;
}

async function updateState(input: {
  phase: 'fast_conversations' | 'tasks' | 'participants';
  cursor?: Cursor;
  completed?: boolean;
}) {
  await db
    .insert(sessionBackfillState)
    .values({
      key: BACKFILL_KEY,
      phase: input.phase,
      cursorCreatedAt: input.cursor?.createdAt ?? null,
      cursorId: input.cursor?.id ?? null,
      completedAt: input.completed ? new Date() : null,
      lastRunAt: new Date(),
    })
    .onConflictDoUpdate({
      target: sessionBackfillState.key,
      set: {
        phase: input.phase,
        cursorCreatedAt: input.cursor?.createdAt ?? null,
        cursorId: input.cursor?.id ?? null,
        completedAt: input.completed ? new Date() : null,
        lastRunAt: new Date(),
        updatedAt: new Date(),
      },
    });
}

async function backfillFastConversations(cursor: Cursor): Promise<boolean> {
  const rows = await db
    .select({
      id: fastAgentConversations.id,
      createdAt: fastAgentConversations.createdAt,
    })
    .from(fastAgentConversations)
    .leftJoin(
      sessions,
      eq(sessions.fastConversationId, fastAgentConversations.id),
    )
    .where(
      and(
        isNull(sessions.id),
        afterCursor(
          fastAgentConversations.createdAt,
          fastAgentConversations.id,
          cursor,
        ),
      ),
    )
    .orderBy(fastAgentConversations.createdAt, fastAgentConversations.id)
    .limit(BATCH_SIZE);

  for (const row of rows) {
    await db.transaction((tx) => ensureSessionForFastConversation(tx, row.id));
  }

  const last = rows.at(-1);
  await updateState({
    phase: last && rows.length === BATCH_SIZE ? 'fast_conversations' : 'tasks',
    cursor:
      last && rows.length === BATCH_SIZE
        ? { createdAt: last.createdAt, id: last.id }
        : null,
  });
  console.info(`${LOG_PREFIX} backfill fast conversations`, {
    processed: rows.length,
  });
  return rows.length < BATCH_SIZE;
}

async function backfillTasks(cursor: Cursor): Promise<boolean> {
  const rows = await db
    .select({ id: tasks.id, createdAt: tasks.createdAt })
    .from(tasks)
    .leftJoin(sessionTasks, eq(sessionTasks.taskId, tasks.id))
    .where(
      and(
        eq(tasks.visibility, 'visible'),
        isNull(tasks.deletedAt),
        isNull(sessionTasks.taskId),
        afterCursor(tasks.createdAt, tasks.id, cursor),
      ),
    )
    .orderBy(tasks.createdAt, tasks.id)
    .limit(BATCH_SIZE);

  for (const row of rows) {
    const latestFastRun = await db.query.taskRuns.findFirst({
      where: and(
        eq(taskRuns.taskId, row.id),
        sql`${taskRuns.fastAgentSessionId} IS NOT NULL`,
      ),
      columns: { fastAgentSessionId: true },
      orderBy: desc(taskRuns.id),
    });
    await db.transaction((tx) =>
      ensureSessionForTask(tx, {
        taskId: row.id,
        fastConversationId: latestFastRun?.fastAgentSessionId ?? null,
        origin: 'backfill',
      }),
    );
  }

  const last = rows.at(-1);
  await updateState({
    phase: last && rows.length === BATCH_SIZE ? 'tasks' : 'participants',
    cursor:
      last && rows.length === BATCH_SIZE
        ? { createdAt: last.createdAt, id: last.id }
        : null,
  });
  console.info(`${LOG_PREFIX} backfill tasks`, { processed: rows.length });
  return rows.length < BATCH_SIZE;
}

async function backfillParticipants(): Promise<void> {
  await db.execute(sql`
    INSERT INTO session_participants (session_id, user_id, role)
    SELECT DISTINCT s.id, fam.metadata->>'userId', 'member'
    FROM sessions s
    JOIN fast_agent_messages fam ON fam.conversation_id = s.fast_conversation_id
    JOIN users u ON u.id = fam.metadata->>'userId' AND u.deleted_at IS NULL
    WHERE fam.metadata->>'userId' IS NOT NULL
    ON CONFLICT (session_id, user_id) DO NOTHING
  `);
  await updateState({ phase: 'participants', completed: true });
  console.info(`${LOG_PREFIX} backfill participants complete`);
}

async function reconcileRecentSessions(): Promise<void> {
  const orphanTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .leftJoin(sessionTasks, eq(sessionTasks.taskId, tasks.id))
    .where(
      and(
        eq(tasks.visibility, 'visible'),
        isNull(tasks.deletedAt),
        isNull(sessionTasks.taskId),
      ),
    )
    .orderBy(desc(tasks.activityAt))
    .limit(BATCH_SIZE);

  for (const task of orphanTasks) {
    await db.transaction((tx) =>
      ensureSessionForTask(tx, { taskId: task.id, origin: 'backfill' }),
    );
  }

  const recent = await db
    .select({ id: sessions.id, activityAt: sessions.activityAt })
    .from(sessions)
    .where(eq(sessions.visibility, 'visible'))
    .orderBy(desc(sessions.activityAt))
    .limit(BATCH_SIZE);
  for (const session of recent) {
    await touchSessionActivity(db, session.id, session.activityAt);
  }

  console.info(`${LOG_PREFIX} reconciliation`, {
    orphanVisibleTasks: orphanTasks.length,
    refreshedSessions: recent.length,
  });
}

export async function sessionsReconcileJob(): Promise<void> {
  const enabled = await evaluateDeploymentFeatureFlag(FeatureFlag.SessionsData);
  if (!enabled) return;

  const state = await db.query.sessionBackfillState.findFirst({
    where: eq(sessionBackfillState.key, BACKFILL_KEY),
  });
  if (state?.completedAt) {
    await reconcileRecentSessions();
    return;
  }

  const phase = state?.phase ?? 'fast_conversations';
  const cursor =
    state?.cursorCreatedAt && state.cursorId
      ? { createdAt: state.cursorCreatedAt, id: state.cursorId }
      : null;

  if (phase === 'fast_conversations') {
    const complete = await backfillFastConversations(cursor);
    if (!complete) return;
  }
  if (
    phase === 'fast_conversations' ||
    phase === 'fast_tasks' ||
    phase === 'tasks'
  ) {
    const complete = await backfillTasks(phase === 'tasks' ? cursor : null);
    if (!complete) return;
  }
  await backfillParticipants();
}
