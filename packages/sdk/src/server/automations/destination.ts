import {
  and,
  db,
  eq,
  findActiveSlackInstallationForChannel,
  isNotNull,
  resolveDiscordRuntimeCredentials,
  resolveTeamsBotRuntimeCredentials,
  resolveTelegramRuntimeCredentials,
  slackInstallations,
  teamsInstallations,
  type AutomationRuntime,
} from '@roomote/db/server';
import {
  getAutomationTargetEmailIdentityId,
  isAutomationDestinationTarget,
  isBackgroundAutomationUserTargetKind,
  type AutomationCapableCommunicationProvider,
  type AutomationDestinationProvider,
  type CommunicationProvider,
  type AutomationTarget,
} from '@roomote/types';

import { findDiscordDefaultDestination } from '../lib/discord-persistence';
import { findTeamsPrimaryConversation } from '../lib/teams-primary-conversation';
import { findTelegramPrimaryChatId } from '../lib/telegram-primary-chat';
import { findUserDirectMessageDestination } from '../lib/user-direct-message';
import {
  canStartAgentMailConversationWithUser,
  prepareAgentMailConversation,
} from '../lib/agentmail/outbound';
import { createAgentMailCommunicationProviderFromRuntimeCredentials } from '../lib/agentmail-communication';

/** Fully resolved destination an automation run reports to. */
export type ResolvedAutomationDestination = {
  provider: AutomationDestinationProvider;
  channelId: string;
  /** Provider workspace/tenant that owns the destination when routing is installation-specific. */
  teamId?: string;
  /** Bot Framework serviceUrl; present for Teams destinations. */
  serviceUrl?: string;
  /** Exact Email recipient and identity, present only for Email destinations. */
  userId?: string;
  identityId?: string;
  /** Prepared internal AgentMail conversation for one report run. */
  threadId?: string;
  /** Which waterfall level produced this destination. */
  source: 'automation_target' | 'manager_channel' | 'primary_conversation';
};

export function getAutomationDestinationCommunicationProvider(
  destination: Pick<ResolvedAutomationDestination, 'provider'>,
): CommunicationProvider {
  return destination.provider === 'email' ? 'agentmail' : destination.provider;
}

/**
 * The Email target an automation run reports to. The deployment default only
 * applies when the automation has no explicit destination of its own, so an
 * Email default never pulls an explicitly targeted automation off its channel.
 */
export function getAutomationEmailTarget(
  runtime: Partial<
    Pick<AutomationRuntime, 'targets' | 'defaultAutomationTarget'>
  >,
): AutomationTarget | null {
  const explicitTargets = (runtime.targets ?? []).filter(
    isAutomationDestinationTarget,
  );
  const explicitEmailTarget = explicitTargets.find(
    (target) => target.provider === 'email',
  );
  if (explicitEmailTarget) return explicitEmailTarget;
  return explicitTargets.length === 0 &&
    runtime.defaultAutomationTarget?.provider === 'email'
    ? runtime.defaultAutomationTarget
    : null;
}

export function hasAutomationEmailTarget(
  runtime: Partial<
    Pick<AutomationRuntime, 'targets' | 'defaultAutomationTarget'>
  >,
): boolean {
  return getAutomationEmailTarget(runtime) !== null;
}

