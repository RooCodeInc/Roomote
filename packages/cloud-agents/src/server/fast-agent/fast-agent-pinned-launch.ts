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
  sql,
  taskRuns,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  buildFastAgentChildTaskMetadata,
  getFastAgentParentFromPayload,
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
   * web session owned by `userId`.
   */
  fastConversationId?: string | null;
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
   */
  task: StandardTask;
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
  conversation: FastAgentConversation;
};

async function findConversationTargetById(
  fastConversationId: string,
): Promise<ConversationTarget | null> {
  const record = await fastAgentConversationRepository.findById({
    id: fastConversationId,
  });
  return record ? { id: record.id, conversation: record.conversation } : null;
}

/**
 * A retry of an earlier launch must land in the Session that launch created,
 * or the queue will refuse the reused idempotency key as belonging to another
 * Session. The earlier task's Fast parent names that Session.
 */
async function findConversationTargetForLaunchKey(
  launchIdempotencyKey: string,
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
  return parentSessionId ? findConversationTargetById(parentSessionId) : null;
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

  const replayed =
    await findConversationTargetForLaunchKey(launchIdempotencyKey);
  if (replayed) {
    return replayed;
  }

  const created = await getOrCreateFastAgentSession({
    userId: input.userId,
    conversation: {
      surface: 'web',
      workspaceId: input.userId,
      conversationId: randomUUID(),
    },
  });
  return { id: created.id, conversation: created.conversation };
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

  const launchTask = createFastAgentTaskLauncher({
    userId: input.userId,
    surface: input.surface,
    ...(input.initiator ? { initiator: input.initiator } : {}),
    trigger: input.trigger ?? 'manual',
    taskUrlCampaign: 'pinned-launch',
    // The Session timeline renders the task card itself.
    rendersTaskLink: true,
    buildTask: ({ parentSessionId }) => ({
      ...input.task,
      payload: {
        ...input.task.payload,
        ...buildFastAgentChildTaskMetadata({
          sessionId: parentSessionId,
          conversation: target.conversation,
        }),
      },
    }),
  });

  const launch = await launchTask({
    prompt,
    environmentId: input.task.payload.environmentId ?? null,
    model: null,
    parentSessionId: target.id,
    launchIdempotencyKey: turnId,
    postKickoff: async () => {
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
    },
  });

  if (!launch.success) {
    throw new Error(launch.error);
  }

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
