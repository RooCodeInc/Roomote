import {
  and,
  db,
  eq,
  isNotNull,
  resolveTeamsBotRuntimeCredentials,
  resolveTelegramRuntimeCredentials,
  slackInstallations,
  teamsInstallations,
  type AutomationRuntime,
} from '@roomote/db/server';
import type { CommunicationProvider } from '@roomote/types';

import { findTeamsPrimaryConversation } from '../lib/teams-primary-conversation';
import { findTelegramPrimaryChatId } from '../lib/telegram-primary-chat';

/** Fully resolved destination an automation run reports to. */
export type ResolvedAutomationDestination = {
  provider: CommunicationProvider;
  channelId: string;
  /** Bot Framework serviceUrl; present for Teams destinations. */
  serviceUrl?: string;
  /** Which waterfall level produced this destination. */
  source: 'automation_target' | 'manager_channel' | 'primary_conversation';
};

/**
 * Connected comms providers in waterfall precedence order. Slack counts when
 * an installation is active; Teams when bot credentials resolve; Telegram
 * when a bot token resolves.
 */
export async function listConnectedCommunicationProviders(): Promise<
  CommunicationProvider[]
> {
  const [slackInstallation, teamsCredentials, telegramCredentials] =
    await Promise.all([
      db.query.slackInstallations.findFirst({
        columns: { id: true },
        where: eq(slackInstallations.isActive, true),
      }),
      resolveTeamsBotRuntimeCredentials(),
      resolveTelegramRuntimeCredentials(),
    ]);

  return [
    ...(slackInstallation ? (['slack'] as const) : []),
    ...(teamsCredentials.botAppId && teamsCredentials.botAppPassword
      ? (['teams'] as const)
      : []),
    ...(telegramCredentials.botToken ? (['telegram'] as const) : []),
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

async function findTeamsConversationServiceUrl(
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

/**
 * Resolves where an automation run should report, extending the db-level
 * waterfall (own target -> Slack manager channel) with a primary-conversation
 * tail for deployments that have no Slack at all: the most recently active
 * Teams conversation, then the configured Telegram primary chat. The tail is
 * deliberately skipped when Slack is connected, so a Slack deployment that
 * simply has not picked a manager channel keeps its explicit
 * "configure a manager channel" nudge instead of surprising another surface.
 */
export async function resolveAutomationRuntimeDestination(params: {
  runtime: Pick<AutomationRuntime, 'destination'>;
  slackConnected: boolean;
}): Promise<ResolvedAutomationDestination | null> {
  const destination = params.runtime.destination;

  if (destination) {
    const staleSlackDestination =
      destination.provider === 'slack' && !params.slackConnected;

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

  return null;
}

/**
 * Communication payload fields to stamp onto an automation-launched scan
 * task so the surface-generic worker tools (send_chat_reply,
 * post_to_channel) target the destination conversation. Slack destinations
 * stay unstamped: their scan tasks keep the arbitrary-channel
 * post_to_slack_channel flow unchanged.
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
      postToolName: 'post_to_slack_channel',
      surfaceLabel: 'Slack',
    };
  }

  return {
    channelTag: 'channel_id',
    postToolName: 'post_to_channel',
    surfaceLabel: destination.provider === 'teams' ? 'Teams' : 'Telegram',
  };
}
