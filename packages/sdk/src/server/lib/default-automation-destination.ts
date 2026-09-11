import {
  and,
  db,
  deploymentSettings,
  eq,
  resolveDiscordRuntimeCredentials,
  resolveTeamsBotRuntimeCredentials,
  resolveTelegramRuntimeCredentials,
  slackInstallationChannels,
  slackInstallations,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import { SlackNotifier } from '@roomote/slack';
import {
  AUTOMATION_TARGET_EMAIL_IDENTITY_KEY,
  getAutomationTargetKind,
  hasSetupChatHandoffDestination,
  isConfiguredAutomationTarget,
  normalizeSetupNewState,
  type AutomationCapableCommunicationProvider,
  type AutomationTarget,
  type OptionalAutomationTarget,
} from '@roomote/types';

import {
  findTeamsConversationRoute,
  listConnectedCommunicationProviders,
} from '../automations/destination';
import { listAvailableAgentMailOutboundIdentities } from './agentmail/outbound';
import {
  findDiscordDefaultDestination,
  findDiscordDestinationByChannelId,
} from './discord-persistence';
import { findTeamsPrimaryConversation } from './teams-primary-conversation';
import { findTelegramPrimaryChatId } from './telegram-primary-chat';
import { findUserDirectMessageDestination } from './user-direct-message';

export type AutomationDestinationCapabilities = {
  chatProviders: readonly AutomationCapableCommunicationProvider[];
  email: boolean;
};

export const CUSTOM_AUTOMATION_DESTINATION_CAPABILITIES = {
  chatProviders: ['slack', 'teams', 'telegram', 'discord'],
  email: true,
} as const satisfies AutomationDestinationCapabilities;

type DefaultAutomationTargetParams = {
  ownerUserId: string;
  capabilities: AutomationDestinationCapabilities;
  existingTarget?: OptionalAutomationTarget | null;
  includeSharedChannels?: boolean;
  includeSetupHandoff?: boolean;
  client?: DatabaseOrTransaction;
};

/**
 * Selects a persisted default report target without replacing an existing
 * explicit target. Defaults follow one shared waterfall: usable configured
 * channels, a resolvable owner DM, supported Email, then no destination.
 */
export async function resolveDefaultAutomationTarget({
  ownerUserId,
  capabilities,
  existingTarget,
  includeSharedChannels = true,
  includeSetupHandoff = false,
  client = db,
}: DefaultAutomationTargetParams): Promise<AutomationTarget | null> {
  if (isConfiguredAutomationTarget(existingTarget)) {
    const supported =
      existingTarget.provider === 'email'
        ? capabilities.email
        : capabilities.chatProviders.includes(
            existingTarget.provider as AutomationCapableCommunicationProvider,
          );
    return supported ? existingTarget : null;
  }

  const settings = includeSharedChannels
    ? await client.query.deploymentSettings
        .findFirst({
          where: eq(deploymentSettings.id, 'default'),
          columns: {
            managerSlackChannelId: true,
            managerDiscordChannelId: true,
            setupNewState: true,
          },
        })
        .catch(() => null)
    : null;

  const channelCandidates: AutomationTarget[] = [];
  if (settings?.managerSlackChannelId?.trim()) {
    channelCandidates.push({
      provider: 'slack',
      targetKind: 'slack_channel',
      externalRef: settings.managerSlackChannelId.trim(),
    });
  }
  if (settings?.managerDiscordChannelId?.trim()) {
    channelCandidates.push({
      provider: 'discord',
      targetKind: 'discord_channel',
      externalRef: settings.managerDiscordChannelId.trim(),
    });
  }

  if (includeSetupHandoff) {
    const state = normalizeSetupNewState(settings?.setupNewState ?? {});
    if (hasSetupChatHandoffDestination(state)) {
      const provider = state.chatHandoffProvider ?? 'slack';
      const channelId = (
        state.chatHandoffProvider
          ? state.chatHandoffChannelId
          : state.slackChannel
      )?.trim();
      if (
        provider !== 'agentmail' &&
        channelId &&
        (provider !== 'slack' || state.slackTeamId?.trim())
      ) {
        channelCandidates.push({
          provider,
          targetKind: getAutomationTargetKind(provider, 'channel'),
          externalRef: channelId,
          ...(provider === 'slack'
            ? { metadata: { slackTeamId: state.slackTeamId!.trim() } }
            : {}),
        });
      }
    }
  }

  // These persisted primary conversations are channel-level defaults, so they
  // precede owner DMs just like an explicitly configured manager channel.
  if (includeSharedChannels && capabilities.chatProviders.includes('teams')) {
    try {
      const primary = await findTeamsPrimaryConversation();
      if (primary) {
        channelCandidates.push({
          provider: 'teams',
          targetKind: 'teams_channel',
          externalRef: primary.conversationId,
        });
      }
    } catch {
      // Continue to the next configured channel convention.
    }
  }
  if (
    includeSharedChannels &&
    capabilities.chatProviders.includes('telegram')
  ) {
    try {
      const chatId = await findTelegramPrimaryChatId();
      if (chatId) {
        channelCandidates.push({
          provider: 'telegram',
          targetKind: 'telegram_chat',
          externalRef: chatId,
        });
      }
    } catch {
      // Continue to the next configured channel convention.
    }
  }
  if (includeSharedChannels && capabilities.chatProviders.includes('discord')) {
    try {
      const primary = await findDiscordDefaultDestination();
      if (primary) {
        channelCandidates.push({
          provider: 'discord',
          targetKind: 'discord_channel',
          externalRef: primary.channelId,
        });
      }
    } catch {
      // Continue to owner DMs when no primary channel is usable.
    }
  }

  for (const candidate of channelCandidates) {
    if (
      !capabilities.chatProviders.includes(
        candidate.provider as AutomationCapableCommunicationProvider,
      )
    ) {
      continue;
    }
    const resolved = await resolveUsableChannelTarget(candidate, client);
    if (resolved) return resolved;
  }

  const connectedProviders: AutomationCapableCommunicationProvider[] =
    await listConnectedCommunicationProviders().catch(() => []);
  for (const provider of capabilities.chatProviders) {
    if (!connectedProviders.includes(provider)) continue;
    try {
      if (await findUserDirectMessageDestination(provider, ownerUserId)) {
        return {
          provider,
          targetKind: getAutomationTargetKind(provider, 'direct_message'),
          externalRef: ownerUserId,
        };
      }
    } catch {
      // A stale provider link must not block later providers or Email.
    }
  }

  if (!capabilities.email) return null;
  try {
    const [identity] =
      await listAvailableAgentMailOutboundIdentities(ownerUserId);
    return identity
      ? {
          provider: 'email',
          targetKind: 'email_user',
          externalRef: ownerUserId,
          metadata: { [AUTOMATION_TARGET_EMAIL_IDENTITY_KEY]: identity.id },
        }
      : null;
  } catch {
    return null;
  }
}

async function resolveUsableChannelTarget(
  target: AutomationTarget,
  client: DatabaseOrTransaction,
): Promise<AutomationTarget | null> {
  try {
    if (target.provider === 'slack') {
      const teamId =
        typeof target.metadata?.slackTeamId === 'string'
          ? target.metadata.slackTeamId
          : null;
      if (!/^[CG][A-Z0-9]{8,}$/i.test(target.externalRef)) return null;
      const installations = await client
        .select({
          botAccessToken: slackInstallations.botAccessToken,
          teamId: slackInstallations.teamId,
        })
        .from(slackInstallations)
        .innerJoin(
          slackInstallationChannels,
          and(
            eq(
              slackInstallationChannels.slackInstallationId,
              slackInstallations.id,
            ),
            eq(slackInstallationChannels.channelId, target.externalRef),
          ),
        )
        .where(
          and(
            eq(slackInstallations.isActive, true),
            ...(teamId ? [eq(slackInstallations.teamId, teamId)] : []),
          ),
        )
        .limit(2);
      const installation = installations.length === 1 ? installations[0] : null;
      if (
        installation?.botAccessToken &&
        installation.teamId &&
        (await new SlackNotifier(installation.botAccessToken).isAppInChannel(
          target.externalRef,
        )) === true
      ) {
        return {
          ...target,
          metadata: { ...target.metadata, slackTeamId: installation.teamId },
        };
      }
      return null;
    }

    if (target.provider === 'discord') {
      return (await resolveDiscordRuntimeCredentials()).botToken &&
        (await findDiscordDestinationByChannelId(target.externalRef))
        ? target
        : null;
    }

    if (target.provider === 'teams') {
      const credentials = await resolveTeamsBotRuntimeCredentials();
      if (!credentials.botAppId || !credentials.botAppPassword) return null;
      const route = await findTeamsConversationRoute(target.externalRef);
      return route?.serviceUrl.trim()
        ? { ...target, metadata: { serviceUrl: route.serviceUrl } }
        : null;
    }

    if (target.provider === 'telegram') {
      return (await resolveTelegramRuntimeCredentials()).botToken
        ? target
        : null;
    }
  } catch {
    // Continue the waterfall when a configured candidate is stale.
  }
  return null;
}
