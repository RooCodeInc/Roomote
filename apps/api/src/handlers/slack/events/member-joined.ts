import { formatErrorForLog } from '@roomote/types';
import {
  db,
  count,
  deploymentSettings,
  eq,
  upsertAutomation,
  getBackgroundAgentSettingsForDeployment,
  MANAGER_CHANNEL_STARTER_AUTOMATION_SETTINGS,
  slackInstallationChannels,
  type BackgroundAgentSettings,
  type SlackInstallation,
} from '@roomote/db/server';
import type {
  SlackMemberJoinedChannelEvent,
  SlackNotifier,
} from '@roomote/slack';
import { captureActivationAutomationChanged } from '@roomote/telemetry/server';

import { SLACK_WELCOME_MESSAGE_CHANNEL_LIMIT } from '../constants.js';

const MANAGER_CHANNEL_CANDIDATE_NAME = 'roomote-managers';

function buildStarterAutomationTargets(channelId: string | null) {
  return channelId
    ? [
        {
          provider: 'slack' as const,
          targetKind: 'slack_channel' as const,
          externalRef: channelId,
        },
      ]
    : [];
}

async function syncManagerStarterAutomations(params: {
  settings: Pick<
    BackgroundAgentSettings,
    | 'suggesterFrequency'
    | 'suggesterInstructions'
    | 'suggesterSlackChannelId'
    | 'announcerFrequency'
    | 'announcerInstructions'
    | 'announcerSlackChannelId'
    | 'managerStatsFrequency'
  >;
  updatedAt: Date;
}) {
  const { settings, updatedAt } = params;

  await Promise.all([
    upsertAutomation(db, {
      key: 'suggester',
      enabled: settings.suggesterFrequency !== 'off',
      schedule: { mode: settings.suggesterFrequency },
      instructions: settings.suggesterInstructions ?? null,
      targets: buildStarterAutomationTargets(settings.suggesterSlackChannelId),
      managedTargetKinds: ['slack_channel'],
      updatedAt,
    }),
    upsertAutomation(db, {
      key: 'announcer',
      enabled: settings.announcerFrequency !== 'off',
      schedule: { mode: settings.announcerFrequency },
      instructions: settings.announcerInstructions ?? null,
      targets: buildStarterAutomationTargets(settings.announcerSlackChannelId),
      managedTargetKinds: ['slack_channel'],
      updatedAt,
    }),
    upsertAutomation(db, {
      key: 'manager_stats',
      enabled: settings.managerStatsFrequency !== 'off',
      schedule: { mode: settings.managerStatsFrequency },
      updatedAt,
    }),
  ]);
}

