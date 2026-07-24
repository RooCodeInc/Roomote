import { enqueueTask } from '@roomote/cloud-agents/server';
import {
  getCommunicationMessages,
  peekCommunicationMessageCount,
  prependCommunicationMessages,
} from '@roomote/communication';
import { db, recordTaskRunEvent } from '@roomote/db/server';
import { getRedis } from '@roomote/redis';
import {
  ALL_REPOSITORIES,
  TaskPayloadKind,
  getCommunicationProviderFromTaskPayload,
  populateSnapshotResumeCommunicationMetadata,
  restoreSnapshotResumeVisiblePromptFields,
  type CommunicationProvider,
  type QueuedCommunicationMessage,
  type TaskPayload,
} from '@roomote/types';

const RESUME_LOCK_TTL_SECONDS = 30;

/**
 * Payload flags that must survive into a resume run so its outbound messages
 * keep landing in the right provider surface (dedicated thread/topic).
 */
const PRESERVED_PAYLOAD_FLAGS = ['discordTaskThread', 'telegramTaskTopic'];

/**
 * Minimum shape of the source task run required by the drain helper, kept
 * narrow so both SDK routers (full DB rows) and the BullMQ snapshot handler
 * (partial query results) can call it.
 */
interface CommunicationDrainSourceRun {
  id: number;
  taskId?: string;
  snapshotId: string | null;
  payload: Record<string, unknown>;
  port: number | null;
}

type CommunicationDrainResult =
  | {
      resumed: true;
      runId: number;
      taskId: string;
      provider: CommunicationProvider;
      messageCount: number;
    }
  | { resumed: false; reason: string; provider?: CommunicationProvider };

/**
 * Peek for pending Discord/Telegram/Teams messages on a snapshotted task run
 * and, if any exist, create a SnapshotResume run that embeds them for worker
 * replay. The non-Slack counterpart of `drainSlackMessagesToResumeRun`:
 * without it, a message queued into a run whose poller died before the
 * due-sleep snapshot is orphaned in Redis until its TTL expires — the run
 * sleeps, nothing ever wakes it, and the sender's prompt silently vanishes.
 *
 * If resume creation fails, the drained messages are restored to the source
 * run's queue.
 */
export async function drainCommunicationMessagesToResumeRun(
  sourceRun: CommunicationDrainSourceRun,
  snapshotIdOverride?: string,
): Promise<CommunicationDrainResult> {
  const provider = getCommunicationProviderFromTaskPayload(sourceRun.payload);

  if (!provider || provider === 'slack') {
    return { resumed: false, reason: 'no_communication_provider' };
  }

  const snapshotId = snapshotIdOverride ?? sourceRun.snapshotId;

  if (!snapshotId) {
    return { resumed: false, reason: 'no_snapshot', provider };
  }

  const messageCount = await peekCommunicationMessageCount(
    provider,
    sourceRun.id,
  );

  if (messageCount === 0) {
    return { resumed: false, reason: 'no_pending_messages', provider };
  }

  // One drain per source run at a time; the atomic queue pop keeps a race
  // with a concurrent inbound-message resume from duplicating messages.
  const redis = getRedis();
  const lockKey = `${provider}:drain-resume-lock:${sourceRun.id}`;
  const acquired = await redis.set(
    lockKey,
    '1',
    'EX',
    RESUME_LOCK_TTL_SECONDS,
    'NX',
  );

  if (!acquired) {
    return { resumed: false, reason: 'resume_lock_held', provider };
  }

  const sourcePayload = sourceRun.payload;
  const repo =
    typeof sourcePayload?.repo === 'string'
      ? sourcePayload.repo
      : ALL_REPOSITORIES;
  const environmentId =
    typeof sourcePayload?.environmentId === 'string'
      ? sourcePayload.environmentId
      : undefined;

  let messages: QueuedCommunicationMessage[] = [];

  try {
    messages = await getCommunicationMessages(provider, sourceRun.id);

    if (messages.length === 0) {
      await redis.del(lockKey);
      return { resumed: false, reason: 'no_pending_messages', provider };
    }

    const resumePayload: TaskPayload<typeof TaskPayloadKind.SnapshotResume> = {
      repo,
      ...(environmentId ? { environmentId } : {}),
      ...(sourceRun.port ? { port: sourceRun.port } : {}),
      sourceSnapshotId: snapshotId,
      sourceRunId: sourceRun.id,
      queuedCommunicationMessages: messages.map((message) => ({
        ...message,
        provider,
      })),
    };
    populateSnapshotResumeCommunicationMetadata(resumePayload, {
      provider,
      sourcePayload,
    });
    for (const key of PRESERVED_PAYLOAD_FLAGS) {
      if (sourcePayload[key] === true) {
        (resumePayload as Record<string, unknown>)[key] = true;
      }
    }
    restoreSnapshotResumeVisiblePromptFields(resumePayload, sourcePayload);

    // The resumer becomes the new run's acting user: the most recent drained
    // follow-up sender we could resolve to a Roomote user.
    const resumeActingUserId =
      [...messages].reverse().find((message) => message.userId)?.userId ?? null;

    const resumeLaunch = await enqueueTask({
      task: {
        type: TaskPayloadKind.SnapshotResume,
        sourceSnapshotId: snapshotId,
        sourceRunId: sourceRun.id,
        payload: resumePayload,
      },
      actingUserId: resumeActingUserId,
    });

    try {
      await recordTaskRunEvent(db, {
        runId: sourceRun.id,
        taskId: sourceRun.taskId,
        source: 'snapshot_resume',
        eventType: 'decision',
        message: `Drained ${messages.length} undelivered queued ${provider} message(s) into snapshot resume run #${resumeLaunch.id}.`,
        details: {
          provider,
          drainedCount: messages.length,
          drainedTs: messages.map((message) => message.ts),
          resumeRunId: resumeLaunch.id,
        },
      });
    } catch (eventError) {
      console.warn(
        `[drainCommunicationMessagesToResumeRun] Failed to record drain event for run ${sourceRun.id}: ${
          eventError instanceof Error ? eventError.message : String(eventError)
        }`,
      );
    }

    console.log(
      `[drainCommunicationMessagesToResumeRun] Created resume task run ${resumeLaunch.id} with ${messages.length} ${provider} message(s)`,
    );

    return {
      resumed: true,
      runId: resumeLaunch.id,
      taskId: resumeLaunch.taskId,
      provider,
      messageCount: messages.length,
    };
  } catch (error) {
    // Restore drained messages and release the lock so a retry can proceed.
    try {
      if (messages.length > 0) {
        await prependCommunicationMessages(provider, sourceRun.id, messages);
      }
      await redis.del(lockKey);
    } catch {
      // no-op
    }
    throw error;
  }
}
