import {
  and,
  db,
  desc,
  eq,
  inArray,
  isNull,
  or,
  sql,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import {
  RunStatus,
  activeRunStatuses,
  isSnapshotResumable,
} from '@roomote/types';

const ACTIVE_TEAMS_JOB_SELECTION = {
  id: taskRuns.id,
  initiatorUserId: tasks.initiatorUserId,
  actingUserId: taskRuns.actingUserId,
  payloadKind: taskRuns.payloadKind,
  status: taskRuns.status,
  machineId: taskRuns.machineId,
  taskId: taskRuns.taskId,
  payload: taskRuns.payload,
};

const SNAPSHOT_RESUME_TEAMS_JOB_SELECTION = {
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
 * `userId` shape Teams callers key off: the task initiator when known,
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
    sql`split_part(${taskRuns.payload}->>'communicationChannelId', ';messageid=', 1) = ${conversationBase}`,
    sql`split_part(${taskRuns.payload}->>'teamsConversationId', ';messageid=', 1) = ${conversationBase}`,
    sql`${taskRuns.payload}->>'teamsChannelId' = ${conversationBase}`,
  );
  const threadMatch = input.threadId
    ? or(
        sql`${taskRuns.payload}->>'communicationThreadId' = ${input.threadId}`,
        sql`${taskRuns.payload}->>'communicationMessageId' = ${input.threadId}`,
        sql`${taskRuns.payload}->>'teamsThreadId' = ${input.threadId}`,
        sql`${taskRuns.payload}->>'teamsMessageId' = ${input.threadId}`,
      )
    : undefined;
  const teamsProviderMatch = or(
    sql`${taskRuns.payload}->>'communicationProvider' = 'teams'`,
    sql`${taskRuns.payload}->>'teamsConversationId' IS NOT NULL`,
    sql`${taskRuns.payload}->>'teamsChannelId' IS NOT NULL`,
    sql`${taskRuns.payload}->>'teamsThreadId' IS NOT NULL`,
    sql`${taskRuns.payload}->>'teamsMessageId' IS NOT NULL`,
  );

  return { teamsProviderMatch, conversationMatch, threadMatch };
}

export async function findActiveTeamsJob(input: {
  conversationId: string;
  threadId?: string;
}) {
  const { teamsProviderMatch, conversationMatch, threadMatch } =
    buildTeamsJobMatchConditions(input);

  const [row] = await db
    .select(ACTIVE_TEAMS_JOB_SELECTION)
    .from(taskRuns)
    .innerJoin(tasks, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        teamsProviderMatch,
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

export async function findCompletedTeamsJobWithSnapshot(input: {
  conversationId: string;
  threadId?: string;
}) {
  const { teamsProviderMatch, conversationMatch, threadMatch } =
    buildTeamsJobMatchConditions(input);
  const [row] = await db
    .select(SNAPSHOT_RESUME_TEAMS_JOB_SELECTION)
    .from(taskRuns)
    .innerJoin(tasks, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        teamsProviderMatch,
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

  const [row] = await db
    .select({
      id: taskRuns.id,
      initiatorUserId: tasks.initiatorUserId,
      actingUserId: taskRuns.actingUserId,
    })
    .from(taskRuns)
    .innerJoin(tasks, eq(taskRuns.taskId, tasks.id))
    .where(and(teamsProviderMatch, conversationMatch, threadMatch))
    .orderBy(desc(taskRuns.createdAt))
    .limit(1);

  return row ? withResolvedUserId(row) : undefined;
}
