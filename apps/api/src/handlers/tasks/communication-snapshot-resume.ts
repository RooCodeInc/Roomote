import { enqueueTask } from '@roomote/cloud-agents/server';
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
} from './communication-out-of-band-context.js';

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

  const resumePayload: TaskPayload<typeof TaskPayloadKind.SnapshotResume> = {
    repo,
    ...(environmentId ? { environmentId } : {}),
    ...(input.completedRun.port ? { port: input.completedRun.port } : {}),
    sourceSnapshotId: input.completedRun.snapshotId,
    sourceRunId: input.completedRun.id,
    queuedCommunicationMessages: [
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
    throw error;
  }
}
