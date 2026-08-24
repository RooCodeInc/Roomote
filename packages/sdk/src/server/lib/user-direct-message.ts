import {
  and,
  db,
  discordUserMappings,
  eq,
  slackInstallations,
  slackUserMappings,
  teamsUserMappings,
  telegramUserMappings,
} from '@roomote/db/server';
import type { CommunicationProvider } from '@roomote/types';
import { SlackNotifier } from '@roomote/slack';

import { createDiscordCommunicationProviderFromRuntimeCredentials } from './discord-communication';
import { createTeamsCommunicationProviderFromRuntimeCredentials } from './teams-communication';
import { createTelegramCommunicationProviderFromRuntimeCredentials } from './telegram-communication';
import { findTeamsPrimaryConversation } from './teams-primary-conversation';

export type UserDirectMessageDestination = {
  channelId: string;
  teamId?: string;
  serviceUrl?: string;
};

export type UserDirectMessageAttempt =
  | { provider: CommunicationProvider; status: 'unlinked' }
  | { provider: CommunicationProvider; status: 'sent' }
  | { provider: CommunicationProvider; status: 'failed' };

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function resolveSlackUserDirectMessage(userId: string): Promise<{
  destination: {
    channelId: string;
    slack: SlackNotifier;
    teamId: string;
  } | null;
  linked: boolean;
}> {
  const installations = await db.query.slackInstallations.findMany({
    where: eq(slackInstallations.isActive, true),
    columns: { botAccessToken: true, teamId: true },
  });
  let linked = false;

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
    linked = true;

    const slack = new SlackNotifier(installation.botAccessToken);
    const channelId = await slack.openConversation(mapping.slackUserId);
    if (channelId) {
      return {
        destination: { channelId, slack, teamId: installation.teamId },
        linked,
      };
    }
  }

  return { destination: null, linked };
}

export async function findSlackUserDirectMessageDestination(
  userId: string,
): Promise<{ channelId: string; teamId: string } | null> {
  const { destination } = await resolveSlackUserDirectMessage(userId);
  return destination
    ? { channelId: destination.channelId, teamId: destination.teamId }
    : null;
}

async function findTeamsUserDirectMessageDestination(
  userId: string,
): Promise<UserDirectMessageDestination | null> {
  const mapping = await db.query.teamsUserMappings.findFirst({
    where: eq(teamsUserMappings.userId, userId),
    columns: { teamsUserId: true, teamsTenantId: true },
  });
  if (!mapping) return null;

  const conversation = await findTeamsPrimaryConversation();
  if (!conversation) return null;

  const provider =
    await createTeamsCommunicationProviderFromRuntimeCredentials();
  if (!provider) return null;

  const destination = await provider.createDirectMessage({
    serviceUrl: conversation.serviceUrl,
    tenantId: mapping.teamsTenantId,
    userId: mapping.teamsUserId,
  });
  return {
    channelId: destination.channelId,
    serviceUrl: conversation.serviceUrl,
  };
}

async function findTelegramUserDirectMessageDestination(
  userId: string,
): Promise<UserDirectMessageDestination | null> {
  const mapping = await db.query.telegramUserMappings.findFirst({
    where: eq(telegramUserMappings.userId, userId),
    columns: { telegramChatId: true },
  });
  return mapping ? { channelId: mapping.telegramChatId } : null;
}

async function findDiscordUserDirectMessageDestination(
  userId: string,
): Promise<UserDirectMessageDestination | null> {
  const mapping = await db.query.discordUserMappings.findFirst({
    where: eq(discordUserMappings.userId, userId),
    columns: { discordDmChannelId: true, discordUserId: true },
  });
  if (!mapping) return null;
  if (mapping.discordDmChannelId) {
    return { channelId: mapping.discordDmChannelId };
  }

  const provider =
    await createDiscordCommunicationProviderFromRuntimeCredentials();
  if (!provider) return null;

  const destination = await provider.createDirectMessage(mapping.discordUserId);
  return { channelId: destination.id };
}

export async function findUserDirectMessageDestination(
  provider: CommunicationProvider,
  userId: string,
): Promise<UserDirectMessageDestination | null> {
  switch (provider) {
    case 'slack':
      return findSlackUserDirectMessageDestination(userId);
    case 'teams':
      return findTeamsUserDirectMessageDestination(userId);
    case 'telegram':
      return findTelegramUserDirectMessageDestination(userId);
    case 'discord':
      return findDiscordUserDirectMessageDestination(userId);
  }

  return null;
}

