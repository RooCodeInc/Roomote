import type { TelegramUpdateCommunicationMetadata } from '@roomote/communication/telegram-update';
import { setLatestInboundMessageId } from '@roomote/communication/messages';
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

import { apiLogger } from '../../logging.js';
import { buildTelegramCancelTaskCallbackData } from './callback-data.js';
import {
  createTelegramForumTopicBestEffort,
  postTelegramMessageBestEffort,
} from './replies.js';
import type {
  QueuedTelegramCommunicationMessage,
  TelegramWorkspaceSelection,
} from './types.js';

/** Telegram caps forum topic names at 128 chars; stay well under it. */
const MAX_TOPIC_NAME_LENGTH = 64;

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

function buildTelegramTaskTopicName(taskText: string): string {
  const firstLine =
    taskText
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .find((line) => line.length > 0) ?? '';
  const name = firstLine || 'Roomote task';

  return name.length > MAX_TOPIC_NAME_LENGTH
    ? `${name.slice(0, MAX_TOPIC_NAME_LENGTH - 1)}…`
    : name;
}

/**
 * Deep link to a forum topic. Only derivable for supergroups (ids prefixed
 * `-100`); members of the group can open it even when the group is private.
 */
function buildTelegramTopicUrl(
  chatId: string,
  topicThreadId: string,
): string | null {
  return chatId.startsWith('-100')
    ? `https://t.me/c/${chatId.slice(4)}/${topicThreadId}`
    : null;
}

/**
 * Enqueue a standard cloud task for a Telegram request and post the
 * task-started message (with follow/cancel buttons) back to the chat. Shared
 * by the immediate launch path, the routing-confirmation buttons, and the
 * confirmation auto-start timer.
 *
 * In Topics-enabled supergroups, a task launched outside any topic gets its
 * own forum topic: the job's thread id points at the new topic, so the
 * started card, worker replies, and follow-ups all live there — Telegram's
 * native equivalent of a Slack thread. Launches from inside an existing
 * topic stay in that topic, and topic-creation failure (bot lacking the
 * manage-topics right, plain groups) falls back to the current in-chat
 * behavior rather than dropping the task.
 */
export async function launchTelegramTask(input: {
  launchOwnerUserId: string;
  queuedMessage: QueuedTelegramCommunicationMessage;
  metadata: TelegramUpdateCommunicationMetadata;
  workspace: TelegramWorkspaceSelection;
  chatIsForum?: boolean;
}) {
  let metadata = input.metadata;
  let taskTopic: { threadId: string; name: string } | null = null;

  if (input.chatIsForum && !metadata.communicationThreadId) {
    taskTopic = await createTelegramForumTopicBestEffort({
      chatId: metadata.communicationChannelId,
      name: buildTelegramTaskTopicName(input.queuedMessage.text),
    });

    if (taskTopic) {
      metadata = { ...metadata, communicationThreadId: taskTopic.threadId };
    }
  }

  const task: Extract<CloudTask, { type: CloudTaskType.StandardTask }> = {
    type: CloudTaskType.StandardTask,
    userId: input.launchOwnerUserId,
    payload: {
      repo: input.workspace.repoForPayload,
      ...(input.workspace.environmentId
        ? { environmentId: input.workspace.environmentId }
        : {}),
      description: input.queuedMessage.text,
      ...metadata,
    },
  };
  const launchResult = await enqueueCloudTask(task, {
    launchClass: 'human',
  });

  const taskUrl = getTaskUrl({
    taskId: launchResult.taskId,
    utm: { source: 'telegram', campaign: 'telegram.thread_start' },
  });

  const startedMessage = await postTelegramMessageBestEffort({
    chatId: metadata.communicationChannelId,
    threadId: metadata.communicationThreadId,
    // A reply anchor cannot cross topics, so a task that just got its own
    // topic posts the card unanchored there.
    replyToMessageId: taskTopic ? undefined : metadata.communicationMessageId,
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

  if (taskTopic) {
    // Worker replies quote the latest inbound message; the launch message
    // lives outside the topic, so re-anchor to the in-topic started card.
    if (startedMessage) {
      try {
        await setLatestInboundMessageId(
          'telegram',
          launchResult.id,
          startedMessage.messageId,
        );
      } catch (error) {
        apiLogger.warn(
          `[telegram] Failed to anchor replies to the task topic for cloud job ${launchResult.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Leave a pointer where the user asked so the topic is discoverable.
    const topicUrl = buildTelegramTopicUrl(
      metadata.communicationChannelId,
      taskTopic.threadId,
    );
    await postTelegramMessageBestEffort({
      chatId: metadata.communicationChannelId,
      replyToMessageId: input.metadata.communicationMessageId,
      text: `Started in its own topic: “${taskTopic.name}”`,
      ...(topicUrl
        ? { buttons: [[{ text: 'Open topic', url: topicUrl }]] }
        : {}),
    });
  }

  return launchResult;
}
