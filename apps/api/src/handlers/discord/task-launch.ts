import {
  ALL_REPOSITORIES,
  TaskPayloadKind,
  type QueuedCommunicationMessage,
  type TaskSpec,
} from '@roomote/types';
import { db, environments, eq } from '@roomote/db/server';
import {
  enqueueTask,
  getTaskUrl,
  type RoutingWorkspace,
} from '@roomote/cloud-agents/server';
import {
  isDiscordUnknownMessageError,
  type DiscordCommunicationProvider,
  type DiscordTaskThread,
} from '@roomote/communication/discord-provider';
import type { DiscordEventCommunicationMetadata } from '@roomote/communication/discord-event';
import { getRedis } from '@roomote/redis';

import { buildCommunicationTaskThreadName } from '../tasks/communication-task-thread.js';
import {
  replaceOrPostDiscordMessage,
  type DiscordMessageToReplace,
} from './replies.js';
import {
  discordTaskAcknowledgementText,
  discordTaskButtons,
} from './task-messages.js';

const DISCORD_THREAD_TYPES = new Set([10, 11, 12]);
const DISCORD_ROOT_TASK_CHANNEL_TYPES = new Set([0, 5, 15, 16]);
// Text and announcement channels support Slack-style threads anchored to the
// triggering message; forum/media channels can only host detached posts.
const DISCORD_MESSAGE_ANCHORED_CHANNEL_TYPES = new Set([0, 5]);
const DISCORD_PENDING_TASK_THREAD_PREFIX = 'discord:pending_task_thread:';
const DISCORD_PENDING_TASK_THREAD_TTL_SECONDS = 24 * 60 * 60;

export type DiscordChannelContext = {
  channelId: string;
  channelName: string;
  channelType: number;
  guildId?: string;
  parentChannelId?: string;
  isDirectMessage: boolean;
  isThread: boolean;
};

type DiscordWorkspaceSelection = {
  environmentId?: string;
  repoForPayload: string;
  workspaceDisplayName: string;
};

export async function resolveDiscordChannelContext(
  provider: DiscordCommunicationProvider,
  channelId: string,
): Promise<DiscordChannelContext> {
  const channel = await provider.getChannel(channelId);
  const isThread = DISCORD_THREAD_TYPES.has(channel.type);
  return {
    channelId: channel.id,
    channelName: channel.name,
    channelType: channel.type,
    ...(channel.guildId ? { guildId: channel.guildId } : {}),
    ...(isThread && channel.parentId
      ? { parentChannelId: channel.parentId }
      : {}),
    isDirectMessage: channel.type === 1 || channel.type === 3,
    isThread,
  };
}

export function discordMetadataForChannel(input: {
  channel: DiscordChannelContext;
  messageId: string;
  /**
   * The real channel message that triggered the event — set only for
   * message events. Interactions have no message a task thread could
   * anchor to, so launches from them keep detached threads.
   */
  anchorMessageId?: string;
}): DiscordEventCommunicationMetadata {
  return {
    communicationProvider: 'discord',
    communicationChannelId:
      input.channel.parentChannelId ?? input.channel.channelId,
    ...(input.channel.parentChannelId
      ? { communicationThreadId: input.channel.channelId }
      : {}),
    communicationMessageId: input.messageId,
    ...(input.channel.guildId
      ? { communicationGuildId: input.channel.guildId }
      : {}),
    ...(input.anchorMessageId
      ? { communicationAnchorMessageId: input.anchorMessageId }
      : {}),
  };
}

export async function resolveDiscordWorkspace(
  workspace: RoutingWorkspace,
): Promise<DiscordWorkspaceSelection | null> {
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
  if (!environment) return null;
  const config = environment.config as {
    repositories?: Array<{ repository: string }>;
  };
  const firstRepo = config.repositories?.[0]?.repository;
  if (!firstRepo) return null;
  return {
    environmentId: environment.id,
    repoForPayload: firstRepo,
    workspaceDisplayName: environment.name,
  };
}