async function sendSlackUserDirectMessage(
  userId: string,
  text: string,
  logContext: string,
): Promise<UserDirectMessageAttempt['status']> {
  try {
    const { destination, linked } = await resolveSlackUserDirectMessage(userId);
    if (destination) {
      const messageTs = await destination.slack.postMessage({
        channel: destination.channelId,
        text,
      });

      if (messageTs) {
        return 'sent';
      }
    }

    return linked ? 'failed' : 'unlinked';
  } catch (error) {
    console.warn(
      `[${logContext}] Failed to send Slack DM: ${formatError(error)}`,
    );
  }

  return 'failed';
}

async function sendTeamsUserDirectMessage(
  userId: string,
  text: string,
  logContext: string,
): Promise<UserDirectMessageAttempt['status']> {
  try {
    const mapping = await db.query.teamsUserMappings.findFirst({
      where: eq(teamsUserMappings.userId, userId),
      columns: { teamsUserId: true, teamsTenantId: true },
    });

    if (!mapping) {
      return 'unlinked';
    }

    // Proactive DMs need a service URL, which lives on installations rather
    // than user mappings; the primary conversation's URL covers the tenant.
    const conversation = await findTeamsPrimaryConversation();

    if (!conversation) {
      return 'failed';
    }

    const provider =
      await createTeamsCommunicationProviderFromRuntimeCredentials();

    if (!provider) {
      return 'failed';
    }

    await provider.postDirectMessage({
      serviceUrl: conversation.serviceUrl,
      tenantId: mapping.teamsTenantId,
      userId: mapping.teamsUserId,
      text,
      textFormat: 'markdown',
    });

    return 'sent';
  } catch (error) {
    console.warn(
      `[${logContext}] Failed to send Teams DM: ${formatError(error)}`,
    );

    return 'failed';
  }
}

async function sendTelegramUserDirectMessage(
  userId: string,
  text: string,
  logContext: string,
): Promise<UserDirectMessageAttempt['status']> {
  try {
    const mapping = await db.query.telegramUserMappings.findFirst({
      where: eq(telegramUserMappings.userId, userId),
      columns: { telegramChatId: true },
    });

    if (!mapping) {
      return 'unlinked';
    }

    const provider =
      await createTelegramCommunicationProviderFromRuntimeCredentials();

    if (!provider) {
      return 'failed';
    }

    await provider.postMessage({
      channelId: mapping.telegramChatId,
      text,
      textFormat: 'markdown',
    });

    return 'sent';
  } catch (error) {
    console.warn(
      `[${logContext}] Failed to send Telegram DM: ${formatError(error)}`,
    );

    return 'failed';
  }
}

async function sendDiscordUserDirectMessage(
  userId: string,
  text: string,
  logContext: string,
): Promise<UserDirectMessageAttempt['status']> {
  try {
    const mapping = await db.query.discordUserMappings.findFirst({
      where: eq(discordUserMappings.userId, userId),
      columns: { discordDmChannelId: true, discordUserId: true },
    });
    if (!mapping) {
      return 'unlinked';
    }

    const provider =
      await createDiscordCommunicationProviderFromRuntimeCredentials();
    if (!provider) {
      return 'failed';
    }

    const channelId =
      mapping.discordDmChannelId ??
      (await provider.createDirectMessage(mapping.discordUserId)).id;

    await provider.postMessage({
      channelId,
      text,
      textFormat: 'markdown',
    });
    return 'sent';
  } catch (error) {
    console.warn(
      `[${logContext}] Failed to send Discord DM: ${formatError(error)}`,
    );
    return 'failed';
  }
}

export async function attemptUserDirectMessage({
  provider,
  userId,
  text,
  logContext,
}: {
  provider: CommunicationProvider;
  userId: string;
  text: string;
  logContext: string;
}): Promise<UserDirectMessageAttempt> {
  let status: UserDirectMessageAttempt['status'];
  switch (provider) {
    case 'slack':
      status = await sendSlackUserDirectMessage(userId, text, logContext);
      break;
    case 'teams':
      status = await sendTeamsUserDirectMessage(userId, text, logContext);
      break;
    case 'telegram':
      status = await sendTelegramUserDirectMessage(userId, text, logContext);
      break;
    case 'discord':
      status = await sendDiscordUserDirectMessage(userId, text, logContext);
      break;
  }

  return { provider, status };
}
