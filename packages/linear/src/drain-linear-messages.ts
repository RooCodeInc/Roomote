import {
  ALL_REPOSITORIES,
  type CloudTaskPayload,
  TaskPayloadKind,
  populateSnapshotResumeSlackMetadata,
  restoreSnapshotResumeVisiblePromptFields,
} from '@roomote/types';
import { enqueueCloudTask } from '@roomote/cloud-agents/server';
import { getRedis } from '@roomote/redis';

import { peekLinearMessageCount } from './peek-linear-messages';
import { getLinearMessages } from './get-linear-messages';
import { prependLinearMessages } from './queue-linear-message';

/**
 * Minimum shape of the source cloud job required by the drain helper.
 * Kept narrow so that both the SDK router (full DB row) and BullMQ
 * handler (partial query result) can call this without type gymnastics.
 */
export interface DrainSourceJob {
  id: number;
  /** Channel bindings sourced from the run's task row (tasks table). */
  linearSessionId: string | null;
  linearIssueId: string | null;
  linearOrganizationId: string | null;
  slackThreadTs: string | null;
  snapshotId: string | null;
  payload: Record<string, unknown>;
  port: number | null;
}

export type DrainResult =
  | {
      resumed: true;
      cloudJobId: number;
      taskId: string;
      messageCount: number;
    }
  | { resumed: false; reason: string };

const RESUME_LOCK_PREFIX = 'linear:resume-lock:';
const RESUME_LOCK_TTL_SECONDS = 30;

/**
 * Peek for pending Linear messages on a completed job, and if any exist,
 * create a SnapshotResume job and transfer the messages to it.
 *
 * Uses a safe peek-create-transfer order:
 *   1. Peek non-destructively (LLEN) to check for pending messages
 *   2. Acquire a distributed lock (shared with the webhook handler) to
 *      prevent duplicate resume jobs for the same Linear issue
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
export async function drainLinearMessagesToResumeJob(
  sourceJob: DrainSourceJob,
  snapshotIdOverride?: string,
): Promise<DrainResult> {
  if (!sourceJob.linearSessionId) {
    return { resumed: false, reason: 'no_linear_session' };
  }

  const snapshotId = snapshotIdOverride ?? sourceJob.snapshotId;

  if (!snapshotId) {
    return { resumed: false, reason: 'no_snapshot' };
  }

  const messageCount = await peekLinearMessageCount(sourceJob.id);

  if (messageCount === 0) {
    return { resumed: false, reason: 'no_pending_messages' };
  }

  // Acquire the same distributed lock used by the webhook handler to prevent
  // both code paths from creating duplicate resume jobs for the same issue.
  const redis = getRedis();
  const issueId = sourceJob.linearIssueId;

  if (issueId) {
    const lockKey = `${RESUME_LOCK_PREFIX}${issueId}`;
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
  const payloadForResume: CloudTaskPayload<
    typeof TaskPayloadKind.SnapshotResume
  > = {
    repo,
    environmentId,
    selectedRepositories: scopedSelectedRepositories,
    port: sourceJob.port ?? undefined,
    sourceSnapshotId: snapshotId,
    sourceCloudJobId: sourceJob.id,
  };
  populateSnapshotResumeSlackMetadata(payloadForResume, {
    sourcePayload: payload,
    threadTs: sourceJob.slackThreadTs,
  });
  restoreSnapshotResumeVisiblePromptFields(payloadForResume, payload);

  let messages: Awaited<ReturnType<typeof getLinearMessages>> = [];
  let resumeLaunch: Awaited<ReturnType<typeof enqueueCloudTask>>;

  try {
    messages = await getLinearMessages(sourceJob.id);

    if (messages.length === 0) {
      if (issueId) {
        await redis.del(`${RESUME_LOCK_PREFIX}${issueId}`);
      }
      return { resumed: false, reason: 'no_pending_messages' };
    }

    payloadForResume.queuedLinearMessages = messages;

    // The resumer becomes the new run's acting user: the most recent drained
    // follow-up sender we could resolve to a Roomote user. Resumes never
    // create tasks and never re-attribute the task initiator.
    const resumeActingUserId =
      [...messages].reverse().find((message) => message.userId)?.userId ?? null;

    resumeLaunch = await enqueueCloudTask({
      task: {
        type: TaskPayloadKind.SnapshotResume,
        sourceSnapshotId: snapshotId,
        sourceCloudJobId: sourceJob.id,
        payload: payloadForResume,
      },
      actingUserId: resumeActingUserId,
    });
  } catch (error) {
    try {
      if (messages.length > 0) {
        await prependLinearMessages(sourceJob.id, messages);
      }
      if (issueId) {
        await redis.del(`${RESUME_LOCK_PREFIX}${issueId}`);
      }
    } catch {
      // no-op
    }
    throw error;
  }

  console.log(
    `[drainLinearMessagesToResumeJob] Created resume cloud job ${resumeLaunch.id} with ${messages.length} Linear message(s)`,
  );

  return {
    resumed: true,
    cloudJobId: resumeLaunch.id,
    taskId: resumeLaunch.taskId,
    messageCount: messages.length,
  };
}
