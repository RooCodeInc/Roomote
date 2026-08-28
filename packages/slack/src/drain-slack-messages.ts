import {
  ALL_REPOSITORIES,
  type TaskPayload,
  TaskPayloadKind,
  populateSnapshotResumeSlackMetadata,
  restoreSnapshotResumeVisiblePromptFields,
} from '@roomote/types';
import { enqueueTask } from '@roomote/cloud-agents/server';
import { getRedis } from '@roomote/redis';

import { getSlackMessages, prependSlackMessages } from './slack-messages';
import { getSlackResumeLockKey } from './slack-resume-lock';

const SLACK_MESSAGE_QUEUE_PREFIX = 'slack:messages:';
const RESUME_LOCK_TTL_SECONDS = 30;

/**
 * Minimum shape of the source task run required by the drain helper.
 * Kept narrow so that both the SDK router (full DB row) and BullMQ
 * handler (partial query result) can call this without type gymnastics.
 */
export interface SlackDrainSourceRun {
  id: number;
  taskId: string;
  /** Slack thread binding from the run's task row (tasks.slackThreadTs). */
  slackThreadTs: string | null;
  snapshotId: string | null;
  payload: Record<string, unknown>;
  port: number | null;
}

export type SlackDrainResult =
  | {
      resumed: true;
      runId: number;
      taskId: string;
      messageCount: number;
    }
  | { resumed: false; reason: string };

/**
 * Non-destructive check of pending Slack message count for a task run.
 */
export async function peekSlackMessageCount(runId: number): Promise<number> {
  const redis = getRedis();
  const key = `${SLACK_MESSAGE_QUEUE_PREFIX}${runId}`;
  return redis.llen(key);
}

/**
 * Peek for pending Slack messages on a completed task run, and if any exist,
 * create a SnapshotResume run and transfer the messages to it.
 *
 * Uses a safe peek-create-transfer order:
 *   1. Peek non-destructively (LLEN) to check for pending messages
 *   2. Acquire a distributed lock (shared with the webhook handler) to
 *      prevent duplicate resume task runs for the same Slack thread
 *   3. Drain the pending messages
 *   4. Create a durable SnapshotResume task run that embeds the drained
 *      messages for worker replay
 *
 * If resume task run creation fails, messages are restored to the original Redis
 * queue.
 *
 * @param sourceRun - The completed/snapshotted task run to drain from
 * @param snapshotIdOverride - Use this snapshot ID instead of sourceRun.snapshotId
 *   (the BullMQ handler knows the freshly-created snapshot ID before the DB row
 *   is fully updated)
 */
export async function drainSlackMessagesToResumeRun(
  sourceRun: SlackDrainSourceRun,
  snapshotIdOverride?: string,
): Promise<SlackDrainResult> {
  if (!sourceRun.slackThreadTs) {
    return { resumed: false, reason: 'no_slack_thread' };
  }

  const snapshotId = snapshotIdOverride ?? sourceRun.snapshotId;

  if (!snapshotId) {
    return { resumed: false, reason: 'no_snapshot' };
  }

  const messageCount = await peekSlackMessageCount(sourceRun.id);

  if (messageCount === 0) {
    return { resumed: false, reason: 'no_pending_messages' };
  }

  // Acquire the same distributed lock used by the webhook handler to prevent
  // both code paths from creating duplicate resume task runs for the same thread.
  const redis = getRedis();
  const threadTs = sourceRun.slackThreadTs;
  const lockKey = getSlackResumeLockKey(threadTs, sourceRun.taskId);
  const acquired = await redis.set(
    lockKey,
    '1',
    'EX',
    RESUME_LOCK_TTL_SECONDS,
    'NX',
  );

  if (!acquired) {
    return { resumed: false, reason: 'resume_lock_held' };
  }

  const payload = sourceRun.payload;
  const repo =
    typeof payload?.repo === 'string' ? payload.repo : ALL_REPOSITORIES;
  const environmentId =
    typeof payload?.environmentId === 'string'
      ? payload.environmentId
      : undefined;
  const selectedRepositories = Array.isArray(payload?.selectedRepositories)
    ? payload.selectedRepositories.filter(
        (repository): repository is string => typeof repository === 'string',
      )
    : undefined;
  const scopedSelectedRepositories =
    selectedRepositories && selectedRepositories.length > 0
      ? selectedRepositories
      : undefined;

  // Drain before creating the resume task run so its payload is self-contained.
  // Restore the drained messages on failure.
  let messages: Awaited<ReturnType<typeof getSlackMessages>> = [];
  let resumeLaunch: Awaited<ReturnType<typeof enqueueTask>>;

  try {
    messages = await getSlackMessages(sourceRun.id);

    if (messages.length === 0) {
      await redis.del(lockKey);
      return { resumed: false, reason: 'no_pending_messages' };
    }

    const payload: TaskPayload<typeof TaskPayloadKind.SnapshotResume> = {
      repo,
      reportConsumer: 'direct-user',
      environmentId,
      selectedRepositories: scopedSelectedRepositories,
      port: sourceRun.port ?? undefined,
      sourceSnapshotId: snapshotId,
      sourceRunId: sourceRun.id,
      queuedSlackMessages: messages,
    };
    populateSnapshotResumeSlackMetadata(payload, {
      sourcePayload: sourceRun.payload,
      threadTs: sourceRun.slackThreadTs,
    });
    restoreSnapshotResumeVisiblePromptFields(payload, sourceRun.payload);

    // The resumer becomes the new run's acting user: the most recent drained
    // follow-up sender we could resolve to a Roomote user. Resumes never
    // create tasks and never re-attribute the task initiator.
    const resumeActingUserId =
      [...messages].reverse().find((message) => message.userId)?.userId ?? null;

    resumeLaunch = await enqueueTask({
      task: {
        type: TaskPayloadKind.SnapshotResume,
        sourceSnapshotId: snapshotId,
        sourceRunId: sourceRun.id,
        payload,
      },
      actingUserId: resumeActingUserId,
    });
  } catch (error) {
    // Restore drained messages and release the lock so a retry can proceed.
    try {
      if (messages.length > 0) {
        await prependSlackMessages(sourceRun.id, messages);
      }
      await redis.del(lockKey);
    } catch {
      // no-op
    }
    throw error;
  }

  console.log(
    `[drainSlackMessagesToResumeRun] Created resume task run ${resumeLaunch.id} with ${messages.length} Slack message(s)`,
  );

  return {
    resumed: true,
    runId: resumeLaunch.id,
    taskId: resumeLaunch.taskId,
    messageCount: messages.length,
  };
}