export async function resolveAutomationEmailTarget(
  target: AutomationTarget,
): Promise<ResolvedAutomationDestination | null> {
  const identityId = getAutomationTargetEmailIdentityId(target);
  return target.provider === 'email' &&
    target.targetKind === 'email_user' &&
    identityId &&
    (await canStartAgentMailConversationWithUser(
      target.externalRef,
      identityId,
    ))
    ? {
        provider: 'email',
        channelId: target.externalRef,
        userId: target.externalRef,
        identityId,
        source: 'automation_target',
      }
    : null;
}

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
    Partial<Pick<AutomationRuntime, 'targets' | 'defaultAutomationTarget'>>;
  slackConnected: boolean;
  /** Optional user whose DM should receive a one-off fallback report. */
  fallbackUserId?: string | null;
}): Promise<ResolvedAutomationDestination | null> {
  const emailTarget = params.runtime.targets?.find(
    (target) =>
      target.provider === 'email' && target.targetKind === 'email_user',
  );
  if (emailTarget) {
    return resolveRuntimeTarget(
      emailTarget,
      'automation_target',
      params.slackConnected,
    );
  }
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
    return resolveRuntimeTarget(
      userTarget,
      'automation_target',
      params.slackConnected,
    );
  }

  const defaultTarget = params.runtime.defaultAutomationTarget;
  if (defaultTarget) {
    const resolvedDefault = await resolveRuntimeTarget(
      defaultTarget,
      'manager_channel',
      params.slackConnected,
    );
    if (resolvedDefault) return resolvedDefault;
  }

  if (destination && !staleSlackDestination) {
    if (destination.provider === 'slack') {
      const installation = await findActiveSlackInstallationForChannel(
        destination.channelId,
      );
      return installation
        ? { ...destination, teamId: installation.teamId }
        : null;
    }
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

/** Resolves one concrete target, explicit or deployment default, for a run. */
async function resolveRuntimeTarget(
  target: AutomationTarget,
  source: ResolvedAutomationDestination['source'],
  slackConnected: boolean,
): Promise<ResolvedAutomationDestination | null> {
  if (target.provider === 'email') {
    const destination = await resolveAutomationEmailTarget(target);
    return destination ? { ...destination, source } : null;
  }
  const provider = target.provider as AutomationCapableCommunicationProvider;
  if (isBackgroundAutomationUserTargetKind(target.targetKind)) {
    const directMessage = await findUserDirectMessageDestination(
      provider,
      target.externalRef,
    );
    return directMessage ? { provider, ...directMessage, source } : null;
  }
  if (provider === 'slack') {
    if (!slackConnected) return null;
    const installation = await findActiveSlackInstallationForChannel(
      target.externalRef,
    );
    return installation
      ? {
          provider,
          channelId: target.externalRef,
          teamId: installation.teamId,
          source,
        }
      : null;
  }
  if (provider === 'teams') {
    const serviceUrl = await findTeamsConversationServiceUrl(
      target.externalRef,
    );
    return serviceUrl
      ? { provider, channelId: target.externalRef, serviceUrl, source }
      : null;
  }
  return { provider, channelId: target.externalRef, source };
}

/**
 * Communication payload fields to stamp onto an automation-launched scan
 * task so the surface-generic worker tools (send_chat_reply,
 * send_chat_message) target the destination conversation. Slack destinations
 * carry their selected workspace while retaining Slack channel normalization
 * and membership checks.
 */
export function buildDestinationTaskPayloadFields(
  destination: ResolvedAutomationDestination,
): Record<string, string> {
  if (destination.provider === 'email') {
    if (!destination.threadId) {
      throw new Error('Email destination conversation is not prepared.');
    }
    return {
      communicationProvider: 'agentmail',
      communicationChannelId: destination.channelId,
      communicationThreadId: destination.threadId,
    };
  }
  if (destination.provider === 'slack') {
    return {
      communicationProvider: 'slack',
      communicationChannelId: destination.channelId,
      ...(destination.teamId ? { teamId: destination.teamId } : {}),
    };
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
): {
  channelTag: string;
  destinationRef: string;
  postToolName: string;
  surfaceLabel: string;
} {
  if (destination.provider === 'slack') {
    return {
      channelTag: 'chat_destination',
      destinationRef: 'slack:current',
      postToolName: 'send_chat_message',
      surfaceLabel: 'Slack',
    };
  }

  if (destination.provider === 'email') {
    return {
      channelTag: 'channel_id',
      destinationRef: destination.channelId,
      postToolName: 'send_chat_reply',
      surfaceLabel: 'Email',
    };
  }

  return {
    channelTag: 'chat_destination',
    destinationRef: `${destination.provider}:current`,
    postToolName: 'send_chat_message',
    surfaceLabel:
      destination.provider === 'teams'
        ? 'Teams'
        : destination.provider === 'discord'
          ? 'Discord'
          : 'Telegram',
  };
}

/** Prepare one durable, replyable Email thread for a built-in automation run. */
export async function prepareAutomationReportDestination(
  destination: ResolvedAutomationDestination,
  input: {
    subject: string;
    conversationKey: string;
  },
): Promise<ResolvedAutomationDestination> {
  if (destination.provider !== 'email') return destination;
  if (!destination.userId || !destination.identityId) {
    throw new Error('Email destination routing is incomplete.');
  }
  const prepared = await prepareAgentMailConversation({
    userId: destination.userId,
    identityId: destination.identityId,
    subject: input.subject,
    conversationKey: input.conversationKey,
  });
  if (!prepared) {
    throw new Error('Email destination is no longer available.');
  }
  return {
    ...destination,
    channelId: prepared.inboxId,
    threadId: prepared.conversationId,
  };
}

/** Send a built-in automation report into a fresh durable Email conversation. */
export async function sendAutomationEmailReport(
  destination: ResolvedAutomationDestination,
  input: {
    subject: string;
    conversationKey: string;
    text: string;
    idempotencyKey: string;
    buttons?: Array<Array<{ text: string; url: string }>>;
  },
): Promise<void> {
  const prepared = await prepareAutomationReportDestination(destination, input);
  if (prepared.provider !== 'email' || !prepared.threadId) {
    throw new Error('Expected a prepared Email destination.');
  }
  const adapter =
    await createAgentMailCommunicationProviderFromRuntimeCredentials();
  if (!adapter) throw new Error('Email is not connected.');
  await adapter.postMessage({
    channelId: prepared.channelId,
    threadId: prepared.threadId,
    text: input.text,
    textFormat: 'markdown',
    idempotencyKey: input.idempotencyKey,
    ...(input.buttons ? { buttons: input.buttons } : {}),
  });
}
