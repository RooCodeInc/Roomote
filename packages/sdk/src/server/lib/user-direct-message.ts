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

import {
  canStartAgentMailConversationWithUser,
  startAgentMailConversation,
} from './agentmail/outbound';
import { createDiscordCommunicationProviderFromRuntimeCredentials } from './discord-communication';
import { createTeamsCommunicationProviderFromRuntimeCredentials } from './teams-communication';
import { createTelegramCommunicationProviderFromRuntimeCredentials } from './telegram-communication';
import { findTeamsPrimaryConversation } from './teams-primary-conversation';

export type UserDirectMessageProvider =
  | 'slack'
  | 'teams'
  | 'telegram'
  | 'discord'
  | 'agentmail';

export type UserDirectMessageDestination = {
  channelId: string;
  teamId?: string;
  serviceUrl?: string;
};

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function resolveSlackUserDirectMessage(userId: string): Promise<{
  channelId: string;
  slack: SlackNotifier;
  teamId: string;
} | null> {
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
    const channelId = await slack.openConversation(mapping.slackUserId);
    if (channelId) {
      return { channelId, slack, teamId: installation.teamId };
    }
  }

  return null;
}

export async function findSlackUserDirectMessageDestination(
  userId: string,
): Promise<{ channelId: string; teamId: string } | null> {
  const destination = await resolveSlackUserDirectMessage(userId);
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
    teamId: mapping.teamsTenantId,
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
    case 'agentmail':
      // Email conversations are created at send time (there is no standing
      // DM channel), so email cannot be a pre-resolved task destination;
      // automation destinations over email are a follow-up.
      return null;
  }

  return null;
}

export async function hasUserDirectMessageIdentity(
  provider: CommunicationProvider,
  userId: string,
): Promise<boolean> {
  switch (provider) {
    case 'slack': {
      const installations = await db.query.slackInstallations.findMany({
        where: eq(slackInstallations.isActive, true),
        columns: { teamId: true },
      });
      for (const installation of installations) {
        const mapping = await db.query.slackUserMappings.findFirst({
          where: and(
            eq(slackUserMappings.userId, userId),
            eq(slackUserMappings.slackTeamId, installation.teamId),
          ),
          columns: { slackUserId: true },
        });
        if (mapping) return true;
      }
      return false;
    }
    case 'teams':
      return Boolean(
        await db.query.teamsUserMappings.findFirst({
          where: eq(teamsUserMappings.userId, userId),
          columns: { teamsUserId: true },
        }),
      );
    case 'telegram':
      return Boolean(
        await db.query.telegramUserMappings.findFirst({
          where: eq(telegramUserMappings.userId, userId),
          columns: { telegramChatId: true },
        }),
      );
    case 'discord':
      return Boolean(
        await db.query.discordUserMappings.findFirst({
          where: eq(discordUserMappings.userId, userId),
          columns: { discordUserId: true },
        }),
      );
    case 'agentmail':
      // True when a consent-checked address exists (verified account email
      // or explicitly linked mailbox, not suppressed) and email is set up.
      return canStartAgentMailConversationWithUser(userId);
  }
}

async function sendSlackUserDirectMessage(
  userId: string,
  text: string,
  logContext: string,
  blocks?: unknown[],
): Promise<boolean> {
  try {
    const destination = await resolveSlackUserDirectMessage(userId);
    if (destination) {
      const messageTs = await destination.slack.postMessage({
        channel: destination.channelId,
        text,
        ...(blocks ? { blocks } : {}),
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
 * Email needs a subject line the chat providers never supply; derive one
 * from the first content line so the inbox row is meaningful.
 */
function deriveEmailSubject(text: string): string {
  const firstLine = text
    .split('\n')
    .map((line) => line.replace(/^[#>\s*-]+/, '').trim())
    .find(Boolean);
  const subject = firstLine ?? 'Notification';
  return subject.length > 80 ? `${subject.slice(0, 77)}...` : subject;
}

async function sendAgentMailUserDirectMessage(
  userId: string,
  text: string,
  logContext: string,
): Promise<boolean> {
  try {
    return await startAgentMailConversation({
      userId,
      subject: deriveEmailSubject(text),
      text,
      logContext,
    });
  } catch (error) {
    console.warn(
      `[${logContext}] Failed to send email DM: ${formatError(error)}`,
    );
    return false;
  }
}

async function sendDiscordUserDirectMessage(
  userId: string,
  text: string,
  logContext: string,
): Promise<boolean> {
  try {
    const destination = await findDiscordUserDirectMessageDestination(userId);
    if (!destination) {
      return false;
    }

    const provider =
      await createDiscordCommunicationProviderFromRuntimeCredentials();
    if (!provider) {
      return false;
    }

    await provider.postMessage({
      channelId: destination.channelId,
      text,
      textFormat: 'markdown',
    });
    return true;
  } catch (error) {
    console.warn(
      `[${logContext}] Failed to send Discord DM: ${formatError(error)}`,
    );
    return false;
  }
}

export async function sendUserDirectMessage({
  provider,
  userId,
  text,
  slackBlocks,
  logContext,
}: {
  provider: CommunicationProvider;
  userId: string;
  text: string;
  slackBlocks?: unknown[];
  logContext: string;
}): Promise<boolean> {
  switch (provider) {
    case 'slack':
      return sendSlackUserDirectMessage(userId, text, logContext, slackBlocks);
    case 'teams':
      return sendTeamsUserDirectMessage(userId, text, logContext);
    case 'telegram':
      return sendTelegramUserDirectMessage(userId, text, logContext);
    case 'discord':
      return sendDiscordUserDirectMessage(userId, text, logContext);
    case 'agentmail':
      return sendAgentMailUserDirectMessage(userId, text, logContext);
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
  const [slack, teams, telegram, discord] = await Promise.all([
    sendSlackUserDirectMessage(userId, text, logContext),
    sendTeamsUserDirectMessage(userId, text, logContext),
    sendTelegramUserDirectMessage(userId, text, logContext),
    sendDiscordUserDirectMessage(userId, text, logContext),
  ]);

  const chatDelivered = slack || teams || telegram || discord;

  // Email is the fallback reach, not another parallel copy: emailing a user
  // who already got the message in chat violates the email-cadence contract
  // (email is low-frequency by design).
  const agentmail = chatDelivered
    ? false
    : await sendAgentMailUserDirectMessage(userId, text, logContext);

  return [
    ...(slack ? (['slack'] as const) : []),
    ...(teams ? (['teams'] as const) : []),
    ...(telegram ? (['telegram'] as const) : []),
    ...(discord ? (['discord'] as const) : []),
    ...(agentmail ? (['agentmail'] as const) : []),
  ];
}
