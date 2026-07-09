import type { TelegramUpdateCommunicationMetadata } from '@roomote/communication/telegram-update';
import {
  ALL_REPOSITORIES,
  CloudTaskType,
  type CloudTask,
} from '@roomote/types';
import { db, environments, eq } from '@roomote/db/server';
import {
  enqueueCloudTask,
  getTaskUrl,
  type RoutingWorkspace,
} from '@roomote/cloud-agents/server';

import { buildTelegramCancelTaskCallbackData } from './callback-data.js';
import { postTelegramMessageBestEffort } from './replies.js';
import type {
  QueuedTelegramCommunicationMessage,
  TelegramWorkspaceSelection,
} from './types.js';

export async function resolveTelegramWorkspace(
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

/**
 * Enqueue a standard cloud task for a Telegram request and post the
 * task-started message (with follow/cancel buttons) back to the chat. Shared
 * by the immediate launch path, the routing-confirmation buttons, and the
 * confirmation auto-start timer.
 */
export async function launchTelegramTask(input: {
  launchOwnerUserId: string;
  queuedMessage: QueuedTelegramCommunicationMessage;
  metadata: TelegramUpdateCommunicationMetadata;
  workspace: TelegramWorkspaceSelection;
}) {
  const task: Extract<CloudTask, { type: CloudTaskType.StandardTask }> = {
    type: CloudTaskType.StandardTask,
    userId: input.launchOwnerUserId,
    payload: {
      repo: input.workspace.repoForPayload,
      ...(input.workspace.environmentId
        ? { environmentId: input.workspace.environmentId }
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
      ? `Started a task in ${input.workspace.workspaceDisplayName}.`
      : `Queued a task in ${input.workspace.workspaceDisplayName}.`,
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

  return launchResult;
}
