import {
  stripLeadingRawSlackMention,
  stripLeadingSlackProductMention,
} from '@roomote/cloud-agents';
import { isBetaBackgroundAutomationKey } from '@roomote/types';
import { recordSlackConversationMessageBestEffort } from '@roomote/sdk/server';
import {
  getLatestSlackBotReply,
  type SlackEvent,
  type SlackNotifier,
} from '@roomote/slack';
import {
  and,
  db,
  desc,
  eq,
  findBackgroundAutomationSlackThread,
  taskRuns,
  tasks,
  type SlackUserMapping,
} from '@roomote/db/server';

function getConversationKindForSlackEvent(event: SlackEvent): 'dm' | 'thread' {
  return event.channel_type === 'im' ? 'dm' : 'thread';
}

export function shouldRecordInboundSlackConversationMessage(
  event: SlackEvent,
  shouldRecordThreadReply: boolean,
): boolean {
  if (event.thread_ts) {
    return shouldRecordThreadReply;
  }

  return (
    event.type === 'message' &&
    'channel_type' in event &&
    event.channel_type === 'im'
  );
}

export function getInboundSlackConversationSource(
  event: SlackEvent,
): 'user_dm' | 'user_thread_reply' {
  if (
    event.type === 'message' &&
    'channel_type' in event &&
    event.channel_type === 'im' &&
    !event.thread_ts
  ) {
    return 'user_dm';
  }

  return 'user_thread_reply';
}

type RoomoteOwnedSlackThreadMatch = {
  userId: string | null;
  slackUserId: string | null;
};

export async function findRoomoteOwnedSlackThread(params: {
  teamId: string;
  channelId: string;
  threadTs: string;
}): Promise<RoomoteOwnedSlackThreadMatch | null> {
  const existingSlackRows = await db
    .select({
      id: taskRuns.id,
      taskId: taskRuns.taskId,
      payload: taskRuns.payload,
      initiatorUserId: tasks.initiatorUserId,
      actingUserId: taskRuns.actingUserId,
    })
    .from(tasks)
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(eq(tasks.slackThreadTs, params.threadTs))
    .limit(10);

  const existingSlackJobs = existingSlackRows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    payload: row.payload,
    userId: row.initiatorUserId ?? row.actingUserId,
  }));

  let fallbackMatch: RoomoteOwnedSlackThreadMatch | null = null;

  for (const job of existingSlackJobs) {
    const payload = job.payload as
      | { channel?: unknown; teamId?: unknown; user?: unknown }
      | undefined;

    if (payload?.channel !== params.channelId) {
      continue;
    }

    if (payload.teamId === params.teamId) {
      const match = {
        userId: job.userId,
        slackUserId: typeof payload.user === 'string' ? payload.user : null,
      } satisfies RoomoteOwnedSlackThreadMatch;

      if (match.slackUserId) {
        return match;
      }

      fallbackMatch ??= match;
      continue;
    }
  }

  const trackedAutomationThread = await findBackgroundAutomationSlackThread({
    slackChannelId: params.channelId,
    threadTs: params.threadTs,
  });

  const sourceTaskId =
    trackedAutomationThread &&
    isBetaBackgroundAutomationKey(trackedAutomationThread.automationKey) &&
    typeof trackedAutomationThread.metadata?.sourceTaskId === 'string' &&
    trackedAutomationThread.metadata.sourceTaskId.trim().length > 0
      ? trackedAutomationThread.metadata.sourceTaskId
      : null;

  if (sourceTaskId) {
    const sourceTaskJob = existingSlackJobs.find(
      (job) => job.taskId === sourceTaskId,
    );

    if (sourceTaskJob) {
      return {
        userId: sourceTaskJob.userId,
        slackUserId: null,
      };
    }

    const [sourceTaskJobById] = await db
      .select({
        initiatorUserId: tasks.initiatorUserId,
        actingUserId: taskRuns.actingUserId,
      })
      .from(tasks)
      .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
      .where(
        and(
          eq(tasks.id, sourceTaskId),
          eq(tasks.slackThreadTs, params.threadTs),
        ),
      )
      .orderBy(desc(taskRuns.createdAt))
      .limit(1);

    if (sourceTaskJobById) {
      return {
        userId:
          sourceTaskJobById.initiatorUserId ?? sourceTaskJobById.actingUserId,
        slackUserId: null,
      };
    }
  }

  const trackedBotReply = await getLatestSlackBotReply(
    params.channelId,
    params.threadTs,
  );

  if (trackedBotReply) {
    return (
      fallbackMatch ?? {
        userId: null,
        slackUserId: null,
      }
    );
  }

  return fallbackMatch;
}

export async function isRoomoteOwnedSlackThread(params: {
  teamId: string;
  channelId: string;
  threadTs: string;
}): Promise<boolean> {
  return (await findRoomoteOwnedSlackThread(params)) !== null;
}

export async function findTrackedBackgroundAutomationSlackThread(params: {
  channelId: string;
  threadTs: string;
}) {
  return findBackgroundAutomationSlackThread({
    slackChannelId: params.channelId,
    threadTs: params.threadTs,
  });
}

export async function recordInboundSlackConversationMessage(params: {
  event: SlackEvent;
  slack: SlackNotifier;
  userMapping: SlackUserMapping | null;
  teamId: string;
  shouldRecordThreadReply: boolean;
  activeJobId?: number;
  activeTaskId?: string;
}): Promise<void> {
  if (
    !shouldRecordInboundSlackConversationMessage(
      params.event,
      params.shouldRecordThreadReply,
    )
  ) {
    return;
  }

  const normalizedText = stripLeadingSlackProductMention(
    await params.slack.normalizeIncomingText(
      stripLeadingRawSlackMention(params.event.text),
    ),
  ).trim();
  const conversationKind = getConversationKindForSlackEvent(params.event);
  const subjectSlackUserId =
    params.userMapping?.slackUserId ?? params.event.user;

  if (!subjectSlackUserId) {
    return;
  }

  await recordSlackConversationMessageBestEffort({
    logContext: 'SlackWebhook.inbound',
    subjectUserId: params.userMapping?.userId ?? null,
    slackTeamId: params.teamId,
    subjectSlackUserId,
    senderUserId: params.userMapping?.userId ?? null,
    senderSlackUserId: params.event.user,
    slackChannelId: params.event.channel,
    conversationKind,
    threadTs:
      conversationKind === 'thread'
        ? params.event.thread_ts || params.event.ts
        : null,
    messageTs: params.event.ts,
    direction: 'inbound',
    authorKind: 'user',
    source: getInboundSlackConversationSource(params.event),
    text: normalizedText || params.event.text,
    taskId: params.activeTaskId,
    cloudJobId: params.activeJobId,
    metadata: {
      eventType: params.event.type,
      subtype: params.event.subtype ?? null,
      slackUserMapped: Boolean(params.userMapping),
    },
  });
}
