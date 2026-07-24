import { enqueueTask } from '@roomote/cloud-agents/server';
import {
  getCommunicationMessages,
  prependCommunicationMessages,
} from '@roomote/communication';
import { db, recordTaskRunEvent } from '@roomote/db/server';
import {
  ALL_REPOSITORIES,
  TaskPayloadKind,
  populateSnapshotResumeCommunicationMetadata,
  restoreSnapshotResumeVisiblePromptFields,
  type CommunicationProvider,
  type QueuedCommunicationMessage,
  type TaskPayload,
} from '@roomote/types';

import {
  attachOutOfBandContextToCommunicationMessage,
  releaseCommunicationOutOfBandClaim,
} from './communication-out-of-band-context';

/**
 * Drain any messages still sitting in the source run's per-run Redis queue.
 * They were queued while that run was alive but never delivered (for example
 * when its poller wedged before the due-sleep snapshot), so a resume that
 * ignored them would orphan those prompts permanently. Callers must either
 * hand the drained messages to the resume run or put them back.
 */
async function drainUndeliveredCommunicationMessages(
  provider: CommunicationProvider,
  sourceRunId: number,
): Promise<QueuedCommunicationMessage[]> {
  try {
    return await getCommunicationMessages(provider, sourceRunId);
  } catch (error) {
    console.error(
      `[resumeCommunicationTaskFromSnapshot] Failed to drain undelivered ${provider} messages for source run ${sourceRunId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return [];
  }
}

async function recordCarriedMessagesEvent(input: {
  provider: CommunicationProvider;
  sourceRunId: number;
  taskId?: string;
  carried: QueuedCommunicationMessage[];
}): Promise<void> {
  try {
    await recordTaskRunEvent(db, {
      runId: input.sourceRunId,
      taskId: input.taskId,
      source: 'snapshot_resume',
      eventType: 'decision',
      message: `Carried ${input.carried.length} undelivered queued ${input.provider} message(s) from run #${input.sourceRunId} into the snapshot resume payload.`,
      details: {
        provider: input.provider,
        carriedCount: input.carried.length,
        carriedTs: input.carried.map((message) => message.ts),
      },
    });
  } catch (error) {
    console.warn(
      `[resumeCommunicationTaskFromSnapshot] Failed to record carried-messages event for source run ${input.sourceRunId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

type CompletedCommunicationTaskRun = {
  id: number;
  taskId?: string;
  payload: unknown;
  port: number | null;
  snapshotId: string | null;
};

export async function resumeCommunicationTaskFromSnapshot(input: {
  provider: CommunicationProvider;
  completedRun: CompletedCommunicationTaskRun;
  queuedMessage: QueuedCommunicationMessage;
  channelId: string;
  threadId?: string;
  messageId?: string;
  guildId?: string;
  preservePayloadFlags?: string[];
  /**
   * Discord wake-up 👀 target (thread or DM channel hosting the resume
   * message). When set with intakeAckPinned, worker onStart clears eyes.
   */
  discordWakeAckReaction?: {
    channelId: string;
    messageId: string;
    intakeAckPinned: boolean;
  };
}) {
  if (!input.completedRun.snapshotId) {
    throw new Error(
      `${input.provider} snapshot resume requires a source snapshot.`,
    );
  }

  const completedPayload = input.completedRun.payload as Record<
    string,
    unknown
  >;
  const repo =
    typeof completedPayload.repo === 'string'
      ? completedPayload.repo
      : ALL_REPOSITORIES;
  const environmentId =
    typeof completedPayload.environmentId === 'string'
      ? completedPayload.environmentId
      : undefined;

  // Slack resumes build their own `<replying_to>` / thread context. Non-Slack
  // providers need the out-of-band claim path so background PR review
  // notifications re-enter the next turn.
  let queuedMessage: QueuedCommunicationMessage = {
    ...input.queuedMessage,
    provider: input.provider,
  };
  let outOfBandClaim: { messageIds: string[] } | null = null;
  if (input.provider !== 'slack' && input.completedRun.taskId) {
    const attached = await attachOutOfBandContextToCommunicationMessage({
      taskId: input.completedRun.taskId,
      provider: input.provider,
      message: queuedMessage,
    });
    queuedMessage = attached.message;
    outOfBandClaim = attached.claim;
  }

  // Undelivered leftovers ride ahead of the new message so the resume run
  // replays the conversation in its original order.
  const undeliveredMessages = (
    await drainUndeliveredCommunicationMessages(
      input.provider,
      input.completedRun.id,
    )
  ).filter((message) => message.ts !== queuedMessage.ts);

  if (undeliveredMessages.length > 0) {
    await recordCarriedMessagesEvent({
      provider: input.provider,
      sourceRunId: input.completedRun.id,
      taskId: input.completedRun.taskId,
      carried: undeliveredMessages,
    });
  }

  const resumePayload: TaskPayload<typeof TaskPayloadKind.SnapshotResume> = {
    repo,
    ...(environmentId ? { environmentId } : {}),
    ...(input.completedRun.port ? { port: input.completedRun.port } : {}),
    sourceSnapshotId: input.completedRun.snapshotId,
    sourceRunId: input.completedRun.id,
    queuedCommunicationMessages: [
      ...undeliveredMessages.map((message) => ({
        ...message,
        provider: input.provider,
      })),
      {
        ...queuedMessage,
        provider: input.provider,
      },
    ],
  };
  populateSnapshotResumeCommunicationMetadata(resumePayload, {
    provider: input.provider,
    sourcePayload: completedPayload,
    channelId: input.channelId,
    threadId: input.threadId,
    messageId: input.messageId,
    guildId: input.guildId,
  });
  if (input.provider === 'discord') {
    resumePayload.communicationSourceEventId = input.queuedMessage.ts;
    // Match Slack SnapshotResume: pin eyes on the waking message and record
    // the target so worker onStart can clear it once the runtime is up.
    const wakeAck = input.discordWakeAckReaction;
    if (wakeAck?.messageId && wakeAck.channelId) {
      resumePayload.discordReactionChannelId = wakeAck.channelId;
      resumePayload.discordReactionMessageId = wakeAck.messageId;
      if (wakeAck.intakeAckPinned) {
        resumePayload.discordIntakeAckPending = true;
      }
    }
  }
  for (const key of input.preservePayloadFlags ?? []) {
    if (completedPayload[key] === true) {
      (resumePayload as Record<string, unknown>)[key] = true;
    }
  }
  restoreSnapshotResumeVisiblePromptFields(resumePayload, completedPayload);

  try {
    return await enqueueTask(
      {
        task: {
          type: TaskPayloadKind.SnapshotResume,
          sourceSnapshotId: input.completedRun.snapshotId,
          sourceRunId: input.completedRun.id,
          payload: resumePayload,
        },
        actingUserId: input.queuedMessage.userId ?? null,
      },
      { launchClass: 'human' },
    );
  } catch (error) {
    await releaseCommunicationOutOfBandClaim(outOfBandClaim);

    if (undeliveredMessages.length > 0) {
      // The resume never launched; put the drained leftovers back so the next
      // resume attempt can carry them again.
      try {
        await prependCommunicationMessages(
          input.provider,
          input.completedRun.id,
          undeliveredMessages,
        );
      } catch (requeueError) {
        console.error(
          `[resumeCommunicationTaskFromSnapshot] Failed to requeue ${undeliveredMessages.length} drained ${input.provider} message(s) for source run ${input.completedRun.id}: ${
            requeueError instanceof Error
              ? requeueError.message
              : String(requeueError)
          }`,
        );
      }
    }

    throw error;
  }
}
