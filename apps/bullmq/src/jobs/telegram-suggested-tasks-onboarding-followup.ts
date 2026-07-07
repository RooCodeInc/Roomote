import { Job } from 'bullmq';

import { buildSuggestedTasksFollowupReminderText } from '@roomote/communication/chat-messages';
import { TelegramCommunicationProvider } from '@roomote/communication/telegram-provider';
import { resolveTelegramRuntimeCredentials } from '@roomote/db/server';
import { telegramSuggestedTasksOnboardingFollowupRequestSchema } from '@roomote/sdk/server';

import {
  buildSuggestedTasksSettingsUrl,
  runSuggestedTasksOnboardingFollowupJob,
} from './suggested-tasks-onboarding-followup';

/**
 * Telegram counterpart of the Slack suggested-tasks onboarding follow-up.
 * Uses a URL button to Automations instead of Slack's interactive
 * enable-suggester prompt, so no pending-prompt state is required; the
 * enqueue-side claim plus BullMQ jobId dedup keep it to one send.
 */
export const telegramSuggestedTasksOnboardingFollowupJob = async (
  job: Job,
): Promise<void> => {
  await runSuggestedTasksOnboardingFollowupJob({
    job,
    label: 'TelegramSuggestedTasksOnboardingFollowup',
    requestSchema: telegramSuggestedTasksOnboardingFollowupRequestSchema,
    send: async (data) => {
      const { botToken } = await resolveTelegramRuntimeCredentials();

      if (!botToken) {
        console.warn(
          '[TelegramSuggestedTasksOnboardingFollowup] Telegram bot token is not configured, skipping',
        );
        return;
      }

      const provider = new TelegramCommunicationProvider({ botToken });

      await provider.postMessage({
        channelId: data.chatId,
        replyToMessageId: data.introMessageId,
        text: buildSuggestedTasksFollowupReminderText(),
        textFormat: 'markdown',
        buttons: [
          [
            {
              text: 'Open Automations',
              url: buildSuggestedTasksSettingsUrl({
                source: 'telegram',
                campaign: 'telegram.suggested_tasks_followup',
              }),
            },
          ],
        ],
      });

      console.log(
        `[TelegramSuggestedTasksOnboardingFollowup] Posted follow-up to chat ${data.chatId} for sourceTaskId=${data.sourceTaskId}`,
      );
    },
  });
};
