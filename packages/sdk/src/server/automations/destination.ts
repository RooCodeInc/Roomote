import {
  and,
  db,
  eq,
  isNotNull,
  resolveDiscordRuntimeCredentials,
  resolveTeamsBotRuntimeCredentials,
  resolveTelegramRuntimeCredentials,
  slackInstallations,
  teamsInstallations,
  type AutomationRuntime,
} from '@roomote/db/server';
import {
  isBackgroundAutomationUserTargetKind,
  type AutomationCapableCommunicationProvider,
} from '@roomote/types';

import { findDiscordDefaultDestination } from '../lib/discord-persistence';
import { findTeamsPrimaryConversation } from '../lib/teams-primary-conversation';
import { findTelegramPrimaryChatId } from '../lib/telegram-primary-chat';
import { findUserDirectMessageDestination } from '../lib/user-direct-message';

/** Fully resolved destination an automation run reports to. */
export type ResolvedAutomationDestination = {
  provider: AutomationCapableCommunicationProvider;
  channelId: string;
  /** Provider workspace/tenant that owns the destination when routing is installation-specific. */
  teamId?: string;
  /** Bot Framework serviceUrl; present for Teams destinations. */
  serviceUrl?: string;
  /** Which waterfall level produced this destination. */
  source: 'automation_target' | 'manager_channel' | 'primary_conversation';
};

/**
 * Connected comms providers in waterfall precedence order. Slack counts when
 * an installation is active; Teams when bot credentials resolve; Telegram
 * and Discord when a bot token resolves.
 */
/**
 * Chat providers that can receive automation output. Email (agentmail) is
 * inbound-initiated and deliberately never listed here.
 */
export async function listConnectedCommunicationProviders(): Promise<
  AutomationCapableCommunicationProvider[]
> {
  const [
    slackInstallation,
    teamsCredentials,
    telegramCredentials,
    discordCredentials,
  ] = await Promise.all([
    db.query.slackInstallations.findFirst({
      columns: { id: true },
      where: eq(slackInstallations.isActive, true),
    }),
    resolveTeamsBotRuntimeCredentials(),
    resolveTelegramRuntimeCredentials(),
    resolveDiscordRuntimeCredentials(),
  ]);

  return [
    ...(slackInstallation ? (['slack'] as const) : []),
    ...(teamsCredentials.botAppId && teamsCredentials.botAppPassword
      ? (['teams'] as const)
      : []),
    ...(telegramCredentials.botToken ? (['telegram'] as const) : []),
    ...(discordCredentials.botToken ? (['discord'] as const) : []),
  ];
}

/**
 * Human-readable name for a Teams destination conversation: the channel name
 * when known, else the team name. Null when the conversation is unknown.
 */
export async function findTeamsConversationDisplayName(
  conversationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({
      channelName: teamsInstallations.channelName,
      teamName: teamsInstallations.teamName,
    })
    .from(teamsInstallations)
    .where(
      and(
        eq(teamsInstallations.conversationId, conversationId),
        eq(teamsInstallations.isActive, true),
      ),
    )
    .limit(1);

  return row?.channelName ?? row?.teamName ?? null;
}

export async function findTeamsConversationServiceUrl(
  conversationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ serviceUrl: teamsInstallations.serviceUrl })
    .from(teamsInstallations)
    .where(
      and(
        eq(teamsInstallations.conversationId, conversationId),
        eq(teamsInstallations.isActive, true),
        isNotNull(teamsInstallations.serviceUrl),
      ),
    )
    .limit(1);

  return row?.serviceUrl ?? null;
}

export async function findTeamsConversationRoute(
  conversationId: string,
  workspaceId?: string,
): Promise<{ serviceUrl: string; workspaceId: string } | null> {
  const [row] = await db
    .select({
      serviceUrl: teamsInstallations.serviceUrl,
      workspaceId: teamsInstallations.tenantId,
    })
    .from(teamsInstallations)
    .where(
      and(
        eq(teamsInstallations.conversationId, conversationId),
        ...(workspaceId ? [eq(teamsInstallations.tenantId, workspaceId)] : []),
        eq(teamsInstallations.isActive, true),
        isNotNull(teamsInstallations.serviceUrl),
      ),
    )
    .limit(1);

  return row?.serviceUrl && row.workspaceId
    ? { serviceUrl: row.serviceUrl, workspaceId: row.workspaceId }
    : null;
}

