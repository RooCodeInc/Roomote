import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { acquireRedisLock } from '@roomote/redis';
import {
  and,
  db,
  desc,
  eq,
  getSessionForFastConversation,
  isNull,
  sessions,
  sql,
  taskRuns,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  buildFastAgentChildTaskMetadata,
  getFastAgentParentFromPayload,
  type FastAgentParent,
  type StandardTask,
  type TaskInitiator,
  type TaskSurface,
  type TaskTrigger,
} from '@roomote/types';

import { buildFastAgentUserContentBlocks } from './fast-agent-content-blocks';
import type { FastAgentConversation } from './fast-agent-conversation';
import { fastAgentConversationRepository } from './fast-agent-conversation-repository';
import {
  getOrCreateFastAgentSession,
  upsertFastAgentMessage,
} from './fast-agent-session';
import { createFastAgentTaskLauncher } from './fast-agent-task-launcher';

export type PinnedFastSessionLaunchInput = {
  /** The person the launch is attributed to; owns a newly created session. */
  userId: string;
  senderDisplayName?: string | null;
  /**
   * Launch inside this existing Fast conversation. Omit it to create a new
   * web session owned by `userId`, or pass `conversation` to get or create a
   * conversation by its surface identity instead.
   */
  fastConversationId?: string | null;
  /**
   * Surface identity to get or create the Fast conversation from, for chat
   * surfaces that bind the Session to a channel or thread.
   */
  conversation?: FastAgentConversation;
  /**
   * The Session the request came from, for example the one that owns the
   * scan that produced a suggestion. The launch lands there: in its Fast
   * conversation when it has one, otherwise `conversation` becomes that
   * Session's conversation. Ignored when `fastConversationId` is set, and
   * when `conversation` already belongs to another Session.
   */
  originSessionId?: string | null;
  /**
   * Idempotency key for the launch. Replays with the same id reuse the task
   * the first attempt created and never write a second transcript entry.
   */
  launchId: string;
  /** The request as the person typed it; may be empty for a blank workspace. */
  prompt: string;
  images?: string[];
  /**
   * The fully built task. The launch stamps the Fast parent metadata and the
   * idempotency key onto its payload; everything else is the caller's.
   * Surfaces with their own launcher pass `launch` instead.
   */
  task?: StandardTask;
  /**
   * Surface-specific launcher. It must attach the task to `parent` and call
   * `postKickoff` before the child becomes runnable, the way a Fast delegate
   * does.
   */
  launch?: (context: {
    parent: FastAgentParent;
    launchIdempotencyKey: string;
    postKickoff: () => Promise<void>;
  }) => Promise<
    { success: true; taskId: string } | { success: false; error: string }
  >;
  surface: TaskSurface;
  trigger?: TaskTrigger;
  initiator?: TaskInitiator;
  /** Transcript line that records the delegation, for example "Started a task in Backend." */
  kickoffMessage: string;
};

export type PinnedFastSessionLaunchResult = {
  /** The unified Session that owns the conversation and the task. */
  sessionId: string;
  fastConversationId: string;
  taskId: string;
  runId: number;
};

type ConversationTarget = {
  id: string;
  userId: string;
  conversation: FastAgentConversation;
};

async function findConversationTargetById(
  fastConversationId: string,
): Promise<ConversationTarget | null> {
  const record = await fastAgentConversationRepository.findById({
    id: fastConversationId,
  });
  return record
    ? {
        id: record.id,
        userId: record.userId,
        conversation: record.conversation,
      }
    : null;
}

/**
 * A retry of an earlier launch must land in the Session that launch created,
 * or the queue will refuse the reused idempotency key as belonging to another
 * Session. The earlier task's Fast parent names that Session. Only the person
 * who owns that Session may replay into it; anyone else reusing the id is
 * refused rather than handed someone else's task.
 */
async function findConversationTargetForLaunchKey(
  launchIdempotencyKey: string,
  userId: string,
): Promise<ConversationTarget | null> {
  const existingRun = await db.query.taskRuns.findFirst({
    where: and(
      sql`${taskRuns.payload}->>'launchIdempotencyKey' = ${launchIdempotencyKey}`,
      isNull(taskRuns.canceledAt),
    ),
    columns: { payload: true },
  });
  const parentSessionId = getFastAgentParentFromPayload(
    existingRun?.payload,
  )?.sessionId;
  if (!parentSessionId) {
    return null;
  }
  const target = await findConversationTargetById(parentSessionId);
  if (target && target.userId !== userId) {
    throw new Error('This launch id already belongs to another Session.');
  }
  return target;
}

