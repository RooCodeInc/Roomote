import {
  RunStatus,
  activeRunStatuses,
  isSnapshotResumable,
  type CommunicationProvider,
} from '@roomote/types';
import {
  and,
  asc,
  db,
  desc,
  eq,
  inArray,
  isNull,
  sql,
  taskRuns,
  tasks,
  trackedMessages,
} from '@roomote/db/server';

type CommunicationConversationRef = {
  provider: CommunicationProvider;
  channelId: string;
  threadId?: string;
  taskId?: string;
};

const ACTIVE_SELECTION = {
  id: taskRuns.id,
  initiatorUserId: tasks.initiatorUserId,
  actingUserId: taskRuns.actingUserId,
  payloadKind: taskRuns.payloadKind,
  status: taskRuns.status,
  machineId: taskRuns.machineId,
  taskId: taskRuns.taskId,
  payload: taskRuns.payload,
  port: taskRuns.port,
  snapshotId: taskRuns.snapshotId,
  snapshotCreatedAt: taskRuns.snapshotCreatedAt,
};

const SNAPSHOT_SELECTION = {
  id: taskRuns.id,
  initiatorUserId: tasks.initiatorUserId,
  actingUserId: taskRuns.actingUserId,
  payloadKind: taskRuns.payloadKind,
  status: taskRuns.status,
  taskId: taskRuns.taskId,
  payload: taskRuns.payload,
  port: taskRuns.port,
  snapshotId: taskRuns.snapshotId,
  snapshotCreatedAt: taskRuns.snapshotCreatedAt,
};

function withResolvedUserId<
  T extends { initiatorUserId: string | null; actingUserId: string | null },
>(row: T) {
  const { initiatorUserId, actingUserId, ...rest } = row;
  return { ...rest, userId: initiatorUserId ?? actingUserId };
}

function buildMatchConditions(input: CommunicationConversationRef) {
  const providerMatch = sql`${taskRuns.payload}->>'communicationProvider' = ${input.provider}`;
  const conversationMatch = sql`${taskRuns.payload}->>'communicationChannelId' = ${input.channelId}`;
  const threadMatch = input.threadId
    ? sql`${taskRuns.payload}->>'communicationThreadId' = ${input.threadId}`
    : sql`${taskRuns.payload}->>'communicationThreadId' IS NULL`;
  return { providerMatch, conversationMatch, threadMatch };
}

export async function findActiveCommunicationTaskRun(
  input: CommunicationConversationRef,
) {
  const { providerMatch, conversationMatch, threadMatch } =
    buildMatchConditions(input);
  const [row] = await db
    .select(ACTIVE_SELECTION)
    .from(taskRuns)
    .innerJoin(tasks, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        providerMatch,
        conversationMatch,
        threadMatch,
        ...(input.taskId ? [eq(taskRuns.taskId, input.taskId)] : []),
        inArray(taskRuns.status, [...activeRunStatuses]),
        isNull(taskRuns.canceledAt),
        isNull(tasks.deletedAt),
      ),
    )
    .orderBy(desc(taskRuns.createdAt))
    .limit(1);
  return row ? withResolvedUserId(row) : undefined;
}

export async function findCompletedCommunicationTaskRunWithSnapshot(
  input: CommunicationConversationRef,
) {
  const { providerMatch, conversationMatch, threadMatch } =
    buildMatchConditions(input);
  const [row] = await db
    .select(SNAPSHOT_SELECTION)
    .from(taskRuns)
    .innerJoin(tasks, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        providerMatch,
        conversationMatch,
        threadMatch,
        ...(input.taskId ? [eq(taskRuns.taskId, input.taskId)] : []),
        inArray(taskRuns.status, [RunStatus.Completed]),
        isNull(taskRuns.canceledAt),
        isNull(tasks.deletedAt),
        sql`${taskRuns.snapshotId} IS NOT NULL`,
        sql`${taskRuns.snapshotCreatedAt} IS NOT NULL`,
      ),
    )
    .orderBy(desc(taskRuns.createdAt))
    .limit(1);

  if (!row?.snapshotId || !isSnapshotResumable(row.snapshotCreatedAt)) {
    return null;
  }
  return withResolvedUserId(row);
}

/**
 * Finds the task that produced an automation report root. Inbound replies use
 * the provider's reply target, not the newest task in the channel, so reports
 * remain routable after later tasks have run in the same conversation.
 *
 * Every automation-initiated task qualifies. The initiator columns carry that
 * signal for all of them, unlike the run payload, which only some automations
 * stamp with an automation key.
 */
export async function findTaskBackedAutomationReportRun(input: {
  provider: CommunicationProvider;
  channelId: string;
  messageId: string;
}) {
  const [row] = await db
    .select(ACTIVE_SELECTION)
    .from(taskRuns)
    .innerJoin(tasks, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        sql`${taskRuns.payload}->>'communicationProvider' = ${input.provider}`,
        sql`${taskRuns.payload}->>'communicationChannelId' = ${input.channelId}`,
        sql`${taskRuns.payload}->>'communicationMessageId' = ${input.messageId}`,
        eq(tasks.initiatorKind, 'automation'),
        isNull(taskRuns.canceledAt),
        isNull(tasks.deletedAt),
      ),
    )
    // A report root is immutable. Prefer its first binding if historical data
    // contains a duplicate rather than letting a newer task steal the reply.
    .orderBy(asc(taskRuns.createdAt))
    .limit(1);

  if (row) {
    return withResolvedUserId(row);
  }

  // Root-message delivery can finish after the task run is cleaned up. The
  // tracked automation thread preserves the task binding for that case.
  const [trackedThread] = await db
    .select({ sourceTaskId: sql`${trackedMessages.metadata}->>'sourceTaskId'` })
    .from(trackedMessages)
    .where(
      and(
        eq(trackedMessages.surface, input.provider),
        eq(trackedMessages.kind, 'automation_thread'),
        eq(trackedMessages.channelId, input.channelId),
        eq(trackedMessages.threadTs, input.messageId),
      ),
    )
    .limit(1);

  const sourceTaskId =
    typeof trackedThread?.sourceTaskId === 'string'
      ? trackedThread.sourceTaskId
      : null;
  if (!sourceTaskId) {
    return null;
  }

  const [sourceRun] = await db
    .select(ACTIVE_SELECTION)
    .from(taskRuns)
    .innerJoin(tasks, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        eq(taskRuns.taskId, sourceTaskId),
        isNull(taskRuns.canceledAt),
        isNull(tasks.deletedAt),
      ),
    )
    .orderBy(asc(taskRuns.createdAt))
    .limit(1);

  return sourceRun ? withResolvedUserId(sourceRun) : null;
}

/**
 * Finds a fresh launch already committed for the provider event. Gateway
 * retries can arrive after task creation succeeded but the final chat
 * acknowledgement failed; this prevents that retry from creating a second
 * task or thread.
 */
export async function findCommunicationTaskRunBySourceEvent(input: {
  provider: CommunicationProvider;
  sourceEventId: string;
}) {
  const [row] = await db
    .select({
      id: taskRuns.id,
      taskId: taskRuns.taskId,
      payload: taskRuns.payload,
      status: taskRuns.status,
    })
    .from(taskRuns)
    .where(
      and(
        sql`${taskRuns.payload}->>'communicationProvider' = ${input.provider}`,
        sql`${taskRuns.payload}->>'communicationSourceEventId' = ${input.sourceEventId}`,
        isNull(taskRuns.canceledAt),
      ),
    )
    .orderBy(desc(taskRuns.createdAt))
    .limit(1);

  return row ?? null;
}
