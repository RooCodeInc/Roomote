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

const SLACK_MESSAGE_QUEUE_PREFIX = 'slack:messages:';
const RESUME_LOCK_PREFIX = 'slack:resume-lock:';
const RESUME_LOCK_TTL_SECONDS = 30;

/**
 * Minimum shape of the source cloud job required by the drain helper.
 * Kept narrow so that both the SDK router (full DB row) and BullMQ
 * handler (partial query result) can call this without type gymnastics.
 */
export interface SlackDrainSourceJob {
  id: number;
  /** Slack thread binding from the run's task row (tasks.slackThreadTs). */
  slackThreadTs: string | null;
  snapshotId: string | null;
  payload: Record<string, unknown>;
  port: number | null;
}

export type SlackDrainResult =
  | {
      resumed: true;
      cloudJobId: number;
      taskId: string;
      messageCount: number;
    }
  | { resumed: false; reason: string };

/**
 * Non-destructive check of pending Slack message count for a cloud job.
 */
export async function peekSlackMessageCount(
  cloudJobId: number,
): Promise<number> {
  const redis = getRedis();
  const key = `${SLACK_MESSAGE_QUEUE_PREFIX}${cloudJobId}`;
  return redis.llen(key);
}

/**
 * Peek for pending Slack messages on a completed job, and if any exist,
 * create a SnapshotResume job and transfer the messages to it.
 *
 * Uses a safe peek-create-transfer order:
 *   1. Peek non-destructively (LLEN) to check for pending messages
 *   2. Acquire a distributed lock (shared with the webhook handler) to
 *      prevent duplicate resume jobs for the same Slack thread
 *   3. Drain the pending messages
 *   4. Create a durable SnapshotResume cloud job that embeds the drained
 *      messages for worker replay
 *
 * If resume job creation fails, messages are restored to the original Redis
 * queue.
 *
 * @param sourceJob - The completed/snapshotted cloud job to drain from
 * @param snapshotIdOverride - Use this snapshot ID instead of sourceJob.snapshotId
 *   (the BullMQ handler knows the freshly-created snapshot ID before the DB row
 *   is fully updated)
 */
export async function drainSlackMessagesToResumeJob(
  sourceJob: SlackDrainSourceJob,
  snapshotIdOverride?: string,
): Promise<SlackDrainResult> {
  if (!sourceJob.slackThreadTs) {
    return { resumed: false, reason: 'no_slack_thread' };
  }

  const snapshotId = snapshotIdOverride ?? sourceJob.snapshotId;

  if (!snapshotId) {
    return { resumed: false, reason: 'no_snapshot' };
  }

  const messageCount = await peekSlackMessageCount(sourceJob.id);

  if (messageCount === 0) {
    return { resumed: false, reason: 'no_pending_messages' };
  }

  // Acquire the same distributed lock used by the webhook handler to prevent
  // both code paths from creating duplicate resume jobs for the same thread.
  const redis = getRedis();
  const threadTs = sourceJob.slackThreadTs;
  const lockKey = `${RESUME_LOCK_PREFIX}${threadTs}`;
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

  const payload = sourceJob.payload;
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

  // Drain before creating the resume job so its payload is self-contained.
  // Restore the drained messages on failure.
  let messages: Awaited<ReturnType<typeof getSlackMessages>> = [];
  let resumeLaunch: Awaited<ReturnType<typeof enqueueTask>>;

  try {
    messages = await getSlackMessages(sourceJob.id);

    if (messages.length === 0) {
      await redis.del(lockKey);
      return { resumed: false, reason: 'no_pending_messages' };
    }

    const payload: TaskPayload<typeof TaskPayloadKind.SnapshotResume> = {
      repo,
      environmentId,
      selectedRepositories: scopedSelectedRepositories,
      port: sourceJob.port ?? undefined,
      sourceSnapshotId: snapshotId,
      sourceCloudJobId: sourceJob.id,
      queuedSlackMessages: messages,
    };
    populateSnapshotResumeSlackMetadata(payload, {
      sourcePayload: sourceJob.payload,
      threadTs: sourceJob.slackThreadTs,
    });
    restoreSnapshotResumeVisiblePromptFields(payload, sourceJob.payload);

    // The resumer becomes the new run's acting user: the most recent drained
    // follow-up sender we could resolve to a Roomote user. Resumes never
    // create tasks and never re-attribute the task initiator.
    const resumeActingUserId =
      [...messages].reverse().find((message) => message.userId)?.userId ?? null;

    resumeLaunch = await enqueueTask({
      task: {
        type: TaskPayloadKind.SnapshotResume,
        sourceSnapshotId: snapshotId,
        sourceCloudJobId: sourceJob.id,
        payload,
      },
      actingUserId: resumeActingUserId,
    });
  } catch (error) {
    // Restore drained messages and release the lock so a retry can proceed.
    try {
      if (messages.length > 0) {
        await prependSlackMessages(sourceJob.id, messages);
      }
      await redis.del(lockKey);
    } catch {
      // no-op
    }
    throw error;
  }

  console.log(
    `[drainSlackMessagesToResumeJob] Created resume cloud job ${resumeLaunch.id} with ${messages.length} Slack message(s)`,
  );

  return {
    resumed: true,
    cloudJobId: resumeLaunch.id,
    taskId: resumeLaunch.taskId,
    messageCount: messages.length,
  };
}
