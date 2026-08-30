import {
  ALL_REPOSITORIES,
  buildFastAgentChildTaskMetadata,
  TaskPayloadKind,
  type FastAgentParent,
  type QueuedCommunicationMessage,
  type TaskInitiator,
  type TaskSpec,
} from '@roomote/types';
import { db, environments, eq, sql, taskRuns, tasks } from '@roomote/db/server';
import {
  enqueueTask,
  getTaskUrl,
  selectDiscordForumTag,
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

type DiscordReactionTarget = {
  channelId: string;
  messageId: string;
};

/**
 * Real MESSAGE_CREATE launches pin 👀 on the triggering message before enqueue.
 * Interaction launches (`/new`) have no message target at intake, so they
 * permanently record the acknowledgement / thread-starter message as the
 * terminal/cancel reaction target after launch (without a post-enqueue 👀).
 */
function resolveDiscordOriginReactionTarget(input: {
  channel: DiscordChannelContext;
  metadata: DiscordEventCommunicationMetadata;
}): DiscordReactionTarget | null {
  const messageId = input.metadata.communicationAnchorMessageId;
  if (!messageId) {
    return null;
  }
  return {
    // Intake uses channel.channelId for eyes (thread or parent DM/channel).
    channelId: input.channel.channelId,
    messageId,
  };
}

async function persistDiscordReactionTarget(input: {
  runId: number;
  reaction: DiscordReactionTarget;
}): Promise<void> {
  const patch = JSON.stringify({
    discordReactionChannelId: input.reaction.channelId,
    discordReactionMessageId: input.reaction.messageId,
  });
  await db
    .update(taskRuns)
    .set({
      payload: sql`coalesce(${taskRuns.payload}, '{}'::jsonb) || ${patch}::jsonb`,
    })
    .where(eq(taskRuns.id, input.runId));
}

export type DiscordChannelContext = {
  channelId: string;
  channelName: string;
  channelType: number;
  guildId?: string;
  parentChannelId?: string;
  isDirectMessage: boolean;
  isThread: boolean;
};

export type DiscordWorkspaceSelection = {
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
 * Align a reserved Discord task thread to the cleaned provisional title used
 * for the current request. Covers Discord redelivery recoveries and Redis
 * pending-thread memos that may still carry a pre-cleanup title.
 */
async function alignProvisionalTaskThreadName(input: {
  provider: DiscordCommunicationProvider;
  thread: DiscordTaskThread;
  provisionalName: string;
}): Promise<DiscordTaskThread> {
  if (input.thread.name === input.provisionalName) {
    return input.thread;
  }
  try {
    await input.provider.editChannel({
      channelId: input.thread.channelId,
      name: input.provisionalName,
    });
    return { ...input.thread, name: input.provisionalName };
  } catch (error) {
    console.warn(
      `[discord] Failed to set provisional task thread name for ${input.thread.channelId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return input.thread;
  }
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
  const provisionalName = buildCommunicationTaskThreadName(
    input.queuedMessage.text,
  );
  const existing = await findPendingTaskThread(
    input.queuedMessage.ts,
    parentId,
  );
  if (existing) {
    // Redis memoranda can outlive a deploy and still hold a pre-cleanup title
    // (or a title from an older sibling message). Reconcile before launching.
    const aligned = await alignProvisionalTaskThreadName({
      provider: input.provider,
      thread: existing,
      provisionalName,
    });
    if (aligned !== existing) {
      await rememberPendingTaskThread(input.queuedMessage.ts, aligned);
    }
    return aligned;
  }
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
      name: provisionalName,
    });
  } catch (error) {
    // The triggering message was deleted before the thread could start; fall
    // back to a detached task thread rather than failing the launch.
    if (isDiscordUnknownMessageError(error)) return null;
    throw error;
  }
  // Discord may recover an existing thread with its prior name (for example on
  // redelivery). Align the provisional title immediately.
  thread = await alignProvisionalTaskThreadName({
    provider: input.provider,
    thread,
    provisionalName,
  });
  await rememberPendingTaskThread(input.queuedMessage.ts, thread);
  return thread;
}

export async function launchDiscordTask(input: {
  provider: DiscordCommunicationProvider;
  /** Required unless an explicit `initiator` carries the attribution. */
  launchOwnerUserId?: string;
  /**
   * Overrides the default `{ kind: 'user', userId: launchOwnerUserId }`
   * initiator — channel auto-start passes richer user shapes and
   * automation-owned launches for bot-authored messages.
   */
  initiator?: TaskInitiator;
  /**
   * Agent-facing prompt override (e.g. auto-respond channel instructions
   * prepended to the message); the queued message text stays the
   * user-visible task description.
   */
  agentPromptText?: string;
  queuedMessage: QueuedCommunicationMessage;
  metadata: DiscordEventCommunicationMetadata;
  channel: DiscordChannelContext;
  workspace: DiscordWorkspaceSelection;
  /** `/new` in an existing task thread creates a sibling, never a second run in-place. */
  forceNewThread?: boolean;
  /** Exact deployment-enabled model selected by the Fast orchestrator. */
  model?: string;
  fastAgentSessionId?: string;
  fastAgentParent?: FastAgentParent;
  /** Post the Fast model-authored kickoff before enqueueing and suppress the
   * generic Discord task acknowledgement. */
  beforeEnqueueKickoff?: (task: {
    taskId: string;
    taskUrl?: string;
  }) => Promise<void>;
  /**
   * An already-posted message to turn into the acknowledgement instead of
   * posting a new one — a routing card sitting in the task thread becomes the
   * started message rather than being followed by an identical one. Only pass
   * a message that lives where the acknowledgement would have gone.
   */
  replaceMessage?: DiscordMessageToReplace;
  /**
   * Router free-form kickoff sentence (Slack parity). When set and normalizable,
   * it becomes the Discord acknowledgement text instead of the static template.
   */
  kickoffMessage?: string | null;
  /**
   * True only when a pre-enqueue MESSAGE_CREATE 👀 reaction succeeded on the
   * origin message. Worker onStart cleanup keys off this so failed soft-acks
   * do not produce DELETE 404 warnings.
   */
  intakeAckPinned?: boolean;
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
        selectForumTag: async (availableTags) =>
          (
            await selectDiscordForumTag({
              taskDescription: input.queuedMessage.text,
              availableTags,
              tracking: { userId: input.launchOwnerUserId },
            })
          )?.tagId ?? null,
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
  const originReaction = resolveDiscordOriginReactionTarget({
    channel: input.channel,
    metadata: input.metadata,
  });
  // Prefer a real origin message when present. For interaction launches the
  // thread starter (if any) is a valid target until the acknowledgement posts.
  let reactionTarget: DiscordReactionTarget | null =
    originReaction ??
    (createdThread?.messageId
      ? {
          channelId: createdThread.channelId,
          messageId: createdThread.messageId,
        }
      : null);
  const task: Extract<TaskSpec, { type: typeof TaskPayloadKind.StandardTask }> =
    {
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: input.workspace.repoForPayload,
        ...(input.workspace.environmentId
          ? { environmentId: input.workspace.environmentId }
          : {}),
        description: input.queuedMessage.text,
        ...(input.agentPromptText?.trim()
          ? { agentPromptText: input.agentPromptText.trim() }
          : {}),
        ...(input.model
          ? { harnessModelOverrides: { 'opencode-server': input.model } }
          : {}),
        ...(input.queuedMessage.images?.length
          ? { images: input.queuedMessage.images }
          : {}),
        communicationProvider: 'discord',
        ...(input.fastAgentParent
          ? buildFastAgentChildTaskMetadata(input.fastAgentParent)
          : input.fastAgentSessionId
            ? { fastAgentSessionId: input.fastAgentSessionId }
            : {}),
        communicationChannelId,
        ...(input.metadata.communicationGuildId
          ? { communicationGuildId: input.metadata.communicationGuildId }
          : {}),
        ...(communicationThreadId ? { communicationThreadId } : {}),
        ...(communicationMessageId ? { communicationMessageId } : {}),
        communicationSourceEventId: input.queuedMessage.ts,
        ...(createdThread ? { discordTaskThread: true } : {}),
        ...(reactionTarget
          ? {
              discordReactionChannelId: reactionTarget.channelId,
              discordReactionMessageId: reactionTarget.messageId,
              // Only when the caller successfully pinned 👀 before enqueue.
              ...(originReaction && input.intakeAckPinned
                ? { discordIntakeAckPending: true }
                : {}),
            }
          : {}),
      },
    };

  const initiator: TaskInitiator | null =
    input.initiator ??
    (input.launchOwnerUserId
      ? { kind: 'user', userId: input.launchOwnerUserId }
      : null);
  if (!initiator) {
    throw new Error(
      'launchDiscordTask requires an initiator or a launch owner.',
    );
  }

  const titleThreadId = createdThread?.channelId;
  const beforeEnqueueKickoff = input.beforeEnqueueKickoff;

  let taskUrl: string | undefined;
  const launchResult = await enqueueTask(
    {
      task,
      initiator,
      workflow: 'standard',
      surface: 'discord',
      trigger: 'message',
    },
    {
      // Automation initiators derive the 'automation' launch class; forcing
      // 'human' would misclassify bot-authored auto-respond launches.
      ...(initiator.kind === 'automation'
        ? {}
        : { launchClass: 'human' as const }),
      // Mirror Telegram: apply the early LLM title directly onto the task-
      // owned thread with the same provider credentials that reserved it.
      // Going through runtime-credential sync can skip the rename when this
      // request already holds a working Discord provider.
      // Re-read the canonical task title after each provider call so a concurrent
      // manual rename that lands later cannot be overwritten by this older
      // early-title request.
      ...(titleThreadId
        ? {
            onEarlyTitleGenerated: async ({
              taskRun,
              title,
            }: {
              taskRun: { taskId: string };
              title: string;
            }) => {
              let canonicalTitle = title;
              let appliedTitle: string | null = null;
              for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                  await input.provider.editChannel({
                    channelId: titleThreadId,
                    name: buildCommunicationTaskThreadName(canonicalTitle),
                  });
                  appliedTitle = canonicalTitle;
                } catch (error) {
                  console.warn(
                    `[discord] Failed to rename task thread ${titleThreadId} with generated title: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                  // Re-throw only when no rename has landed yet so enqueue
                  // keeps checkpoint 0 and the first-message path can retry.
                  if (!appliedTitle) {
                    throw error;
                  }
                  return;
                }

                const [latestTask] = await db
                  .select({ title: tasks.title })
                  .from(tasks)
                  .where(eq(tasks.id, taskRun.taskId))
                  .limit(1);
                if (!latestTask || latestTask.title === canonicalTitle) {
                  return;
                }
                canonicalTitle = latestTask.title;
              }
            },
          }
        : {}),
      ...(beforeEnqueueKickoff
        ? {
            beforeEnqueue: async (taskRun: { taskId: string }) => {
              taskUrl = getTaskUrl({
                taskId: taskRun.taskId,
                utm: { source: 'discord', campaign: 'discord.thread_start' },
              });
              await beforeEnqueueKickoff({
                taskId: taskRun.taskId,
                ...(taskUrl ? { taskUrl } : {}),
              });
            },
          }
        : {}),
    },
  );

  taskUrl ??= getTaskUrl({
    taskId: launchResult.taskId,
    utm: { source: 'discord', campaign: 'discord.thread_start' },
  });
  const acknowledgementMessage = {
    text: discordTaskAcknowledgementText({
      workspaceDisplayName: input.workspace.workspaceDisplayName,
      taskUrl,
      ...(input.kickoffMessage ? { kickoffMessage: input.kickoffMessage } : {}),
    }),
    buttons: discordTaskButtons({ runId: launchResult.id, taskUrl }),
  };
  // Replacing already falls back to posting when the original message cannot
  // be edited, so the task is acknowledged either way.
  const acknowledgement = beforeEnqueueKickoff
    ? null
    : input.replaceMessage
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

  // Interaction launches (`/new`) have no MESSAGE_CREATE origin. Persist the
  // acknowledgement message so terminal/cancel reactions have a valid target.
  // Do not pin 👀 here: intake eyes are MESSAGE_CREATE-only, and post-enqueue
  // eyes race worker onStart cleanup (which can already have run).
  if (!originReaction && acknowledgement?.messageId) {
    reactionTarget = {
      channelId: communicationThreadId ?? communicationChannelId,
      messageId: acknowledgement.messageId,
    };
    await persistDiscordReactionTarget({
      runId: launchResult.id,
      reaction: reactionTarget,
    }).catch((error) => {
      console.warn(
        `[discord] Failed to persist reaction target for run ${launchResult.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

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
