import type { TelegramUpdateCommunicationMetadata } from '@roomote/communication/telegram-update';
import {
  ALL_REPOSITORIES,
  TaskPayloadKind,
  type TaskSpec,
} from '@roomote/types';
import { db, environments, eq } from '@roomote/db/server';
import {
  enqueueTask,
  getTaskUrl,
  type RoutingWorkspace,
} from '@roomote/cloud-agents/server';

import { buildTelegramCancelTaskCallbackData } from './callback-data.js';
import {
  createTelegramForumTopicBestEffort,
  postTelegramMessageBestEffort,
} from './replies.js';
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

export function shouldCreateTelegramTaskTopic(input: {
  chatType: string;
  isForum?: boolean;
  threadId?: string;
  forceNewTopic?: boolean;
}): boolean {
  const supportsTopics =
    input.chatType.toLowerCase() === 'private' || input.isForum === true;

  return supportsTopics && (!input.threadId || input.forceNewTopic === true);
}

/**
 * Enqueue a standard task for a Telegram request and post the
 * task-started message (with follow/cancel buttons) back to the chat. Shared
 * by the immediate launch path, the routing-confirmation buttons, and the
 * confirmation auto-start timer.
 */
export async function launchTelegramTask(input: {
  launchOwnerUserId: string;
  queuedMessage: QueuedTelegramCommunicationMessage;
  metadata: TelegramUpdateCommunicationMetadata;
  workspace: TelegramWorkspaceSelection;
  createTopicForTask?: boolean;
}) {
  const createdTopic = input.createTopicForTask
    ? await createTelegramForumTopicBestEffort({
        chatId: input.metadata.communicationChannelId,
        name: buildTelegramTaskTopicName(input.queuedMessage.text),
      })
    : null;
  const topicRootMessage = createdTopic
    ? await postTelegramMessageBestEffort({
        chatId: input.metadata.communicationChannelId,
        threadId: createdTopic.threadId,
        text: `Task request from ${input.queuedMessage.user}:\n\n${input.queuedMessage.text}`,
      })
    : null;
  const metadata = createdTopic
    ? {
        communicationProvider: input.metadata.communicationProvider,
        communicationChannelId: input.metadata.communicationChannelId,
        communicationThreadId: createdTopic.threadId,
        ...(topicRootMessage
          ? { communicationMessageId: topicRootMessage.messageId }
          : {}),
      }
    : input.metadata;
  const task: Extract<TaskSpec, { type: typeof TaskPayloadKind.StandardTask }> =
    {
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: input.workspace.repoForPayload,
        ...(input.workspace.environmentId
          ? { environmentId: input.workspace.environmentId }
          : {}),
        description: input.queuedMessage.text,
        ...metadata,
      },
    };
  const launchResult = await enqueueTask(
    {
      task,
      initiator: { kind: 'user', userId: input.launchOwnerUserId },
      workflow: 'standard',
      surface: 'telegram',
      trigger: 'message',
    },
    {
      launchClass: 'human',
    },
  );

  const taskUrl = getTaskUrl({
    taskId: launchResult.taskId,
    utm: { source: 'telegram', campaign: 'telegram.thread_start' },
  });

  await postTelegramMessageBestEffort({
    chatId: metadata.communicationChannelId,
    threadId: metadata.communicationThreadId,
    // The source message is in the previous topic (usually General), so only
    // the mirrored request can be used as a reply anchor in the new topic.
    replyToMessageId: createdTopic
      ? topicRootMessage?.messageId
      : metadata.communicationMessageId,
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

const TELEGRAM_TASK_TOPIC_NAME_MAX_LENGTH = 96;

export function buildTelegramTaskTopicName(description: string): string {
  const normalized = description.replace(/\s+/gu, ' ').trim();
  const characters = Array.from(normalized || 'Roomote task');

  return characters.length > TELEGRAM_TASK_TOPIC_NAME_MAX_LENGTH
    ? `${characters
        .slice(0, TELEGRAM_TASK_TOPIC_NAME_MAX_LENGTH - 1)
        .join('')}…`
    : characters.join('');
}