function defaultWebConversation(userId: string): FastAgentConversation {
  return {
    surface: 'web',
    workspaceId: userId,
    conversationId: randomUUID(),
  };
}

/**
 * The origin Session's own conversation when it has one; otherwise the
 * caller's conversation identity is created and bound to that Session. A
 * conversation that already exists elsewhere keeps its Session, so the
 * launch still has a home even when the origin cannot take it.
 */
async function findOriginConversationTarget(
  input: PinnedFastSessionLaunchInput,
  originSessionId: string,
): Promise<ConversationTarget | null> {
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, originSessionId),
    columns: { id: true, fastConversationId: true },
  });
  if (!session) {
    return null;
  }
  if (session.fastConversationId) {
    const target = await findConversationTargetById(session.fastConversationId);
    if (target) {
      return target;
    }
  }
  const created = await getOrCreateFastAgentSession({
    userId: input.userId,
    conversation: input.conversation ?? defaultWebConversation(input.userId),
    sessionId: session.id,
  });
  return {
    id: created.id,
    userId: input.userId,
    conversation: created.conversation,
  };
}

async function resolveConversationTarget(
  input: PinnedFastSessionLaunchInput,
  launchIdempotencyKey: string,
): Promise<ConversationTarget> {
  if (input.fastConversationId) {
    const target = await findConversationTargetById(input.fastConversationId);
    if (!target) {
      throw new Error('The Session for this launch could not be found.');
    }
    return target;
  }

  const replayed = await findConversationTargetForLaunchKey(
    launchIdempotencyKey,
    input.userId,
  );
  if (replayed) {
    return replayed;
  }

  if (input.originSessionId) {
    const origin = await findOriginConversationTarget(
      input,
      input.originSessionId,
    );
    if (origin) {
      return origin;
    }
  }

  const created = await getOrCreateFastAgentSession({
    userId: input.userId,
    conversation: input.conversation ?? defaultWebConversation(input.userId),
  });
  return {
    id: created.id,
    userId: input.userId,
    conversation: created.conversation,
  };
}

const LAUNCH_LOCK_TTL_SECONDS = 60;
const LAUNCH_LOCK_WAIT_MS = 15_000;
const LAUNCH_LOCK_POLL_MS = 200;

/**
 * Concurrent retries of one launch must agree on the Session before either
 * reaches the queue's per-key lock, or the loser creates a second Session and
 * is then refused. Serialize launches that have to discover their Session.
 */
async function withLaunchLock<T>(
  launchIdempotencyKey: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = `${launchIdempotencyKey}:lock`;
  const deadline = Date.now() + LAUNCH_LOCK_WAIT_MS;
  let release = await acquireRedisLock(key, {
    ttlSeconds: LAUNCH_LOCK_TTL_SECONDS,
  });
  while (!release && Date.now() < deadline) {
    await sleep(LAUNCH_LOCK_POLL_MS);
    release = await acquireRedisLock(key, {
      ttlSeconds: LAUNCH_LOCK_TTL_SECONDS,
    });
  }
  if (!release) {
    throw new Error(
      'Another attempt at this launch is still in progress. Retry in a moment.',
    );
  }
  try {
    return await run();
  } finally {
    await release().catch(() => undefined);
  }
}

/**
 * Launches a task with a workspace the person already chose, inside a Fast
 * Session, without spending a model turn. The Session records the request
 * and a kickoff line the way a delegated launch would, so the conversation
 * can continue around the task afterwards.
 */
export async function launchPinnedFastSessionTask(
  input: PinnedFastSessionLaunchInput,
): Promise<PinnedFastSessionLaunchResult> {
  const turnId = `pinned-launch:${input.launchId}`;
  // A caller that names the Session cannot disagree with a concurrent retry;
  // the queue's own per-key lock covers the task itself.
  if (input.fastConversationId) {
    return launchInSession(input, turnId);
  }
  return withLaunchLock(turnId, () => launchInSession(input, turnId));
}

