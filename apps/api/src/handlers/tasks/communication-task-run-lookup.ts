import {
  RunStatus,
  activeRunStatuses,
  isSnapshotResumable,
  type CommunicationProvider,
} from '@roomote/types';
import {
  and,
  db,
  desc,
  eq,
  inArray,
  isNull,
  sql,
  taskRuns,
  tasks,
} from '@roomote/db/server';

type CommunicationConversationRef = {
  provider: CommunicationProvider;
  channelId: string;
  threadId?: string;
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
        inArray(taskRuns.status, [...activeRunStatuses]),
        isNull(taskRuns.canceledAt),
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
        inArray(taskRuns.status, [RunStatus.Completed]),
        isNull(taskRuns.canceledAt),
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
