import { Job } from 'bullmq';

import { buildSuggestedTasksFollowupReminderText } from '@roomote/communication/chat-messages';
import {
  createTeamsCommunicationProviderFromRuntimeCredentials,
  teamsSuggestedTasksOnboardingFollowupRequestSchema,
} from '@roomote/sdk/server';

import {
  buildSuggestedTasksSettingsUrl,
  runSuggestedTasksOnboardingFollowupJob,
} from './suggested-tasks-onboarding-followup';

/**
 * Teams counterpart of the Slack/Telegram suggested-tasks onboarding
 * follow-up. Teams has no URL buttons without Adaptive Cards, so the
 * Automations link rides in the markdown text; the enqueue-side claim plus
 * BullMQ jobId dedup keep it to one send.
 */
export const teamsSuggestedTasksOnboardingFollowupJob = async (
  job: Job,
): Promise<void> => {
  await runSuggestedTasksOnboardingFollowupJob({
    job,
    label: 'TeamsSuggestedTasksOnboardingFollowup',
    requestSchema: teamsSuggestedTasksOnboardingFollowupRequestSchema,
    send: async (data) => {
      const provider =
        await createTeamsCommunicationProviderFromRuntimeCredentials();

      if (!provider) {
        console.warn(
          '[TeamsSuggestedTasksOnboardingFollowup] Teams bot credentials are not configured, skipping',
        );
        return;
      }

      const settingsUrl = buildSuggestedTasksSettingsUrl({
        source: 'teams',
        campaign: 'teams.suggested_tasks_followup',
      });

      await provider.postMessage({
        channelId: data.conversationId,
        serviceUrl: data.serviceUrl,
        replyToMessageId: data.introMessageId,
        threadId: data.introMessageId,
        text: buildSuggestedTasksFollowupReminderText({
          automationsLabel: `[Automations](${settingsUrl})`,
        }),
        textFormat: 'markdown',
      });

      console.log(
        `[TeamsSuggestedTasksOnboardingFollowup] Posted follow-up to conversation ${data.conversationId} for sourceTaskId=${data.sourceTaskId}`,
      );
    },
  });
};
