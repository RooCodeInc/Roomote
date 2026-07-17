import {
  and,
  db,
  eq,
  slackInstallations,
  slackUserMappings,
  teamsUserMappings,
  telegramUserMappings,
} from '@roomote/db/server';
import { SlackNotifier } from '@roomote/slack';

import { createTeamsCommunicationProviderFromRuntimeCredentials } from './teams-communication';
import { createTelegramCommunicationProviderFromRuntimeCredentials } from './telegram-communication';
import { findTeamsPrimaryConversation } from './teams-primary-conversation';

export type UserDirectMessageProvider = 'slack' | 'teams' | 'telegram';

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function sendSlackUserDirectMessage(
  userId: string,
  text: string,
  logContext: string,
): Promise<boolean> {
  try {
    const installations = await db.query.slackInstallations.findMany({
      where: eq(slackInstallations.isActive, true),
      columns: { botAccessToken: true, teamId: true },
    });

    for (const installation of installations) {
      const mapping = await db.query.slackUserMappings.findFirst({
        where: and(
          eq(slackUserMappings.userId, userId),
          eq(slackUserMappings.slackTeamId, installation.teamId),
        ),
        columns: { slackUserId: true },
      });

      if (!mapping) {
        continue;
      }

      const slack = new SlackNotifier(installation.botAccessToken);
      const dmChannelId = await slack.openConversation(mapping.slackUserId);

      if (!dmChannelId) {
        continue;
      }

      const messageTs = await slack.postMessage({
        channel: dmChannelId,
        text,
      });

      if (messageTs) {
        return true;
      }
    }
  } catch (error) {
    console.warn(
      `[${logContext}] Failed to send Slack DM: ${formatError(error)}`,
    );
  }

  return false;
}

async function sendTeamsUserDirectMessage(
  userId: string,
  text: string,
  logContext: string,
): Promise<boolean> {
  try {
    const mapping = await db.query.teamsUserMappings.findFirst({
      where: eq(teamsUserMappings.userId, userId),
      columns: { teamsUserId: true, teamsTenantId: true },
    });

    if (!mapping) {
      return false;
    }

    // Proactive DMs need a service URL, which lives on installations rather
    // than user mappings; the primary conversation's URL covers the tenant.
    const conversation = await findTeamsPrimaryConversation();

    if (!conversation) {
      return false;
    }

    const provider =
      await createTeamsCommunicationProviderFromRuntimeCredentials();

    if (!provider) {
      return false;
    }

    await provider.postDirectMessage({
      serviceUrl: conversation.serviceUrl,
      tenantId: mapping.teamsTenantId,
      userId: mapping.teamsUserId,
      text,
      textFormat: 'markdown',
    });

    return true;
  } catch (error) {
    console.warn(
      `[${logContext}] Failed to send Teams DM: ${formatError(error)}`,
    );

    return false;
  }
}

async function sendTelegramUserDirectMessage(
  userId: string,
  text: string,
  logContext: string,
): Promise<boolean> {
  try {
    const mapping = await db.query.telegramUserMappings.findFirst({
      where: eq(telegramUserMappings.userId, userId),
      columns: { telegramChatId: true },
    });

    if (!mapping) {
      return false;
    }

    const provider =
      await createTelegramCommunicationProviderFromRuntimeCredentials();

    if (!provider) {
      return false;
    }

    await provider.postMessage({
      channelId: mapping.telegramChatId,
      text,
      textFormat: 'markdown',
    });

    return true;
  } catch (error) {
    console.warn(
      `[${logContext}] Failed to send Telegram DM: ${formatError(error)}`,
    );

    return false;
  }
}

/**
 * Best-effort DM to a Roomote user on every chat integration that is both
 * connected on this deployment and linked to the user. Failures are logged
 * and swallowed; returns the providers that accepted the message.
 */
export async function sendUserDirectMessageBestEffort({
  userId,
  text,
  logContext,
}: {
  userId: string;
  text: string;
  logContext: string;
}): Promise<UserDirectMessageProvider[]> {
  const [slack, teams, telegram] = await Promise.all([
    sendSlackUserDirectMessage(userId, text, logContext),
    sendTeamsUserDirectMessage(userId, text, logContext),
    sendTelegramUserDirectMessage(userId, text, logContext),
  ]);

  return [
    ...(slack ? (['slack'] as const) : []),
    ...(teams ? (['teams'] as const) : []),
    ...(telegram ? (['telegram'] as const) : []),
  ];
}
