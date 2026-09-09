import { and, db, eq, slackInstallations } from '@roomote/db/server';
import { getRedis } from '@roomote/redis';
import {
  claimThreadFooterRefreshTargets,
  refreshManagedThreadReplyFooter,
  editTextThreadFooterMessage,
  forgetThreadFooterRefresh,
  type ThreadFooterRefreshTarget,
} from '@roomote/communication';
import {
  SlackNotifier,
  refreshSlackThreadReplyFooter,
  withSlackThreadReplyFooterLock,
} from '@roomote/slack';

import { createDiscordCommunicationProviderFromRuntimeCredentials } from './discord-communication';
import { createTeamsCommunicationProviderFromRuntimeCredentials } from './teams-communication';
import { createTelegramCommunicationProviderFromRuntimeCredentials } from './telegram-communication';
import { refreshSourceControlThreadFooter } from './source-control-fast-delivery';

export async function refreshThreadFooterTarget(
  target: ThreadFooterRefreshTarget,
): Promise<void> {
  if (target.provider === 'source-control') {
    await refreshSourceControlThreadFooter(target);
  } else if (target.provider === 'slack') {
    const teamId = await getRedis().get(
      `slack:thread_footer_workspace:${target.channelId}:${target.threadId}`,
    );
    if (!teamId) {
      await withSlackThreadReplyFooterLock({
        channel: target.channelId,
        threadTs: target.threadId,
        maxAcquireAttempts: 1,
        fn: async (assertLock) => {
          if (
            !(await getRedis().get(
              `slack:thread_footer_workspace:${target.channelId}:${target.threadId}`,
            ))
          ) {
            await assertLock();
            await forgetThreadFooterRefresh(target);
          }
        },
      });
      return;
    }
    const installation = await db.query.slackInstallations.findFirst({
      where: and(
        eq(slackInstallations.isActive, true),
        eq(slackInstallations.teamId, teamId),
      ),
      columns: { botAccessToken: true },
    });
    if (!installation?.botAccessToken) return;
    await refreshSlackThreadReplyFooter({
      slack: new SlackNotifier(installation.botAccessToken),
      channel: target.channelId,
      threadTs: target.threadId,
    });
  } else {
    await refreshManagedThreadReplyFooter({
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
}

/** No history scans, task-status event coupling, or provider calls from workers. */
export async function refreshCurrentThreadFooters(): Promise<void> {
  const targets = await claimThreadFooterRefreshTargets();
  // Limit parallel provider/DB work and isolate one destination's failures.
  for (let index = 0; index < targets.length; index += 5) {
    await Promise.all(
      targets.slice(index, index + 5).map(async (target) => {
        try {
          await refreshThreadFooterTarget(target);
        } catch (error) {
          console.warn('[threadFooterRefresh] Refresh deferred', {
            provider: target.provider,
            error,
          });
        }
      }),
    );
  }
}