function taskThreadParentId(input: {
  channel: DiscordChannelContext;
  forceNewThread?: boolean;
}): string | null {
  if (!input.channel.guildId) return null;
  if (
    input.forceNewThread &&
    input.channel.isThread &&
    input.channel.parentChannelId
  ) {
    return input.channel.parentChannelId;
  }
  return !input.channel.isThread &&
    DISCORD_ROOT_TASK_CHANNEL_TYPES.has(input.channel.channelType)
    ? input.channel.channelId
    : null;
}

function pendingTaskThreadKey(sourceEventId: string): string {
  return `${DISCORD_PENDING_TASK_THREAD_PREFIX}${sourceEventId}`;
}

function parsePendingTaskThread(
  value: string | null,
  parentChannelId: string,
): DiscordTaskThread | null {
  if (!value) return null;
  try {
    const thread = JSON.parse(value) as Partial<DiscordTaskThread>;
    if (
      typeof thread.channelId !== 'string' ||
      !thread.channelId ||
      thread.parentChannelId !== parentChannelId ||
      typeof thread.name !== 'string' ||
      !thread.name ||
      (thread.kind !== 'thread' && thread.kind !== 'forum_post') ||
      (thread.messageId !== undefined && typeof thread.messageId !== 'string')
    ) {
      return null;
    }
    return thread as DiscordTaskThread;
  } catch {
    return null;
  }
}

async function findPendingTaskThread(
  sourceEventId: string,
  parentChannelId: string,
): Promise<DiscordTaskThread | null> {
  return parsePendingTaskThread(
    await getRedis().get(pendingTaskThreadKey(sourceEventId)),
    parentChannelId,
  );
}

async function rememberPendingTaskThread(
  sourceEventId: string,
  thread: DiscordTaskThread,
): Promise<void> {
  await getRedis().set(
    pendingTaskThreadKey(sourceEventId),
    JSON.stringify(thread),
    'EX',
    DISCORD_PENDING_TASK_THREAD_TTL_SECONDS,
  );
}

export async function forgetPendingTaskThread(
  sourceEventId: string,
): Promise<void> {
  await getRedis().del(pendingTaskThreadKey(sourceEventId));
}

/**
 * Starts the task thread on the message that asked for the task, ahead of the
 * launch itself, so a routing card can be posted inside it the way Slack posts
 * its card into the thread on the requesting message. `launchDiscordTask`
 * reuses whatever this reserved via the pending-thread memo.
 *
 * Returns null when this surface cannot anchor — DMs, forum channels,
 * interactions with no triggering message, `/new` siblings from inside a
 * thread — or when the triggering message is already gone. Those callers keep
 * the detached task thread that the launch creates.
 */
export async function reserveDiscordAnchoredThread(input: {
  provider: DiscordCommunicationProvider;
  queuedMessage: QueuedCommunicationMessage;
  metadata: DiscordEventCommunicationMetadata;
  channel: DiscordChannelContext;
  forceNewThread?: boolean;
}): Promise<DiscordTaskThread | null> {
  const parentId = taskThreadParentId(input);
  if (!parentId) return null;
  const existing = await findPendingTaskThread(
    input.queuedMessage.ts,
    parentId,
  );
  if (existing) return existing;
  const anchorMessageId =
    !input.channel.isThread &&
    DISCORD_MESSAGE_ANCHORED_CHANNEL_TYPES.has(input.channel.channelType)
      ? input.metadata.communicationAnchorMessageId
      : undefined;
  if (!anchorMessageId) return null;
  let thread: DiscordTaskThread;
  try {
    thread = await input.provider.createThreadFromMessage({
      channelId: parentId,
      messageId: anchorMessageId,
      name: buildCommunicationTaskThreadName(input.queuedMessage.text),
    });
  } catch (error) {
    // The triggering message was deleted before the thread could start; fall
    // back to a detached task thread rather than failing the launch.
    if (isDiscordUnknownMessageError(error)) return null;
    throw error;
  }
  await rememberPendingTaskThread(input.queuedMessage.ts, thread);
  return thread;
}

