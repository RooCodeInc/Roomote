import {
  RunStatus,
  activeRunStatuses,
  isSnapshotResumable,
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

import type { TelegramConversationRef } from './types.js';

const ACTIVE_TELEGRAM_TASK_RUN_SELECTION = {
  id: taskRuns.id,
  initiatorUserId: tasks.initiatorUserId,
  actingUserId: taskRuns.actingUserId,
  payloadKind: taskRuns.payloadKind,
  status: taskRuns.status,
  machineId: taskRuns.machineId,
  taskId: taskRuns.taskId,
  payload: taskRuns.payload,
};

const SNAPSHOT_RESUME_TELEGRAM_TASK_RUN_SELECTION = {
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

/**
 * Collapses the split initiator/acting user columns back into the single
 * `userId` shape Telegram callers key off: the task initiator when known,
 * otherwise the run's acting user.
 */
function withResolvedUserId<
  T extends { initiatorUserId: string | null; actingUserId: string | null },
>(
  row: T,
): Omit<T, 'initiatorUserId' | 'actingUserId'> & {
  userId: string | null;
} {
  const { initiatorUserId, actingUserId, ...rest } = row;

  return { ...rest, userId: initiatorUserId ?? actingUserId };
}

function buildTelegramTaskRunMatchConditions(input: TelegramConversationRef) {
  const telegramProviderMatch = sql`${taskRuns.payload}->>'communicationProvider' = 'telegram'`;
  const conversationMatch = sql`${taskRuns.payload}->>'communicationChannelId' = ${input.chatId}`;
  const threadMatch = input.threadId
    ? sql`${taskRuns.payload}->>'communicationThreadId' = ${input.threadId}`
    : sql`${taskRuns.payload}->>'communicationThreadId' IS NULL`;

  return { telegramProviderMatch, conversationMatch, threadMatch };
}

export async function findActiveTelegramTaskRun(
  input: TelegramConversationRef,
) {
  const { telegramProviderMatch, conversationMatch, threadMatch } =
    buildTelegramTaskRunMatchConditions(input);

  const [row] = await db
    .select(ACTIVE_TELEGRAM_TASK_RUN_SELECTION)
    .from(taskRuns)
    .innerJoin(tasks, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        telegramProviderMatch,
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

export async function findCompletedTelegramTaskRunWithSnapshot(
  input: TelegramConversationRef,
) {
  const { telegramProviderMatch, conversationMatch, threadMatch } =
    buildTelegramTaskRunMatchConditions(input);
  const [row] = await db
    .select(SNAPSHOT_RESUME_TELEGRAM_TASK_RUN_SELECTION)
    .from(taskRuns)
    .innerJoin(tasks, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        telegramProviderMatch,
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

export type CompletedTelegramTaskRun = NonNullable<
  Awaited<ReturnType<typeof findCompletedTelegramTaskRunWithSnapshot>>
>;