async function launchInSession(
  input: PinnedFastSessionLaunchInput,
  turnId: string,
): Promise<PinnedFastSessionLaunchResult> {
  const target = await resolveConversationTarget(input, turnId);
  const prompt = input.prompt.trim();
  const images = input.images ?? [];
  const now = Date.now();

  if (prompt.length > 0 || images.length > 0) {
    await upsertFastAgentMessage({
      sessionId: target.id,
      message: {
        eventId: `${turnId}:user`,
        turnId,
        turnSeq: 0,
        ts: now,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        contentBlocks: buildFastAgentUserContentBlocks(prompt, images),
        metadata: {
          visibleInTranscript: true,
          turnSource: 'human',
          userId: input.userId,
          ...(input.senderDisplayName
            ? {
                userName: input.senderDisplayName,
                senderDisplayName: input.senderDisplayName,
              }
            : {}),
        },
        payload: {},
        source: target.conversation.surface,
        nativeSessionId: null,
      },
    });
  }

  const postKickoff = async () => {
    await upsertFastAgentMessage({
      sessionId: target.id,
      message: {
        eventId: `${turnId}:kickoff`,
        turnId,
        turnSeq: 1,
        ts: Date.now(),
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: input.kickoffMessage }],
        metadata: { visibleInTranscript: true, purpose: 'progress' },
        payload: { purpose: 'progress', kickoff: true },
        source: target.conversation.surface,
        nativeSessionId: null,
      },
    });
  };
  const parent: FastAgentParent = {
    sessionId: target.id,
    conversation: target.conversation,
  };

  let launch: Awaited<ReturnType<NonNullable<typeof input.launch>>>;
  if (input.launch) {
    launch = await input.launch({
      parent,
      launchIdempotencyKey: turnId,
      postKickoff,
    });
  } else {
    const task = input.task;
    if (!task) {
      throw new Error('A pinned launch needs a task or a launcher.');
    }
    const launchTask = createFastAgentTaskLauncher({
      userId: input.userId,
      surface: input.surface,
      ...(input.initiator ? { initiator: input.initiator } : {}),
      trigger: input.trigger ?? 'manual',
      taskUrlCampaign: 'pinned-launch',
      // The Session timeline renders the task card itself.
      rendersTaskLink: true,
      buildTask: () => ({
        ...task,
        payload: {
          ...task.payload,
          ...buildFastAgentChildTaskMetadata(parent),
        },
      }),
    });
    launch = await launchTask({
      prompt,
      environmentId: task.payload.environmentId ?? null,
      model: null,
      parentSessionId: target.id,
      launchIdempotencyKey: turnId,
      postKickoff,
    });
  }

  if (!launch.success) {
    throw new Error(launch.error);
  }

  // The transcript renders delegated-task cards from `launch_task` tool
  // results. A pinned launch spends no model turn, so it persists the same
  // row a delegating turn would; without it the Session shows only the
  // kickoff text and the task is invisible.
  await upsertFastAgentMessage({
    sessionId: target.id,
    message: {
      eventId: `${turnId}:launch`,
      turnId,
      turnSeq: 2,
      ts: Date.now(),
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
      role: 'tool',
      contentBlocks: [],
      metadata: { visibleInTranscript: true },
      payload: {
        toolCallId: `${turnId}:tool:0`,
        title: 'launch_task',
        toolName: 'launch_task',
        status: 'completed',
        isExecute: false,
        isRead: false,
        isMcp: false,
        isRoomoteNativeTool: true,
        command: null,
        exitCode: null,
        output: JSON.stringify({ success: true, taskId: launch.taskId }),
        rawInput: { arguments: prompt ? { prompt } : {} },
      },
      source: target.conversation.surface,
      nativeSessionId: null,
    },
  });

  const [latestRun, session] = await Promise.all([
    db.query.taskRuns.findFirst({
      where: eq(taskRuns.taskId, launch.taskId),
      orderBy: [desc(taskRuns.createdAt), desc(taskRuns.id)],
      columns: { id: true },
    }),
    getSessionForFastConversation(db, target.id),
  ]);

  if (!latestRun) {
    throw new Error('The task launch did not create a run.');
  }
  if (!session) {
    throw new Error('The task launch did not attach to a Session.');
  }

  return {
    sessionId: session.id,
    fastConversationId: target.id,
    taskId: launch.taskId,
    runId: latestRun.id,
  };
}
