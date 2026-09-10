import { formatErrorForLog } from '@roomote/types';
import {
  db,
  and,
  count,
  deploymentSettings,
  eq,
  isNull,
  slackInstallationChannels,
  type SlackInstallation,
} from '@roomote/db/server';
import type {
  SlackMemberJoinedChannelEvent,
  SlackNotifier,
} from '@roomote/slack';

import { SLACK_WELCOME_MESSAGE_CHANNEL_LIMIT } from '../constants.js';

const MANAGER_CHANNEL_CANDIDATE_NAME = 'roomote-managers';

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
    .select({ joinedChannelCount: count() })
    .from(slackInstallationChannels)
    .where(
      eq(slackInstallationChannels.slackInstallationId, slackInstallation.id),
    );

  const settings = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, 'default'),
  });
  const publicChannels = await slack.listPublicChannels();
  const publicChannelName =
    publicChannels.find((channel) => channel.id === event.channel)?.name ??
    null;
  const isConfiguredManagerChannel =
    settings?.managerSlackChannelId === event.channel;
  let registeredManagerChannel = false;

  if (
    !settings?.managerSlackChannelId &&
    !settings?.managerDiscordChannelId &&
    publicChannelName?.toLowerCase() === MANAGER_CHANNEL_CANDIDATE_NAME
  ) {
    const now = new Date();
    const [registered] = await db
      .insert(deploymentSettings)
      .values({ managerSlackChannelId: event.channel, updatedAt: now })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: { managerSlackChannelId: event.channel, updatedAt: now },
        // A destination may have been chosen after the settings read.
        setWhere: and(
          isNull(deploymentSettings.managerSlackChannelId),
          isNull(deploymentSettings.managerDiscordChannelId),
        ),
      })
      .returning({ id: deploymentSettings.id });
    registeredManagerChannel = Boolean(registered);
  }

  if (
    !isConfiguredManagerChannel &&
    !registeredManagerChannel &&
    (channelSummary?.joinedChannelCount ?? 0) >
      SLACK_WELCOME_MESSAGE_CHANNEL_LIMIT
  ) {
    return;
  }

  const welcomeText = isConfiguredManagerChannel
    ? [
        'Thanks for adding me to the manager channel!',
        "I'll use this channel for manager-facing questions, self-improvement suggestions and more.",
      ].join('\n')
    : registeredManagerChannel
      ? [
          `Thanks for adding me to #${MANAGER_CHANNEL_CANDIDATE_NAME}.`,
          "I've set it as your Manager Channel for manager-facing questions, self-improvement suggestions and more.",
        ].join('\n')
      : `Hi humans, <@${slackInstallation.botUserId}> here. If you have questions about your code or want me to get anything done, just @-mention me or DM me directly. Can't wait to help!`;

  try {
    await slack.postMessage({
      channel: event.channel,
      text: welcomeText,
      blocks: [{ type: 'markdown', text: welcomeText }],
    });
  } catch (error) {
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
}
