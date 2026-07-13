import { Job } from 'bullmq';

import { buildSuggestedTasksFollowupReminderText } from '@roomote/communication/chat-messages';
import { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import { resolveDiscordRuntimeCredentials } from '@roomote/db/server';
import { discordSuggestedTasksOnboardingFollowupRequestSchema } from '@roomote/sdk/server';

import {
  buildSuggestedTasksSettingsUrl,
  runSuggestedTasksOnboardingFollowupJob,
} from './suggested-tasks-onboarding-followup';

/**
 * Discord counterpart of the suggested-tasks onboarding follow-up. The
 * reminder is posted directly into the setup-suggestions thread/forum post;
 * it does not quote the original message, keeping the thread compact.
 */
export const discordSuggestedTasksOnboardingFollowupJob = async (
  job: Job,
): Promise<void> => {
  await runSuggestedTasksOnboardingFollowupJob({
    job,
    label: 'DiscordSuggestedTasksOnboardingFollowup',
    requestSchema: discordSuggestedTasksOnboardingFollowupRequestSchema,
    send: async (data) => {
      const { botToken, applicationId } =
        await resolveDiscordRuntimeCredentials();

      if (!botToken) {
        console.warn(
          '[DiscordSuggestedTasksOnboardingFollowup] Discord bot token is not configured, skipping',
        );
        return;
      }

      const provider = new DiscordCommunicationProvider({
        botToken,
        ...(applicationId ? { applicationId } : {}),
      });

      await provider.postMessage({
        channelId: data.channelId,
        threadId: data.threadId,
        text: buildSuggestedTasksFollowupReminderText(),
        textFormat: 'markdown',
        buttons: [
          [
            {
              text: 'Open Automations',
              url: buildSuggestedTasksSettingsUrl({
                source: 'discord',
                campaign: 'discord.suggested_tasks_followup',
              }),
            },
          ],
        ],
      });

      console.log(
        `[DiscordSuggestedTasksOnboardingFollowup] Posted follow-up to ${data.guildId ? `thread ${data.threadId} in guild ${data.guildId}` : `DM ${data.channelId}`} for sourceTaskId=${data.sourceTaskId}`,
      );
    },
  });
};
