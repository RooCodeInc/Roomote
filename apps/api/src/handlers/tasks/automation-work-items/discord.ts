import type {
  DiscordCommunicationProvider,
  DiscordTaskThread,
} from '@roomote/communication/discord-provider';
import { getRedis } from '@roomote/redis';
import { findDiscordDefaultDestination } from '@roomote/sdk/server';

import { resolveDiscordProvider } from '../../discord/provider.js';
import { buildSuggestionBadgePrefix } from '../../slack/helpers/suggestion-workspace.js';
import { buildCommunicationTaskThreadName } from '../communication-task-thread.js';
import type { PersistedAutomationWorkItem } from './types.js';

const DISCORD_AUTOMATION_TASK_THREAD_PREFIX = 'discord:automation_task_thread:';
const DISCORD_AUTOMATION_TASK_THREAD_TTL_SECONDS = 30 * 24 * 60 * 60;

export type AutomationDiscordTarget = {
  provider: 'discord';
  discord: DiscordCommunicationProvider;
  guildId: string;
  channelId: string;
  channelType: number;
  threadId?: string;
  messageId?: string;
};

/**
 * Resolves the configured Discord destination. The caller applies provider
 * precedence, then every work item materializes a child thread/forum post.
 */
export async function resolveAutomationDiscordTarget(): Promise<AutomationDiscordTarget | null> {
  const destination = await findDiscordDefaultDestination();
  if (!destination) {
    return null;
  }

  try {
    const { provider } = await resolveDiscordProvider();
    return {
      provider: 'discord',
      discord: provider,
      guildId: destination.guildId,
      channelId: destination.channelId,
      channelType: destination.channelType,
    };
  } catch {
    return null;
  }
}

function buildAutomationWorkItemIntro(
  workItem: PersistedAutomationWorkItem,
): string {
  return [
    `**${buildSuggestionBadgePrefix({
      category: workItem.category,
      priority: workItem.priority,
    })}${workItem.title}**`,
    workItem.brief,
  ].join('\n');
}

function automationTaskThreadKey(workItemId: string): string {
  return `${DISCORD_AUTOMATION_TASK_THREAD_PREFIX}${workItemId}`;
}

function parseAutomationTaskThread(
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
      (thread.messageId !== undefined &&
        (typeof thread.messageId !== 'string' || !thread.messageId))
    ) {
      return null;
    }
    return thread as DiscordTaskThread;
  } catch {
    return null;
  }
}

async function findAutomationTaskThread(
  workItemId: string,
  parentChannelId: string,
): Promise<DiscordTaskThread | null> {
  return parseAutomationTaskThread(
    await getRedis().get(automationTaskThreadKey(workItemId)),
    parentChannelId,
  );
}

async function rememberAutomationTaskThread(
  workItemId: string,
  thread: DiscordTaskThread,
): Promise<void> {
  await getRedis().set(
    automationTaskThreadKey(workItemId),
    JSON.stringify(thread),
    'EX',
    DISCORD_AUTOMATION_TASK_THREAD_TTL_SECONDS,
  );
}

/** Creates the Discord task conversation before the execution run starts. */
export async function createAutomationDiscordTaskThread(params: {
  target: AutomationDiscordTarget;
  workItem: PersistedAutomationWorkItem;
}): Promise<AutomationDiscordTarget> {
  if (params.target.threadId) {
    return params.target;
  }

  const initialText = buildAutomationWorkItemIntro(params.workItem);
  let thread = await findAutomationTaskThread(
    params.workItem.id,
    params.target.channelId,
  );

  if (!thread) {
    thread = await params.target.discord.reserveTaskThread({
      channelId: params.target.channelId,
      name: buildCommunicationTaskThreadName(params.workItem.title),
      initialText,
    });
    // A queue publish failure reopens this same work item. Save the Discord
    // coordinate before posting the starter so that every retry resumes here.
    await rememberAutomationTaskThread(params.workItem.id, thread);
  }

  const completedThread = await params.target.discord.completeTaskThread({
    thread,
    initialText,
  });
  if (completedThread !== thread) {
    thread = completedThread;
    await rememberAutomationTaskThread(params.workItem.id, thread);
  }

  return {
    ...params.target,
    threadId: thread.channelId,
    ...(thread.messageId ? { messageId: thread.messageId } : {}),
  };
}

export async function postLateBoundWorkItemFailureToDiscord(params: {
  target: AutomationDiscordTarget;
  workItem: PersistedAutomationWorkItem;
  reason: string;
}): Promise<void> {
  const text = [
    `**${buildSuggestionBadgePrefix({
      category: params.workItem.category,
      priority: params.workItem.priority,
    })}${params.workItem.title}**`,
    params.workItem.brief,
    '',
    `An automation queued this work item, but the execution task failed to launch: ${params.reason}`,
  ].join('\n');

  await params.target.discord.postMessage({
    channelId: params.target.channelId,
    ...(params.target.threadId ? { threadId: params.target.threadId } : {}),
    text,
    textFormat: 'markdown',
  });
}
