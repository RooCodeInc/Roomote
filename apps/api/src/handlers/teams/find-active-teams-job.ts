import {
  and,
  cloudJobs,
  db,
  desc,
  inArray,
  isNull,
  or,
  sql,
} from '@roomote/db/server';
import {
  CloudTaskStatus,
  activeCloudTaskStatuses,
  isSnapshotResumable,
} from '@roomote/types';

const ACTIVE_TEAMS_JOB_COLUMNS = {
  id: true,
  userId: true,
  type: true,
  status: true,
  machineId: true,
  taskId: true,
  payload: true,
} as const;

const SNAPSHOT_RESUME_TEAMS_JOB_COLUMNS = {
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

/**
 * Strips the Bot Framework channel-thread `;messageid=<root>` suffix from a
 * Teams conversation id so the bare channel conversation id is compared
 * regardless of whether the id came from the thread-root message (bare) or a
 * reply inside the thread (suffixed). Personal (`a:`) and group chat ids have
 * no suffix and are returned unchanged.
 */
export function stripTeamsMessageIdSuffix(conversationId: string): string {
  const separatorIndex = conversationId.indexOf(';messageid=');

  return separatorIndex === -1
    ? conversationId
    : conversationId.slice(0, separatorIndex);
}

/**
 * Builds the SQL match conditions used to find the active (or
 * snapshot-resumable completed) Teams cloud job for an inbound activity.
 *
 * Conversation ids are normalized to their bare channel form before
 * comparison: a task launched from a top-level channel message stores the bare
 * conversation id (`19:...@thread.tacv2`), while follow-up replies in that
 * thread arrive with a thread-scoped conversation id
 * (`19:...@thread.tacv2;messageid=<root>`). Comparing the bare form on both
 * sides keeps the follow-up associated with the original job. Thread
 * disambiguation still relies on the root activity id (threadMatch).
 */
export function buildTeamsJobMatchConditions(input: {
  conversationId: string;
  threadId?: string;
}) {
  const conversationBase = stripTeamsMessageIdSuffix(input.conversationId);
  const conversationMatch = or(
    sql`split_part(${cloudJobs.payload}->>'communicationChannelId', ';messageid=', 1) = ${conversationBase}`,
    sql`split_part(${cloudJobs.payload}->>'teamsConversationId', ';messageid=', 1) = ${conversationBase}`,
    sql`${cloudJobs.payload}->>'teamsChannelId' = ${conversationBase}`,
  );
  const threadMatch = input.threadId
    ? or(
        sql`${cloudJobs.payload}->>'communicationThreadId' = ${input.threadId}`,
        sql`${cloudJobs.payload}->>'communicationMessageId' = ${input.threadId}`,
        sql`${cloudJobs.payload}->>'teamsThreadId' = ${input.threadId}`,
        sql`${cloudJobs.payload}->>'teamsMessageId' = ${input.threadId}`,
      )
    : undefined;
  const teamsProviderMatch = or(
    sql`${cloudJobs.payload}->>'communicationProvider' = 'teams'`,
    sql`${cloudJobs.payload}->>'teamsConversationId' IS NOT NULL`,
    sql`${cloudJobs.payload}->>'teamsChannelId' IS NOT NULL`,
    sql`${cloudJobs.payload}->>'teamsThreadId' IS NOT NULL`,
    sql`${cloudJobs.payload}->>'teamsMessageId' IS NOT NULL`,
  );

  return { teamsProviderMatch, conversationMatch, threadMatch };
}

export async function findActiveTeamsJob(input: {
  conversationId: string;
  threadId?: string;
}) {
  const { teamsProviderMatch, conversationMatch, threadMatch } =
    buildTeamsJobMatchConditions(input);

  return db.query.cloudJobs.findFirst({
    where: and(
      teamsProviderMatch,
      conversationMatch,
      threadMatch,
      inArray(cloudJobs.status, [...activeCloudTaskStatuses]),
      isNull(cloudJobs.canceledAt),
    ),
    orderBy: desc(cloudJobs.createdAt),
    columns: ACTIVE_TEAMS_JOB_COLUMNS,
  });
}

export async function findCompletedTeamsJobWithSnapshot(input: {
  conversationId: string;
  threadId?: string;
}) {
  const { teamsProviderMatch, conversationMatch, threadMatch } =
    buildTeamsJobMatchConditions(input);
  const job = await db.query.cloudJobs.findFirst({
    where: and(
      teamsProviderMatch,
      conversationMatch,
      threadMatch,
      inArray(cloudJobs.status, [CloudTaskStatus.Completed]),
      isNull(cloudJobs.canceledAt),
      sql`${cloudJobs.snapshotId} IS NOT NULL`,
      sql`${cloudJobs.snapshotCreatedAt} IS NOT NULL`,
    ),
    orderBy: desc(cloudJobs.createdAt),
    columns: SNAPSHOT_RESUME_TEAMS_JOB_COLUMNS,
  });

  if (!job?.snapshotId || !isSnapshotResumable(job.snapshotCreatedAt)) {
    return null;
  }

  return job;
}

/**
 * Finds the most recent Teams cloud job for a conversation thread regardless
 * of status. Used to decide whether a Teams thread is Roomote-owned (Roomote
 * has run a task in it before), mirroring the Slack
 * `findRoomoteOwnedSlackThread` ownership check for unmentioned thread
 * replies.
 */
export async function findLatestTeamsThreadJob(input: {
  conversationId: string;
  threadId: string;
}) {
  const { teamsProviderMatch, conversationMatch, threadMatch } =
    buildTeamsJobMatchConditions(input);

  return db.query.cloudJobs.findFirst({
    where: and(teamsProviderMatch, conversationMatch, threadMatch),
    orderBy: desc(cloudJobs.createdAt),
    columns: { id: true, userId: true },
  });
}
