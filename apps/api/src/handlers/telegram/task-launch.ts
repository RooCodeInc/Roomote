import type { TelegramUpdateCommunicationMetadata } from '@roomote/communication/telegram-update';
import {
  ALL_REPOSITORIES,
  buildTelegramMessagePermalink,
  TaskPayloadKind,
  type TaskGoalInput,
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
  editTelegramForumTopicBestEffort,
  postTelegramMessageBestEffort,
} from './replies.js';
import {
  consumeTelegramImplicitTopic,
  rememberTelegramImplicitTopic,
} from './webhook-gate.js';
import { buildCommunicationTaskThreadName } from '../tasks/communication-task-thread.js';
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
  privateTopicsEnabled?: boolean;
  threadId?: string;
  forceNewTopic?: boolean;
}): boolean {
  const supportsTopics =
    (input.chatType.toLowerCase() === 'private' &&
      input.privateTopicsEnabled === true) ||
    input.isForum === true;

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
  goal?: TaskGoalInput;
}) {
  const topicName = buildTelegramTaskTopicName(input.queuedMessage.text);
  const createdTopic = input.createTopicForTask
    ? await createTelegramForumTopicBestEffort({
        chatId: input.metadata.communicationChannelId,
        name: topicName,
      })
    : null;
  const titleThreadId =
    createdTopic?.threadId ?? input.metadata.communicationThreadId;
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
        ...(input.queuedMessage.images?.length
          ? { images: input.queuedMessage.images }
          : {}),
        ...metadata,
        ...(createdTopic ? { telegramTaskTopic: true } : {}),
      },
    };
  const launchResult = await enqueueTask(
    {
      task,
      initiator: { kind: 'user', userId: input.launchOwnerUserId },
      workflow: 'standard',
      surface: 'telegram',
      trigger: 'message',
      ...(input.goal ? { goal: input.goal } : {}),
    },
    {
      launchClass: 'human',
      ...(titleThreadId
        ? {
            onEarlyTitleGenerated: async ({ title }: { title: string }) => {
              const shouldRename =
                Boolean(createdTopic) ||
                (await consumeTelegramImplicitTopic({
                  chatId: metadata.communicationChannelId,
                  threadId: titleThreadId,
                }));

              if (!shouldRename) {
                return;
              }

              const renamed = await editTelegramForumTopicBestEffort({
                chatId: metadata.communicationChannelId,
                threadId: titleThreadId,
                name: buildTelegramTaskTopicName(title),
              });

              if (!renamed) {
                if (!createdTopic) {
                  await rememberTelegramImplicitTopic({
                    chatId: metadata.communicationChannelId,
                    threadId: titleThreadId,
                  });
                }
                // Keep checkpoint 0 open so topic rename can retry on the
                // first-message title refresh path.
                throw new Error(
                  `Failed to rename Telegram topic ${titleThreadId} with generated title`,
                );
              }
            },
          }
        : {}),
    },
  );

  const taskUrl = getTaskUrl({
    taskId: launchResult.taskId,
    utm: { source: 'telegram', campaign: 'telegram.thread_start' },
  });

  const taskAcknowledgement = await postTelegramMessageBestEffort({
    chatId: metadata.communicationChannelId,
    threadId: metadata.communicationThreadId,
    // The source message is in the previous topic (usually General), so only
    // the mirrored request can be used as a reply anchor in the new topic.
    replyToMessageId: createdTopic
      ? topicRootMessage?.messageId
      : metadata.communicationMessageId,
    text: buildTelegramTaskAcknowledgementText({
      workspaceDisplayName: input.workspace.workspaceDisplayName,
      started: Boolean(taskUrl),
      topicCreationFailed: Boolean(input.createTopicForTask && !createdTopic),
    }),
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

  if (createdTopic) {
    const topicUrl = buildTelegramMessagePermalink({
      chatId: input.metadata.communicationChannelId,
      threadId: createdTopic.threadId,
      messageId:
        topicRootMessage?.messageId ?? taskAcknowledgement?.messageId ?? null,
    });

    await postTelegramMessageBestEffort({
      chatId: input.metadata.communicationChannelId,
      threadId: input.metadata.communicationThreadId,
      replyToMessageId: input.metadata.communicationMessageId,
      text: topicUrl
        ? `Started “${topicName}” in a new topic.`
        : `Started “${topicName}” in a new topic. Open it from Telegram's topic list.`,
      buttons: [
        [
          ...(topicUrl ? [{ text: 'Open topic', url: topicUrl }] : []),
          ...(taskUrl ? [{ text: 'Follow Task', url: taskUrl }] : []),
        ],
      ].filter((row) => row.length > 0),
    });
  }

  return launchResult;
}

function buildTelegramTaskAcknowledgementText(input: {
  workspaceDisplayName: string;
  started: boolean;
  topicCreationFailed: boolean;
}): string {
  const action = input.started ? 'Started' : 'Queued';
  const base = `${action} a task in ${input.workspaceDisplayName}`;

  return input.topicCreationFailed
    ? `${base} here because I couldn't create a new Telegram topic. If this keeps happening, check Threaded Mode or the bot's Manage Topics permission.`
    : `${base}.`;
}

const TELEGRAM_TASK_TOPIC_NAME_MAX_LENGTH = 96;

export function buildTelegramTaskTopicName(description: string): string {
  return buildCommunicationTaskThreadName(
    description,
    TELEGRAM_TASK_TOPIC_NAME_MAX_LENGTH,
  );
}
