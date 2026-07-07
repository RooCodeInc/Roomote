import { randomUUID } from 'node:crypto';

import { Job } from 'bullmq';

import {
  and,
  db,
  eq,
  slackInstallations,
  slackUserMappings,
} from '@roomote/db/server';
import {
  buildSuggestedTasksOnboardingFollowupPromptBlocks,
  clearPendingSuggestedTasksOnboardingFollowupPrompt,
  getSuggestedTasksOnboardingFollowupPromptSentMarker,
  setPendingSuggestedTasksOnboardingFollowupPrompt,
  setSuggestedTasksOnboardingFollowupPromptSentMarker,
  SlackNotifier,
  type PendingSuggestedTasksOnboardingFollowupPrompt,
  SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_TEXT,
} from '@roomote/slack';
import {
  recordSlackConversationMessageBestEffort,
  slackSuggestedTasksOnboardingFollowupRequestSchema,
  type SlackSuggestedTasksOnboardingFollowupRequest,
} from '@roomote/sdk/server';

import {
  buildSuggestedTasksSettingsUrl,
  runSuggestedTasksOnboardingFollowupJob,
} from './suggested-tasks-onboarding-followup';

/**
 * Slack variant of the suggested-tasks onboarding follow-up. Unlike the
 * Telegram/Teams reminders, Slack posts an interactive enable-suggester
 * prompt, so the job also maintains the Redis pending-prompt and prompt-sent
 * state that the Block Kit actions resolve later.
 */
export const slackSuggestedTasksOnboardingFollowupJob = async (
  job: Job,
): Promise<void> => {
  await runSuggestedTasksOnboardingFollowupJob({
    job,
    label: 'SlackSuggestedTasksOnboardingFollowup',
    requestSchema: slackSuggestedTasksOnboardingFollowupRequestSchema,
    send: sendSlackSuggestedTasksOnboardingFollowup,
  });
};

async function sendSlackSuggestedTasksOnboardingFollowup(
  data: SlackSuggestedTasksOnboardingFollowupRequest,
): Promise<void> {
  const promptSentMarker =
    await getSuggestedTasksOnboardingFollowupPromptSentMarker(data.threadTs);

  if (promptSentMarker) {
    try {
      await setPendingSuggestedTasksOnboardingFollowupPrompt({
        threadId: data.threadTs,
        payload: promptSentMarker.pendingPrompt,
      });
    } catch (error) {
      console.warn(
        `[SlackSuggestedTasksOnboardingFollowup] Failed to restore pending prompt from sent marker for ${data.channelId}/${data.threadTs}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    console.log(
      `[SlackSuggestedTasksOnboardingFollowup] Prompt already sent for ${data.channelId}/${data.threadTs}, skipping duplicate follow-up`,
    );
    return;
  }

  const slackInstallation = await db.query.slackInstallations.findFirst({
    where: and(
      eq(slackInstallations.teamId, data.slackTeamId),
      eq(slackInstallations.isActive, true),
    ),
    columns: { botAccessToken: true },
  });

  if (!slackInstallation) {
    console.warn(
      `[SlackSuggestedTasksOnboardingFollowup] No active Slack installation for team ${data.slackTeamId}, skipping`,
    );
    return;
  }

  const userMapping = await db.query.slackUserMappings.findFirst({
    where: and(
      eq(slackUserMappings.slackTeamId, data.slackTeamId),
      eq(slackUserMappings.slackUserId, data.slackUserId),
    ),
    columns: { id: true, userId: true, slackUserId: true },
  });

  if (!userMapping) {
    console.warn(
      `[SlackSuggestedTasksOnboardingFollowup] Installer mapping is no longer active for ${data.slackUserId} in ${data.slackTeamId}, skipping`,
    );
    return;
  }

  const settingsUrl = buildSuggestedTasksSettingsUrl();
  const nonce = randomUUID();
  const pendingPromptPayload: PendingSuggestedTasksOnboardingFollowupPrompt = {
    slackTeamId: data.slackTeamId,
    slackUserId: data.slackUserId,
    channelId: data.channelId,
    threadTs: data.threadTs,
    nonce,
    settingsUrl,
  };

  await setPendingSuggestedTasksOnboardingFollowupPrompt({
    threadId: data.threadTs,
    payload: pendingPromptPayload,
  });

  const slack = new SlackNotifier(slackInstallation.botAccessToken);

  try {
    const messageTs = await slack.postMessage({
      channel: data.channelId,
      thread_ts: data.threadTs,
      text: SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_TEXT,
      blocks: buildSuggestedTasksOnboardingFollowupPromptBlocks({
        settingsUrl,
        nonce,
      }),
    });

    if (!messageTs) {
      await clearPendingSuggestedTasksOnboardingFollowupPrompt(data.threadTs);
      console.warn(
        `[SlackSuggestedTasksOnboardingFollowup] Failed to post follow-up prompt in ${data.channelId}/${data.threadTs}`,
      );
      return;
    }

    try {
      await setSuggestedTasksOnboardingFollowupPromptSentMarker({
        threadId: data.threadTs,
        marker: {
          channelId: data.channelId,
          messageTs,
          promptSentAt: new Date().toISOString(),
          pendingPrompt: pendingPromptPayload,
        },
      });
    } catch (error) {
      console.warn(
        `[SlackSuggestedTasksOnboardingFollowup] Failed to persist prompt-sent marker in ${data.channelId}/${data.threadTs}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await recordSlackConversationMessageBestEffort({
      logContext: 'slackSuggestedTasksOnboardingFollowup',
      subjectUserId: userMapping.userId,
      slackTeamId: data.slackTeamId,
      subjectSlackUserId: userMapping.slackUserId,
      slackChannelId: data.channelId,
      conversationKind: 'thread',
      threadTs: data.threadTs,
      messageTs,
      direction: 'outbound',
      authorKind: 'roomote',
      source: 'suggested_tasks_followup',
      text: SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_TEXT,
    });
  } catch (error) {
    await clearPendingSuggestedTasksOnboardingFollowupPrompt(data.threadTs);
    throw error;
  }
}