/**
 * Resolves where an automation run should report, extending the db-level
 * waterfall (own channel or DM target -> manager channel) with a
 * primary-conversation tail
 * for deployments that have no Slack at all: the most recently active Teams
 * conversation, then the configured Telegram primary chat. The tail is
 * deliberately skipped when Slack is connected, so a Slack deployment that
 * simply has not picked a manager channel keeps its explicit
 * "configure a manager channel" nudge instead of surprising another surface.
 */
export async function resolveAutomationRuntimeDestination(params: {
  runtime: Pick<AutomationRuntime, 'destination'> &
    Partial<Pick<AutomationRuntime, 'targets'>>;
  slackConnected: boolean;
  /** Optional user whose DM should receive a one-off fallback report. */
  fallbackUserId?: string | null;
}): Promise<ResolvedAutomationDestination | null> {
  const destination = params.runtime.destination;
  const staleSlackDestination =
    destination?.provider === 'slack' && !params.slackConnected;

  if (destination?.source === 'automation_target') {
    if (!staleSlackDestination) {
      if (destination.provider === 'teams') {
        const serviceUrl = await findTeamsConversationServiceUrl(
          destination.channelId,
        );

        return serviceUrl ? { ...destination, serviceUrl } : null;
      }

      return destination;
    }
  }

  const userTarget = params.runtime.targets?.find(
    (target) =>
      isBackgroundAutomationUserTargetKind(target.targetKind) &&
      (target.provider === 'slack' ||
        target.provider === 'teams' ||
        target.provider === 'telegram' ||
        target.provider === 'discord'),
  );
  if (userTarget) {
    const directMessage = await findUserDirectMessageDestination(
      userTarget.provider as AutomationCapableCommunicationProvider,
      userTarget.externalRef,
    );
    return directMessage
      ? {
          provider:
            userTarget.provider as AutomationCapableCommunicationProvider,
          ...directMessage,
          source: 'automation_target',
        }
      : null;
  }

  if (destination && !staleSlackDestination) {
    return destination;
  }

  if (params.fallbackUserId) {
    const connectedProviders = await listConnectedCommunicationProviders();
    for (const provider of connectedProviders) {
      try {
        const directMessage = await findUserDirectMessageDestination(
          provider,
          params.fallbackUserId,
        );
        if (directMessage) {
          return {
            provider,
            ...directMessage,
            source: 'automation_target',
          };
        }
      } catch (error) {
        console.warn(
          `[automation-destination] Failed to resolve fallback DM on ${provider}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  if (params.slackConnected) {
    return null;
  }

  const teamsConversation = await findTeamsPrimaryConversation();
  if (teamsConversation) {
    return {
      provider: 'teams',
      channelId: teamsConversation.conversationId,
      serviceUrl: teamsConversation.serviceUrl,
      source: 'primary_conversation',
    };
  }

  const telegramChatId = await findTelegramPrimaryChatId();
  if (telegramChatId) {
    return {
      provider: 'telegram',
      channelId: telegramChatId,
      source: 'primary_conversation',
    };
  }

  const discordDestination = await findDiscordDefaultDestination();
  if (discordDestination) {
    return {
      provider: 'discord',
      channelId: discordDestination.channelId,
      source: 'primary_conversation',
    };
  }

  return null;
}

/**
 * Communication payload fields to stamp onto an automation-launched scan
 * task so the surface-generic worker tools (send_chat_reply,
 * post_to_channel) target the destination conversation. Slack destinations
 * stay unstamped because their scan tasks use the same generic tool with
 * Slack channel normalization and membership checks.
 */
export function buildDestinationTaskPayloadFields(
  destination: ResolvedAutomationDestination,
): Record<string, string> {
  if (destination.provider === 'slack') {
    return {};
  }

  return {
    communicationProvider: destination.provider,
    communicationChannelId: destination.channelId,
    ...(destination.serviceUrl
      ? { communicationServiceUrl: destination.serviceUrl }
      : {}),
  };
}

/**
 * Prompt fragments that keep scan-task instructions surface-correct: the
 * channel tag name, the posting tool the agent should call, and a short
 * surface label for prose.
 */
export function buildDestinationPromptContext(
  destination: ResolvedAutomationDestination,
): { channelTag: string; postToolName: string; surfaceLabel: string } {
  if (destination.provider === 'slack') {
    return {
      channelTag: 'slack_channel_id',
      postToolName: 'post_to_channel',
      surfaceLabel: 'Slack',
    };
  }

  return {
    channelTag: 'channel_id',
    postToolName: 'post_to_channel',
    surfaceLabel:
      destination.provider === 'teams'
        ? 'Teams'
        : destination.provider === 'discord'
          ? 'Discord'
          : 'Telegram',
  };
}
