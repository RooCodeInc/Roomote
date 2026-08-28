import {
  and,
  db,
  desc,
  ensureSessionForFastConversation,
  ensureSessionForTask,
  eq,
  fastAgentConversations,
  gt,
  inArray,
  isNull,
  lt,
  or,
  sessionBackfillState,
  sessions,
  sessionTasks,
  sql,
  taskRuns,
  tasks,
  touchSessionActivity,
} from '@roomote/db/server';
const LOG_PREFIX = '[sessions]';
const BACKFILL_KEY = 'unified-sessions-v1';
/**
 * Steady-state reconcile watermark, stored as a second state row: its
 * cursorCreatedAt marks the scan-start time of the last orphan pass that
 * completed with ZERO failures. Advancing only on clean passes means a
 * transient outage keeps failed rows inside the scan window until they
 * actually converge, instead of stranding them past the cutoff forever.
 */
const RECONCILE_KEY = 'unified-sessions-reconcile-v1';
const RECONCILE_CURSOR_ID = 'watermark';
const BATCH_SIZE = 100;
/** Slack subtracted from the last-run watermark when bounding orphan scans. */
const ORPHAN_SCAN_SLACK_MS = 60 * 60 * 1000;

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
    try {
      await db.transaction((tx) =>
        ensureSessionForFastConversation(tx, row.id),
      );
    } catch (error) {
      console.error(
        `${LOG_PREFIX} backfill failed for fast conversation ${row.id}`,
        error,
      );
    }
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
    try {
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
    } catch (error) {
      console.error(`${LOG_PREFIX} backfill failed for task ${row.id}`, error);
    }
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

async function reconcileRecentSessions(watermark: Date | null): Promise<void> {
  // Bound the steady-state orphan scans to rows created since the last
  // fully-successful pass (with slack) so they stop scanning entire tables
  // every run. A null watermark (first run, or no clean pass yet) scans
  // unbounded.
  const cutoff = watermark
    ? new Date(watermark.getTime() - ORPHAN_SCAN_SLACK_MS)
    : null;
  const scanStartedAt = new Date();
  let orphanFailures = 0;

  // Fast conversations without a session row (e.g. created before this
  // release finished its backfill) are adopted here so the unified list
  // converges without another full backfill.
  const orphanConversations = await db
    .select({ id: fastAgentConversations.id })
    .from(fastAgentConversations)
    .leftJoin(
      sessions,
      eq(sessions.fastConversationId, fastAgentConversations.id),
    )
    .where(
      and(
        isNull(sessions.id),
        cutoff ? gt(fastAgentConversations.createdAt, cutoff) : undefined,
      ),
    )
    .orderBy(desc(fastAgentConversations.updatedAt))
    .limit(BATCH_SIZE);

  for (const conversation of orphanConversations) {
    try {
      await db.transaction((tx) =>
        ensureSessionForFastConversation(tx, conversation.id),
      );
    } catch (error) {
      orphanFailures += 1;
      console.error(
        `${LOG_PREFIX} reconcile failed for fast conversation ${conversation.id}`,
        error,
      );
    }
  }

  const orphanTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .leftJoin(sessionTasks, eq(sessionTasks.taskId, tasks.id))
    .where(
      and(
        eq(tasks.visibility, 'visible'),
        isNull(tasks.deletedAt),
        isNull(sessionTasks.taskId),
        cutoff ? gt(tasks.createdAt, cutoff) : undefined,
      ),
    )
    .orderBy(desc(tasks.activityAt))
    .limit(BATCH_SIZE);

  for (const task of orphanTasks) {
    try {
      await db.transaction((tx) =>
        ensureSessionForTask(tx, { taskId: task.id, origin: 'backfill' }),
      );
    } catch (error) {
      orphanFailures += 1;
      console.error(
        `${LOG_PREFIX} reconcile failed for task ${task.id}`,
        error,
      );
    }
  }

  const recent = await db
    .select({ id: sessions.id, activityAt: sessions.activityAt })
    .from(sessions)
    .where(eq(sessions.visibility, 'visible'))
    .orderBy(desc(sessions.activityAt))
    .limit(BATCH_SIZE);
  for (const session of recent) {
    try {
      await touchSessionActivity(db, session.id, session.activityAt);
    } catch (error) {
      console.error(
        `${LOG_PREFIX} refresh failed for session ${session.id}`,
        error,
      );
    }
  }

  // Sessions stuck 'active'/'needs_input' on an expired (or missing) lease
  // may be older than the top-100-by-activity window; heal them explicitly
  // so wedged sessions converge regardless of recency.
  const expiredLeases = await db
    .select({ id: sessions.id, activityAt: sessions.activityAt })
    .from(sessions)
    .where(
      and(
        eq(sessions.visibility, 'visible'),
        inArray(sessions.cachedStatus, ['active', 'needs_input']),
        or(
          isNull(sessions.respondingUntil),
          lt(sessions.respondingUntil, new Date()),
        ),
      ),
    )
    .limit(BATCH_SIZE);
  for (const session of expiredLeases) {
    try {
      await touchSessionActivity(db, session.id, session.activityAt);
    } catch (error) {
      console.error(
        `${LOG_PREFIX} lease heal failed for session ${session.id}`,
        error,
      );
    }
  }

  // Advance the watermark only when every orphan adoption succeeded, so
  // transiently-failed rows stay inside the next scan window and eventually
  // converge. Failures in the touch/heal loops don't affect orphan scanning.
  if (orphanFailures === 0) {
    await db
      .insert(sessionBackfillState)
      .values({
        key: RECONCILE_KEY,
        phase: 'participants',
        cursorCreatedAt: scanStartedAt,
        cursorId: RECONCILE_CURSOR_ID,
        completedAt: null,
        lastRunAt: scanStartedAt,
      })
      .onConflictDoUpdate({
        target: sessionBackfillState.key,
        set: {
          cursorCreatedAt: scanStartedAt,
          cursorId: RECONCILE_CURSOR_ID,
          lastRunAt: scanStartedAt,
          updatedAt: new Date(),
        },
      });
  } else {
    console.warn(
      `${LOG_PREFIX} keeping the reconcile watermark: ${orphanFailures} orphan adoption(s) failed`,
    );
  }

  console.info(`${LOG_PREFIX} reconciliation`, {
    orphanFastConversations: orphanConversations.length,
    orphanVisibleTasks: orphanTasks.length,
    refreshedSessions: recent.length,
    healedExpiredLeases: expiredLeases.length,
  });
}

export async function sessionsReconcileJob(): Promise<void> {
  const state = await db.query.sessionBackfillState.findFirst({
    where: eq(sessionBackfillState.key, BACKFILL_KEY),
  });
  if (state?.completedAt) {
    const reconcileState = await db.query.sessionBackfillState.findFirst({
      where: eq(sessionBackfillState.key, RECONCILE_KEY),
    });
    await reconcileRecentSessions(reconcileState?.cursorCreatedAt ?? null);
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
  // 'fast_tasks' is the pre-rename name of the tasks phase; deployments that
  // ran an earlier build of this branch may still be parked there.
  if (
    phase === 'fast_conversations' ||
    phase === 'fast_tasks' ||
    phase === 'tasks'
  ) {
    const complete = await backfillTasks(
      phase === 'fast_tasks' || phase === 'tasks' ? cursor : null,
    );
    if (!complete) return;
  }
  await backfillParticipants();
}
