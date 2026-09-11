import {
  and,
  db,
  eq,
  slackInstallations,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import { acquireRedisLock, getRedis } from '@roomote/redis';
import {
  claimThreadFooterRefreshTargets,
  refreshManagedThreadReplyFooter,
  editTextThreadFooterMessage,
  forgetThreadFooterRefresh,
  rescheduleThreadFooterRefresh,
  type ThreadFooterRefreshOutcome,
  type ThreadFooterRefreshTarget,
} from '@roomote/communication';
import {
  SlackNotifier,
  refreshSlackThreadReplyFooter,
  withSlackThreadReplyFooterLock,
} from '@roomote/slack';
import {
  getCommunicationChannelFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
} from '@roomote/types';

import { createDiscordCommunicationProviderFromRuntimeCredentials } from './discord-communication';
import { createTeamsCommunicationProviderFromRuntimeCredentials } from './teams-communication';
import { createTelegramCommunicationProviderFromRuntimeCredentials } from './telegram-communication';
import { refreshSourceControlThreadFooter } from './source-control-fast-delivery';

const JOB_LOCK_KEY = 'thread_footer_refresh:job';
/** One batch never overlaps the next scheduler tick; the lock outlives the deadline. */
const JOB_LOCK_TTL_SECONDS = 5 * 60;
const JOB_DEADLINE_MS = 4 * 60_000;
const JOB_CONCURRENCY = 5;

/** Unregister a Slack destination whose workspace can no longer be reached. */
async function forgetSlackTarget(
  target: ThreadFooterRefreshTarget,
): Promise<ThreadFooterRefreshOutcome> {
  await withSlackThreadReplyFooterLock({
    channel: target.channelId,
    threadTs: target.threadId,
    maxAcquireAttempts: 1,
    fn: async (assertLock) => {
      await assertLock();
      await forgetThreadFooterRefresh(target);
    },
  });
  return 'gone';
}

export async function refreshThreadFooterTarget(
  target: ThreadFooterRefreshTarget,
): Promise<ThreadFooterRefreshOutcome> {
  if (target.provider === 'source-control') {
    return refreshSourceControlThreadFooter(target);
  }
  if (target.provider === 'slack') {
    const workspaceKey = `slack:thread_footer_workspace:${target.channelId}:${target.threadId}`;
    const teamId = await getRedis().get(workspaceKey);
    if (!teamId) {
      let outcome: ThreadFooterRefreshOutcome = 'active';
      await withSlackThreadReplyFooterLock({
        channel: target.channelId,
        threadTs: target.threadId,
        maxAcquireAttempts: 1,
        fn: async (assertLock) => {
          if (!(await getRedis().get(workspaceKey))) {
            await assertLock();
            await forgetThreadFooterRefresh(target);
            outcome = 'gone';
          }
        },
      });
      return outcome;
    }
    const installation = await db.query.slackInstallations.findFirst({
      where: and(
        eq(slackInstallations.isActive, true),
        eq(slackInstallations.teamId, teamId),
      ),
      columns: { botAccessToken: true },
    });
    if (!installation?.botAccessToken) {
      // The workspace uninstalled or reinstalled the app: this carrier can
      // never be edited again, and a new reply registers under the new team.
      console.warn(
        '[threadFooterRefresh] Retiring a footer with no active Slack installation',
        { channelId: target.channelId, threadId: target.threadId },
      );
      return forgetSlackTarget(target);
    }
    return refreshSlackThreadReplyFooter({
      slack: new SlackNotifier(installation.botAccessToken),
      channel: target.channelId,
      threadTs: target.threadId,
    });
  }
  return refreshManagedThreadReplyFooter({
    ...target,
    provider: target.provider,
    edit: async (record, text) => {
      if (target.provider === 'discord') {
        const provider =
          await createDiscordCommunicationProviderFromRuntimeCredentials();
        if (!provider)
          throw new Error('Discord footer refresh credentials unavailable');
        await provider.editMessage({
          channelId: record.refresh!.channelId,
          messageId: record.messageId,
          text,
          preserveButtons: true,
        });
      } else {
        const provider =
          target.provider === 'teams'
            ? await createTeamsCommunicationProviderFromRuntimeCredentials()
            : await createTelegramCommunicationProviderFromRuntimeCredentials();
        if (!provider)
          throw new Error('Text footer refresh credentials unavailable');
        await editTextThreadFooterMessage(provider, record, text);
      }
    },
  });
}

/** Refresh the Slack Session footer bound to a task-run lifecycle event. */
export async function refreshTaskRunThreadFooter(runId: number): Promise<void> {
  const run = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
    columns: { taskId: true, payload: true },
  });
  if (!run?.taskId) return;

  let channelId: string | null = null;
  let threadId: string | null = null;
  if (getCommunicationProviderFromTaskPayload(run.payload) === 'slack') {
    channelId = getCommunicationChannelFromTaskPayload(run.payload);
    threadId = getCommunicationThreadIdFromTaskPayload(run.payload);
  }
  if (!channelId || !threadId) {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, run.taskId),
      columns: { slackChannelId: true, slackThreadTs: true },
    });
    channelId = task?.slackChannelId ?? null;
    threadId = task?.slackThreadTs ?? null;
  }
  if (!channelId || !threadId) return;

  const target = {
    provider: 'slack' as const,
    channelId,
    threadId,
  };
  const outcome = await refreshThreadFooterTarget(target);
  if (outcome !== 'gone') {
    await rescheduleThreadFooterRefresh(target, outcome);
  }
}

/** Wake a task run's carrier without coupling lifecycle writes to provider I/O. */
export function notifyTaskRunThreadFooterRefresh(runId: number): void {
  void refreshTaskRunThreadFooter(runId).catch((error) => {
    console.warn(
      `[threadFooterRefresh] Failed to refresh the communication footer for task run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

/**
 * One bounded pass over due destinations. No history scans or provider calls
 * from workers. Only one pass runs at a time: a slow pass makes the next tick
 * skip rather than double the work.
 */
export async function refreshCurrentThreadFooters(): Promise<void> {
  const release = await acquireRedisLock(JOB_LOCK_KEY, {
    ttlSeconds: JOB_LOCK_TTL_SECONDS,
  });
  if (!release) return;
  const deadline = Date.now() + JOB_DEADLINE_MS;
  try {
    const targets = await claimThreadFooterRefreshTargets();
    // Limit parallel provider/DB work and isolate one destination's failures.
    for (let index = 0; index < targets.length; index += JOB_CONCURRENCY) {
      if (Date.now() > deadline) {
        // Unfinished targets keep their claim lease and come back with it.
        console.warn('[threadFooterRefresh] Pass hit its deadline', {
          remaining: targets.length - index,
        });
        break;
      }
      await Promise.all(
        targets.slice(index, index + JOB_CONCURRENCY).map(async (target) => {
          try {
            const outcome = await refreshThreadFooterTarget(target);
            if (outcome !== 'gone')
              await rescheduleThreadFooterRefresh(target, outcome);
          } catch (error) {
            // The claim lease retries this destination on the slow cadence.
            console.warn('[threadFooterRefresh] Refresh deferred', {
              provider: target.provider,
              error,
            });
          }
        }),
      );
    }
  } finally {
    await release();
  }
}
