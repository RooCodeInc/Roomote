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
  startAgentMailConversationWithResult,
} from './agentmail/outbound';
import { createAgentMailCommunicationProviderFromRuntimeCredentials } from './agentmail-communication';
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

export type UserDirectMessageReceipt = {
  provider: UserDirectMessageProvider;
  workspaceId: string;
  channelId: string;
  messageId: string;
  threadId?: string;
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

export async function hasAnyUserDirectMessageIdentity(
  userId: string,
): Promise<boolean> {
  const providers: CommunicationProvider[] = [
    'slack',
    'teams',
    'telegram',
    'discord',
    'agentmail',
  ];
  const available = await Promise.all(
    providers.map((provider) => hasUserDirectMessageIdentity(provider, userId)),
  );
  return available.some(Boolean);
}

async function sendSlackUserDirectMessage(
  userId: string,
  text: string,
  logContext: string,
  blocks?: unknown[],
  idempotencyKey?: string,
  replyAnchor?: UserDirectMessageReceipt,
): Promise<UserDirectMessageReceipt | null> {
  try {
    const destination = replyAnchor
      ? await (async () => {
          const installation = (
            await db.query.slackInstallations.findMany({
              where: eq(slackInstallations.isActive, true),
              columns: { botAccessToken: true, teamId: true },
            })
          ).find(({ teamId }) => teamId === replyAnchor.workspaceId);
          return installation
            ? {
                channelId: replyAnchor.channelId,
                slack: new SlackNotifier(installation.botAccessToken),
                teamId: installation.teamId,
              }
            : null;
        })()
      : await resolveSlackUserDirectMessage(userId);
    if (destination) {
      const threadId = replyAnchor?.threadId ?? replyAnchor?.messageId;
      const messageTs = await destination.slack.postMessage({
        channel: destination.channelId,
        text,
        blocks: blocks ?? [{ type: 'markdown', text }],
        ...(threadId ? { thread_ts: threadId } : {}),
        ...(idempotencyKey ? { client_msg_id: idempotencyKey } : {}),
      });

      if (messageTs) {
        return {
          provider: 'slack',
          workspaceId: destination.teamId,
          channelId: destination.channelId,
          messageId: messageTs,
          threadId: threadId ?? messageTs,
        };
      }
    }
  } catch (error) {
    console.warn(
      `[${logContext}] Failed to send Slack DM: ${formatError(error)}`,
    );
  }

  return null;
}

async function sendTeamsUserDirectMessage(
  userId: string,
  text: string,
  logContext: string,
  replyAnchor?: UserDirectMessageReceipt,
): Promise<UserDirectMessageReceipt | null> {
  try {
    const mapping = replyAnchor
      ? null
      : await db.query.teamsUserMappings.findFirst({
          where: eq(teamsUserMappings.userId, userId),
          columns: { teamsUserId: true, teamsTenantId: true },
        });

    if (!mapping && !replyAnchor) {
      return null;
    }

    // Proactive DMs need a service URL, which lives on installations rather
    // than user mappings; the primary conversation's URL covers the tenant.
    const conversation = await findTeamsPrimaryConversation();

    if (!conversation) {
      return null;
    }

    const provider =
      await createTeamsCommunicationProviderFromRuntimeCredentials();

    if (!provider) {
      return null;
    }

    const threadId = replyAnchor?.threadId ?? replyAnchor?.messageId;
    const posted = replyAnchor
      ? await provider.postMessage({
          channelId: replyAnchor.channelId,
          serviceUrl: conversation.serviceUrl,
          tenantId: replyAnchor.workspaceId,
          text,
          textFormat: 'markdown',
          ...(threadId ? { threadId, replyToMessageId: threadId } : {}),
        })
      : await provider.postDirectMessage({
          serviceUrl: conversation.serviceUrl,
          tenantId: mapping!.teamsTenantId,
          userId: mapping!.teamsUserId,
          text,
          textFormat: 'markdown',
        });

    return {
      provider: 'teams',
      workspaceId: replyAnchor?.workspaceId ?? mapping!.teamsTenantId,
      channelId: posted.channelId,
      messageId: posted.messageId,
      threadId: threadId ?? posted.messageId,
    };
  } catch (error) {
    console.warn(
      `[${logContext}] Failed to send Teams DM: ${formatError(error)}`,
    );

    return null;
  }
}

async function sendTelegramUserDirectMessage(
  userId: string,
  text: string,
  logContext: string,
  idempotencyKey?: string,
  replyAnchor?: UserDirectMessageReceipt,
): Promise<UserDirectMessageReceipt | null> {
  try {
    const mapping = replyAnchor
      ? { telegramChatId: replyAnchor.channelId }
      : await db.query.telegramUserMappings.findFirst({
          where: eq(telegramUserMappings.userId, userId),
          columns: { telegramChatId: true },
        });

    if (!mapping) {
      return null;
    }

    const provider =
      await createTelegramCommunicationProviderFromRuntimeCredentials();

    if (!provider) {
      return null;
    }

    const posted = await provider.postMessage({
      channelId: mapping.telegramChatId,
      text,
      textFormat: 'markdown',
      ...(replyAnchor?.threadId ? { threadId: replyAnchor.threadId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    return {
      provider: 'telegram',
      workspaceId: mapping.telegramChatId,
      channelId: mapping.telegramChatId,
      messageId: posted.lastTextMessageId ?? posted.messageId,
      ...(posted.threadId ? { threadId: posted.threadId } : {}),
    };
  } catch (error) {
    console.warn(
      `[${logContext}] Failed to send Telegram DM: ${formatError(error)}`,
    );

    return null;
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
  idempotencyKey?: string,
  replyAnchor?: UserDirectMessageReceipt,
): Promise<{
  delivered: boolean;
  receipt: UserDirectMessageReceipt | null;
}> {
  try {
    if (replyAnchor) {
      const provider =
        await createAgentMailCommunicationProviderFromRuntimeCredentials();
      if (!provider) return { delivered: false, receipt: null };
      const posted = await provider.postMessage({
        channelId: replyAnchor.channelId,
        text,
        textFormat: 'markdown',
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      return {
        delivered: true,
        receipt: {
          provider: 'agentmail',
          workspaceId: replyAnchor.workspaceId,
          channelId: replyAnchor.channelId,
          messageId: posted.lastTextMessageId ?? posted.messageId,
          ...((posted.threadId ?? replyAnchor.threadId)
            ? { threadId: posted.threadId ?? replyAnchor.threadId }
            : {}),
        },
      };
    }
    const result = await startAgentMailConversationWithResult({
      userId,
      subject: deriveEmailSubject(text),
      text,
      logContext,
      ...(idempotencyKey ? { clientSendId: idempotencyKey } : {}),
    });
    const resultAnchor = result.sent
      ? (result.replyAnchor ?? result.conversation)
      : null;
    return {
      delivered: result.sent,
      receipt:
        result.sent && resultAnchor
          ? {
              provider: 'agentmail',
              workspaceId: resultAnchor.inboxId,
              channelId:
                result.conversation?.conversationId ??
                resultAnchor.providerThreadId,
              messageId:
                resultAnchor.messageId ??
                `thread:${resultAnchor.providerThreadId}`,
              threadId: resultAnchor.providerThreadId,
            }
          : null,
    };
  } catch (error) {
    console.warn(
      `[${logContext}] Failed to send email DM: ${formatError(error)}`,
    );
    return { delivered: false, receipt: null };
  }
}

async function sendDiscordUserDirectMessage(
  userId: string,
  text: string,
  logContext: string,
  idempotencyKey?: string,
  replyAnchor?: UserDirectMessageReceipt,
): Promise<UserDirectMessageReceipt | null> {
  try {
    const destination = replyAnchor
      ? { channelId: replyAnchor.channelId }
      : await findDiscordUserDirectMessageDestination(userId);
    if (!destination) {
      return null;
    }

    const provider =
      await createDiscordCommunicationProviderFromRuntimeCredentials();
    if (!provider) {
      return null;
    }

    const posted = await provider.postMessage({
      channelId: destination.channelId,
      text,
      textFormat: 'markdown',
      ...(replyAnchor?.threadId
        ? { threadId: replyAnchor.threadId }
        : replyAnchor?.messageId
          ? { replyToMessageId: replyAnchor.messageId }
          : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return {
      provider: 'discord',
      workspaceId: 'dm',
      channelId: destination.channelId,
      messageId: posted.lastTextMessageId ?? posted.messageId,
      ...(posted.threadId ? { threadId: posted.threadId } : {}),
    };
  } catch (error) {
    console.warn(
      `[${logContext}] Failed to send Discord DM: ${formatError(error)}`,
    );
    return null;
  }
}

export async function sendUserDirectMessage({
  provider,
  userId,
  text,
  slackBlocks,
  logContext,
  idempotencyKey,
}: {
  provider: CommunicationProvider;
  userId: string;
  text: string;
  slackBlocks?: unknown[];
  logContext: string;
  idempotencyKey?: string;
}): Promise<boolean> {
  switch (provider) {
    case 'slack':
      return Boolean(
        await sendSlackUserDirectMessage(
          userId,
          text,
          logContext,
          slackBlocks,
          idempotencyKey,
        ),
      );
    case 'teams':
      return Boolean(
        await sendTeamsUserDirectMessage(userId, text, logContext),
      );
    case 'telegram':
      return Boolean(
        await sendTelegramUserDirectMessage(
          userId,
          text,
          logContext,
          idempotencyKey,
        ),
      );
    case 'discord':
      return Boolean(
        await sendDiscordUserDirectMessage(
          userId,
          text,
          logContext,
          idempotencyKey,
        ),
      );
    case 'agentmail':
      return (
        await sendAgentMailUserDirectMessage(
          userId,
          text,
          logContext,
          idempotencyKey,
        )
      ).delivered;
  }
}

/**
 * Best-effort DM to a Roomote user through the first personal integration that
 * accepts it. Failures are logged and swallowed so the waterfall can continue.
 */
export async function sendUserDirectMessageBestEffort({
  userId,
  text,
  logContext,
  idempotencyKey,
}: {
  userId: string;
  text: string;
  logContext: string;
  idempotencyKey?: string;
}): Promise<UserDirectMessageProvider[]> {
  return (
    await sendUserDirectMessageBestEffortWithReceipts({
      userId,
      text,
      logContext,
      idempotencyKey,
    })
  ).deliveredProviders;
}

export async function sendUserDirectMessageBestEffortWithReceipts({
  userId,
  text,
  teamsText,
  logContext,
  idempotencyKey,
  replyAnchor,
}: {
  userId: string;
  text: string;
  teamsText?: string;
  logContext: string;
  idempotencyKey?: string;
  replyAnchor?: UserDirectMessageReceipt;
}): Promise<{
  deliveredProviders: UserDirectMessageProvider[];
  receipts: UserDirectMessageReceipt[];
}> {
  const providers: UserDirectMessageProvider[] = [
    ...(replyAnchor ? [replyAnchor.provider] : []),
    ...(['slack', 'teams', 'telegram', 'discord', 'agentmail'] as const).filter(
      (provider) => provider !== replyAnchor?.provider,
    ),
  ];

  for (const provider of providers) {
    const anchor = provider === replyAnchor?.provider ? replyAnchor : undefined;
    if (provider === 'agentmail') {
      const result = await sendAgentMailUserDirectMessage(
        userId,
        text,
        logContext,
        idempotencyKey,
        anchor,
      );
      if (result.delivered) {
        return {
          deliveredProviders: ['agentmail'],
          receipts: result.receipt ? [result.receipt] : [],
        };
      }
      continue;
    }
    const receipt =
      provider === 'slack'
        ? await sendSlackUserDirectMessage(
            userId,
            text,
            logContext,
            undefined,
            idempotencyKey,
            anchor,
          )
        : provider === 'teams'
          ? await sendTeamsUserDirectMessage(
              userId,
              teamsText ?? text,
              logContext,
              anchor,
            )
          : provider === 'telegram'
            ? await sendTelegramUserDirectMessage(
                userId,
                text,
                logContext,
                idempotencyKey,
                anchor,
              )
            : await sendDiscordUserDirectMessage(
                userId,
                text,
                logContext,
                idempotencyKey,
                anchor,
              );
    if (receipt) {
      return { deliveredProviders: [receipt.provider], receipts: [receipt] };
    }
  }

  return { deliveredProviders: [], receipts: [] };
}
