import { buildCommunicationTaskThreadName } from '@roomote/communication/task-thread-title';
import { db, eq, taskRuns, tasks } from '@roomote/db/server';
import {
  getCommunicationChannelFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
} from '@roomote/types';

import { createDiscordCommunicationProviderFromRuntimeCredentials } from './discord-communication';
import { createTelegramCommunicationProviderFromRuntimeCredentials } from './telegram-communication';

type TaskOwnedThreadTarget = {
  provider: 'discord' | 'telegram';
  channelId: string;
  threadId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getTaskOwnedThreadTarget(
  payload: unknown,
): TaskOwnedThreadTarget | null {
  const provider = getCommunicationProviderFromTaskPayload(payload);
  if (provider !== 'discord' && provider !== 'telegram') {
    return null;
  }

  if (!isRecord(payload)) {
    return null;
  }

  const isTaskOwned =
    provider === 'discord'
      ? payload.discordTaskThread === true
      : payload.telegramTaskTopic === true;
  if (!isTaskOwned) {
    return null;
  }

  const channelId = getCommunicationChannelFromTaskPayload(payload);
  const threadId = getCommunicationThreadIdFromTaskPayload(payload);
  if (!channelId || !threadId) {
    return null;
  }

  return { provider, channelId, threadId };
}

function dedupeTaskOwnedThreadTargets(
  targets: TaskOwnedThreadTarget[],
): TaskOwnedThreadTarget[] {
  return [
    ...new Map(
      targets.map((target) => [
        `${target.provider}:${target.channelId}:${target.threadId}`,
        target,
      ]),
    ).values(),
  ];
}

async function syncDiscordThreadTitles(
  taskId: string,
  title: string,
  targets: TaskOwnedThreadTarget[],
): Promise<void> {
  const provider =
    await createDiscordCommunicationProviderFromRuntimeCredentials();
  if (!provider) {
    console.warn(
      `[taskThreadTitleSync] Discord is not configured; skipping thread-title sync for task ${taskId}`,
    );
    return;
  }

  await Promise.all(
    targets.map((target) =>
      provider.editChannel({
        channelId: target.threadId,
        name: title,
      }),
    ),
  );
}

async function syncTelegramThreadTitles(
  taskId: string,
  title: string,
  targets: TaskOwnedThreadTarget[],
): Promise<void> {
  const provider =
    await createTelegramCommunicationProviderFromRuntimeCredentials();
  if (!provider) {
    console.warn(
      `[taskThreadTitleSync] Telegram is not configured; skipping thread-title sync for task ${taskId}`,
    );
    return;
  }

  await Promise.all(
    targets.map((target) =>
      provider.editForumTopic({
        channelId: target.channelId,
        threadId: target.threadId,
        name: title,
      }),
    ),
  );
}

/**
 * Keep task-owned provider thread titles aligned with Roomote's canonical task
 * title. Provider failures are deliberately non-fatal: the database title is
 * authoritative and a later title refresh or manual edit can retry the sync.
 */
export async function syncTaskCommunicationThreadTitleBestEffort(input: {
  taskId: string;
}): Promise<void> {
  try {
    const [taskRows, runs] = await Promise.all([
      db
        .select({ title: tasks.title })
        .from(tasks)
        .where(eq(tasks.id, input.taskId))
        .limit(1),
      db
        .select({ payload: taskRuns.payload })
        .from(taskRuns)
        .where(eq(taskRuns.taskId, input.taskId)),
    ]);
    const task = taskRows[0];
    if (!task) {
      return;
    }

    const targets = dedupeTaskOwnedThreadTargets(
      runs
        .map((run) => getTaskOwnedThreadTarget(run.payload))
        .filter((target): target is TaskOwnedThreadTarget => target !== null),
    );

    if (targets.length === 0) {
      return;
    }

    let canonicalTitle = task.title;

    // A generated refresh and a manual edit can overlap in separate services.
    // Re-read after the provider call so the older request cannot win merely
    // because it completed last.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const title = buildCommunicationTaskThreadName(canonicalTitle);
      const results = await Promise.allSettled([
        ...(targets.some((target) => target.provider === 'discord')
          ? [
              syncDiscordThreadTitles(
                input.taskId,
                title,
                targets.filter((target) => target.provider === 'discord'),
              ),
            ]
          : []),
        ...(targets.some((target) => target.provider === 'telegram')
          ? [
              syncTelegramThreadTitles(
                input.taskId,
                title,
                targets.filter((target) => target.provider === 'telegram'),
              ),
            ]
          : []),
      ]);

      for (const result of results) {
        if (result.status === 'rejected') {
          console.warn(
            `[taskThreadTitleSync] Failed to sync a communication thread title for task ${input.taskId}: ${
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason)
            }`,
          );
        }
      }

      const [latestTask] = await db
        .select({ title: tasks.title })
        .from(tasks)
        .where(eq(tasks.id, input.taskId))
        .limit(1);
      if (!latestTask || latestTask.title === canonicalTitle) {
        return;
      }

      canonicalTitle = latestTask.title;
    }
  } catch (error) {
    console.warn(
      `[taskThreadTitleSync] Failed to resolve communication threads for task ${input.taskId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