export async function maybePostSlackChannelWelcome(params: {
  event: SlackMemberJoinedChannelEvent;
  slackInstallation: SlackInstallation;
  slack: SlackNotifier;
}): Promise<void> {
  const { event, slackInstallation, slack } = params;

  if (event.user !== slackInstallation.botUserId) {
    return;
  }

  const [insertedChannel] = await db
    .insert(slackInstallationChannels)
    .values({
      slackInstallationId: slackInstallation.id,
      channelId: event.channel,
    })
    .onConflictDoNothing()
    .returning({ id: slackInstallationChannels.id });

  if (!insertedChannel) {
    return;
  }

  const [channelSummary] = await db
    .select({
      joinedChannelCount: count(),
    })
    .from(slackInstallationChannels)
    .where(
      eq(slackInstallationChannels.slackInstallationId, slackInstallation.id),
    );

  const settings = await getBackgroundAgentSettingsForDeployment();

  const publicChannels = await slack.listPublicChannels();
  const publicChannelName =
    publicChannels.find((channel) => channel.id === event.channel)?.name ??
    null;
  const isConfiguredManagerChannel =
    settings.managerSlackChannelId === event.channel;
  const isManagerChannelCandidate =
    !settings.managerSlackChannelId &&
    publicChannelName?.toLowerCase() === MANAGER_CHANNEL_CANDIDATE_NAME;

  if (
    !isConfiguredManagerChannel &&
    !isManagerChannelCandidate &&
    (channelSummary?.joinedChannelCount ?? 0) >
      SLACK_WELCOME_MESSAGE_CHANNEL_LIMIT
  ) {
    return;
  }

  const shouldEnableStarterAutomations =
    isConfiguredManagerChannel || isManagerChannelCandidate;
  if (shouldEnableStarterAutomations) {
    const now = new Date();

    await db
      .insert(deploymentSettings)
      .values({
        managerSlackChannelId: event.channel,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: {
          managerSlackChannelId: event.channel,
          updatedAt: now,
        },
      });

    await syncManagerStarterAutomations({
      settings: {
        suggesterFrequency:
          MANAGER_CHANNEL_STARTER_AUTOMATION_SETTINGS.suggesterFrequency,
        suggesterInstructions: settings.suggesterInstructions,
        suggesterSlackChannelId: settings.suggesterSlackChannelId,
        announcerFrequency:
          MANAGER_CHANNEL_STARTER_AUTOMATION_SETTINGS.announcerFrequency,
        announcerInstructions: settings.announcerInstructions,
        announcerSlackChannelId: settings.announcerSlackChannelId,
        managerStatsFrequency:
          MANAGER_CHANNEL_STARTER_AUTOMATION_SETTINGS.managerStatsFrequency,
      },
      updatedAt: now,
    });
  }

  const welcomeText = isConfiguredManagerChannel
    ? [
        `Thanks for adding me to the manager channel!`,
        "I'll use this channel for manager-facing questions, self-improvement suggestions and more.",
        "I've enabled daily ideas, weekly PR summaries, and weekly manager stats here.",
      ].join('\n')
    : isManagerChannelCandidate
      ? [
          `Thanks for adding me to #${MANAGER_CHANNEL_CANDIDATE_NAME}.`,
          'This looks like a good shared manager channel.',
          "I've set it as your Manager Channel and enabled daily ideas, weekly PR summaries, and weekly manager stats here.",
        ].join('\n')
      : `Hi humans, <@${slackInstallation.botUserId}> here. If you have questions about your code or want me to get anything done, just @-mention me or DM me directly. Can't wait to help!`;

  try {
    await slack.postMessage({
      channel: event.channel,
      text: welcomeText,
      blocks: [
        {
          type: 'markdown',
          text: welcomeText,
        },
      ],
    });
  } catch (error) {
    if (shouldEnableStarterAutomations) {
      await db
        .update(deploymentSettings)
        .set({
          managerSlackChannelId: settings.managerSlackChannelId,
          updatedAt: new Date(),
        })
        .where(eq(deploymentSettings.id, 'default'))
        .catch((cleanupError) => {
          console.warn(
            `[SlackWebhook] Failed to rollback manager-channel automation settings for ${event.channel}: ${formatErrorForLog(cleanupError)}`,
          );
        });

      await syncManagerStarterAutomations({
        settings: {
          suggesterFrequency: settings.suggesterFrequency,
          suggesterInstructions: settings.suggesterInstructions,
          suggesterSlackChannelId: settings.suggesterSlackChannelId,
          announcerFrequency: settings.announcerFrequency,
          announcerInstructions: settings.announcerInstructions,
          announcerSlackChannelId: settings.announcerSlackChannelId,
          managerStatsFrequency: settings.managerStatsFrequency,
        },
        updatedAt: new Date(),
      }).catch((cleanupError) => {
        console.warn(
          `[SlackWebhook] Failed to rollback starter automations for ${event.channel}: ${formatErrorForLog(cleanupError)}`,
        );
      });
    }

    await db
      .delete(slackInstallationChannels)
      .where(eq(slackInstallationChannels.id, insertedChannel.id))
      .catch((cleanupError) => {
        console.warn(
          `[SlackWebhook] Failed to rollback welcome-channel claim for ${slackInstallation.id}:${event.channel}: ${formatErrorForLog(cleanupError)}`,
        );
      });

    throw error;
  }

  if (shouldEnableStarterAutomations) {
    for (const [automation, wasEnabled] of [
      ['suggester', settings.suggesterFrequency !== 'off'],
      ['announcer', settings.announcerFrequency !== 'off'],
      ['manager_stats', settings.managerStatsFrequency !== 'off'],
    ] as const) {
      if (!wasEnabled) {
        void captureActivationAutomationChanged('enabled', automation);
      }
    }
  }
}