export async function launchDiscordTask(input: {
  provider: DiscordCommunicationProvider;
  launchOwnerUserId: string;
  queuedMessage: QueuedCommunicationMessage;
  metadata: DiscordEventCommunicationMetadata;
  channel: DiscordChannelContext;
  workspace: DiscordWorkspaceSelection;
  /** `/new` in an existing task thread creates a sibling, never a second run in-place. */
  forceNewThread?: boolean;
  /**
   * An already-posted message to turn into the acknowledgement instead of
   * posting a new one — a routing card sitting in the task thread becomes the
   * started message rather than being followed by an identical one. Only pass
   * a message that lives where the acknowledgement would have gone.
   */
  replaceMessage?: DiscordMessageToReplace;
}) {
  let createdThread: DiscordTaskThread | null = null;
  const parentId = taskThreadParentId(input);
  if (parentId) {
    const initialText = `Task request from ${input.queuedMessage.user}:\n\n${input.queuedMessage.text}`;
    createdThread = await reserveDiscordAnchoredThread(input);
    if (!createdThread) {
      createdThread = await input.provider.reserveTaskThread({
        channelId: parentId,
        name: buildCommunicationTaskThreadName(input.queuedMessage.text),
        initialText,
      });
      // Persist the external coordinate before the public-thread starter is
      // sent, so a failed send can resume in this exact thread on redelivery.
      await rememberPendingTaskThread(input.queuedMessage.ts, createdThread);
    }

    const completedThread = await input.provider.completeTaskThread({
      thread: createdThread,
      initialText,
    });
    if (completedThread !== createdThread) {
      createdThread = completedThread;
      await rememberPendingTaskThread(input.queuedMessage.ts, createdThread);
    }
  }

  const communicationChannelId =
    createdThread?.parentChannelId ?? input.metadata.communicationChannelId;
  const communicationThreadId =
    createdThread?.channelId ?? input.metadata.communicationThreadId;
  const communicationMessageId =
    createdThread?.messageId ?? input.metadata.communicationMessageId;
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
        communicationProvider: 'discord',
        communicationChannelId,
        ...(input.metadata.communicationGuildId
          ? { communicationGuildId: input.metadata.communicationGuildId }
          : {}),
        ...(communicationThreadId ? { communicationThreadId } : {}),
        ...(communicationMessageId ? { communicationMessageId } : {}),
        communicationSourceEventId: input.queuedMessage.ts,
        ...(createdThread ? { discordTaskThread: true } : {}),
      },
    };

  const launchResult = await enqueueTask(
    {
      task,
      initiator: { kind: 'user', userId: input.launchOwnerUserId },
      workflow: 'standard',
      surface: 'discord',
      trigger: 'message',
    },
    {
      launchClass: 'human',
      ...(createdThread
        ? {
            onEarlyTitleGenerated: async ({ title }: { title: string }) => {
              await input.provider.editChannel({
                channelId: createdThread.channelId,
                name: buildCommunicationTaskThreadName(title),
              });
            },
          }
        : {}),
    },
  );

  const taskUrl = getTaskUrl({
    taskId: launchResult.taskId,
    utm: { source: 'discord', campaign: 'discord.thread_start' },
  });
  const acknowledgementMessage = {
    text: discordTaskAcknowledgementText({
      workspaceDisplayName: input.workspace.workspaceDisplayName,
      taskUrl,
    }),
    buttons: discordTaskButtons({ runId: launchResult.id, taskUrl }),
  };
  // Replacing already falls back to posting when the original message cannot
  // be edited, so the task is acknowledged either way.
  const acknowledgement = input.replaceMessage
    ? await replaceOrPostDiscordMessage({
        provider: input.provider,
        replace: input.replaceMessage,
        ...acknowledgementMessage,
      })
    : await input.provider.postMessage({
        channelId: communicationChannelId,
        ...(communicationThreadId ? { threadId: communicationThreadId } : {}),
        ...acknowledgementMessage,
      });

  if (createdThread) {
    await forgetPendingTaskThread(input.queuedMessage.ts).catch((error) => {
      console.warn(
        `[discord] Failed to clear pending task thread for event ${input.queuedMessage.ts}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  return {
    launchResult,
    taskUrl,
    acknowledgement,
    createdThread,
    metadata: {
      communicationProvider: 'discord' as const,
      communicationChannelId,
      ...(communicationThreadId ? { communicationThreadId } : {}),
      ...(communicationMessageId ? { communicationMessageId } : {}),
      ...(input.metadata.communicationGuildId
        ? { communicationGuildId: input.metadata.communicationGuildId }
        : {}),
    },
  };
}
