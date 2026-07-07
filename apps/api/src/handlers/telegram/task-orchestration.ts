import type {
  TelegramMessage,
  TelegramUpdateCommunicationMetadata,
} from '@roomote/communication/telegram-update';
import { Env } from '@roomote/env';
import {
  ALL_REPOSITORIES,
  CloudTaskType,
  type CloudTask,
  type CloudTaskPayload,
  populateSnapshotResumeCommunicationMetadata,
  restoreSnapshotResumeVisiblePromptFields,
} from '@roomote/types';
import { db, environments, eq } from '@roomote/db/server';
import {
  buildTelegramRoutingContext,
  enqueueCloudTask,
  getTaskUrl,
  routeTask,
  type RoutingWorkspace,
} from '@roomote/cloud-agents/server';

import type { CompletedTelegramJob } from './job-lookup.js';
import { buildTelegramCancelTaskCallbackData } from './callback-actions.js';
import { postTelegramMessageBestEffort } from './replies.js';
import type {
  QueuedTelegramCommunicationMessage,
  TelegramConversationRef,
  TelegramWorkspaceSelection,
} from './types.js';

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
}

async function resolveTelegramWorkspace(
  workspace: RoutingWorkspace,
): Promise<TelegramWorkspaceSelection | null> {
  if (workspace.type === 'all_repositories') {
    return {
      repoForPayload: ALL_REPOSITORIES,
      workspaceDisplayName: 'all repos',
    };
  }

  const environment = await db.query.environments.findFirst({
    where: eq(environments.id, workspace.id),
    columns: { id: true, name: true, config: true },
  });

  if (!environment) {
    return null;
  }

  const config = environment.config as {
    repositories?: Array<{ repository: string }>;
  };
  const firstRepo = config.repositories?.[0]?.repository;

  if (!firstRepo) {
    return null;
  }

  return {
    environmentId: environment.id,
    repoForPayload: firstRepo,
    workspaceDisplayName: environment.name,
  };
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

  const task: Extract<CloudTask, { type: CloudTaskType.StandardTask }> = {
    type: CloudTaskType.StandardTask,
    userId: input.launchOwnerUserId,
    payload: {
      repo: workspace.repoForPayload,
      ...(workspace.environmentId
        ? { environmentId: workspace.environmentId }
        : {}),
      description: input.queuedMessage.text,
      ...input.metadata,
    },
  };
  const launchResult = await enqueueCloudTask(task, {
    launchClass: 'human',
  });

  const taskUrl = getTaskUrl({
    taskId: launchResult.taskId,
    utm: { source: 'telegram', campaign: 'telegram.thread_start' },
  });

  await postTelegramMessageBestEffort({
    chatId: input.metadata.communicationChannelId,
    threadId: input.metadata.communicationThreadId,
    replyToMessageId: input.metadata.communicationMessageId,
    text: taskUrl
      ? `Started a task in ${workspace.workspaceDisplayName}.`
      : `Queued a task in ${workspace.workspaceDisplayName}.`,
    buttons: [
      ...(taskUrl ? [[{ text: 'Follow Task', url: taskUrl }]] : []),
      [
        {
          text: '✖️ Cancel task',
          callbackData: buildTelegramCancelTaskCallbackData(launchResult.id),
        },
      ],
    ],
  });

  return {
    status: 'started' as const,
    launchResult,
    routingDecision,
    workspace,
  };
}
