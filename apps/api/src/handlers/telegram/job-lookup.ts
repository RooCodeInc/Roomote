import {
  CloudTaskStatus,
  activeCloudTaskStatuses,
  isSnapshotResumable,
} from '@roomote/types';
import {
  and,
  cloudJobs,
  db,
  desc,
  inArray,
  isNull,
  sql,
} from '@roomote/db/server';

import type { TelegramConversationRef } from './types.js';

const ACTIVE_TELEGRAM_JOB_COLUMNS = {
  id: true,
  userId: true,
  type: true,
  status: true,
  machineId: true,
  taskId: true,
  payload: true,
} as const;

const SNAPSHOT_RESUME_TELEGRAM_JOB_COLUMNS = {
  id: true,
  userId: true,
  type: true,
  status: true,
  taskId: true,
  payload: true,
  port: true,
  snapshotId: true,
  snapshotCreatedAt: true,
} as const;

function buildTelegramJobMatchConditions(input: TelegramConversationRef) {
  const telegramProviderMatch = sql`${cloudJobs.payload}->>'communicationProvider' = 'telegram'`;
  const conversationMatch = sql`${cloudJobs.payload}->>'communicationChannelId' = ${input.chatId}`;
  const threadMatch = input.threadId
    ? sql`${cloudJobs.payload}->>'communicationThreadId' = ${input.threadId}`
    : undefined;

  return { telegramProviderMatch, conversationMatch, threadMatch };
}

export async function findActiveTelegramJob(input: TelegramConversationRef) {
  const { telegramProviderMatch, conversationMatch, threadMatch } =
    buildTelegramJobMatchConditions(input);

  return db.query.cloudJobs.findFirst({
    where: and(
      telegramProviderMatch,
      conversationMatch,
      threadMatch,
      inArray(cloudJobs.status, [...activeCloudTaskStatuses]),
      isNull(cloudJobs.canceledAt),
    ),
    orderBy: desc(cloudJobs.createdAt),
    columns: ACTIVE_TELEGRAM_JOB_COLUMNS,
  });
}

export async function findCompletedTelegramJobWithSnapshot(
  input: TelegramConversationRef,
) {
  const { telegramProviderMatch, conversationMatch, threadMatch } =
    buildTelegramJobMatchConditions(input);
  const job = await db.query.cloudJobs.findFirst({
    where: and(
      telegramProviderMatch,
      conversationMatch,
      threadMatch,
      inArray(cloudJobs.status, [CloudTaskStatus.Completed]),
      isNull(cloudJobs.canceledAt),
      sql`${cloudJobs.snapshotId} IS NOT NULL`,
      sql`${cloudJobs.snapshotCreatedAt} IS NOT NULL`,
    ),
    orderBy: desc(cloudJobs.createdAt),
    columns: SNAPSHOT_RESUME_TELEGRAM_JOB_COLUMNS,
  });

  if (!job?.snapshotId || !isSnapshotResumable(job.snapshotCreatedAt)) {
    return null;
  }

  return job;
}

export type CompletedTelegramJob = NonNullable<
  Awaited<ReturnType<typeof findCompletedTelegramJobWithSnapshot>>
>;
