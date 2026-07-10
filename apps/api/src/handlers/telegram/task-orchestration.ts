import type {
  TelegramMessage,
  TelegramUpdateCommunicationMetadata,
} from '@roomote/communication/telegram-update';
import { Env } from '@roomote/env';
import {
  ALL_REPOSITORIES,
  CloudTaskType,
  type CloudTaskPayload,
  populateSnapshotResumeCommunicationMetadata,
  restoreSnapshotResumeVisiblePromptFields,
} from '@roomote/types';
import {
  buildTelegramRoutingContext,
  enqueueCloudTask,
  getTaskUrl,
  routeTask,
} from '@roomote/cloud-agents/server';

import type { CompletedTelegramJob } from './job-lookup.js';
import { maybeRequestTelegramRoutingConfirmation } from './routing-confirmation.js';
import { postTelegramMessageBestEffort } from './replies.js';
import { launchTelegramTask, resolveTelegramWorkspace } from './task-launch.js';
import type {
  QueuedTelegramCommunicationMessage,
  TelegramConversationRef,
} from './types.js';

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
}

export async function resumeTelegramTaskFromSnapshot(input: {
  completedJob: CompletedTelegramJob;
  queuedMessage: QueuedTelegramCommunicationMessage;
  metadata: TelegramUpdateCommunicationMetadata;
}) {
  const sourceSnapshotId = input.completedJob.snapshotId;

  if (!sourceSnapshotId) {
    throw new Error('Telegram snapshot resume requires a source snapshot.');
  }

  const completedPayload = input.completedJob.payload as Record<
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
  const resumePayload: CloudTaskPayload<CloudTaskType.SnapshotResume> = {
    repo,
    ...(environmentId ? { environmentId } : {}),
    ...(input.completedJob.port ? { port: input.completedJob.port } : {}),
    sourceSnapshotId,
    sourceCloudJobId: input.completedJob.id,
    queuedCommunicationMessages: [input.queuedMessage],
  };

  populateSnapshotResumeCommunicationMetadata(resumePayload, {
    provider: 'telegram',
    sourcePayload: completedPayload,
    channelId: input.metadata.communicationChannelId,
    threadId: input.metadata.communicationThreadId,
    messageId: input.metadata.communicationMessageId,
  });
  restoreSnapshotResumeVisiblePromptFields(resumePayload, completedPayload);

  return enqueueCloudTask(
    {
      type: CloudTaskType.SnapshotResume,
      userId: input.queuedMessage.userId,
      sourceSnapshotId,
      sourceCloudJobId: input.completedJob.id,
      payload: resumePayload,
    },
    {
      launchClass: 'human',
    },
  );
}

export async function replyToTelegramSnapshotResume(input: {
  launchResult: Awaited<ReturnType<typeof resumeTelegramTaskFromSnapshot>>;
  conversation: TelegramConversationRef & { replyToMessageId?: string };
}): Promise<void> {
  await postTelegramMessageBestEffort({
    chatId: input.conversation.chatId,
    threadId: input.conversation.threadId,
    replyToMessageId: input.conversation.replyToMessageId,
    text: `Reconnected this Telegram chat to the task: ${getTaskUrl({
      taskId: input.launchResult.taskId,
      utm: {
        source: 'telegram',
        campaign: 'telegram.snapshot_resume',
      },
    })}`,
  });
}

export async function startNewTelegramTask(input: {
  message: TelegramMessage;
  launchOwnerUserId: string;
  queuedMessage: QueuedTelegramCommunicationMessage;
  metadata: TelegramUpdateCommunicationMetadata;
  /**
   * Launch without the routing-confirmation card. Used when the user already
   * expressed explicit intent (for example a suggestion button click).
   */
  skipRoutingConfirmation?: boolean;
}) {
  const routingContext = await buildTelegramRoutingContext({
    userId: input.launchOwnerUserId,
    taskDescription: input.queuedMessage.text,
    chatName:
      cleanOptionalString(input.message.chat.title) ??
      cleanOptionalString(input.message.chat.username) ??
      input.queuedMessage.channel,
    threadMessages: [
      {
        user: input.queuedMessage.user,
        text: input.queuedMessage.text,
      },
    ],
    apiBaseUrl: Env.TRPC_URL ?? Env.ROOMOTE_APP_URL,
  });
  const routingDecision = await routeTask(routingContext);

  if (routingDecision.status === 'platform_answer') {
    await postTelegramMessageBestEffort({
      chatId: input.metadata.communicationChannelId,
      threadId: input.metadata.communicationThreadId,
      replyToMessageId: input.metadata.communicationMessageId,
      text: routingDecision.result.answer,
      textFormat: 'markdown',
    });

    return {
      status: 'replied_inline' as const,
      routingDecision,
    };
  }

  const chatIsForum = input.message.chat.is_forum === true;

  if (!input.skipRoutingConfirmation) {
    const confirmation = await maybeRequestTelegramRoutingConfirmation({
      routingDecision,
      launchOwnerUserId: input.launchOwnerUserId,
      queuedMessage: input.queuedMessage,
      metadata: input.metadata,
      chatIsForum,
    });

    if (confirmation) {
      return {
        status: 'confirmation_pending' as const,
        routingDecision,
        pendingRouteId: confirmation.pendingRouteId,
      };
    }
  }

  const workspace =
    routingDecision.status === 'routed'
      ? await resolveTelegramWorkspace(routingDecision.result.workspace)
      : {
          repoForPayload: ALL_REPOSITORIES,
          workspaceDisplayName: 'all repos',
        };

  if (!workspace) {
    throw new Error('Telegram task routing selected an unavailable workspace.');
  }

  const launchResult = await launchTelegramTask({
    launchOwnerUserId: input.launchOwnerUserId,
    queuedMessage: input.queuedMessage,
    metadata: input.metadata,
    workspace,
    chatIsForum,
  });

  return {
    status: 'started' as const,
    launchResult,
    routingDecision,
    workspace,
  };
}
