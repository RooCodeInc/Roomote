import {
  and,
  db,
  deploymentSettings,
  eq,
  resolveDiscordRuntimeCredentials,
  resolveTeamsBotRuntimeCredentials,
  slackInstallationChannels,
  slackInstallations,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import { SlackNotifier } from '@roomote/slack';
import {
  AUTOMATION_TARGET_EMAIL_IDENTITY_KEY,
  getAutomationTargetKind,
  hasSetupChatHandoffDestination,
  normalizeSetupNewState,
  type AutomationTarget,
} from '@roomote/types';

import {
  findTeamsConversationRoute,
  listConnectedCommunicationProviders,
} from '../automations/destination';
import { listAvailableAgentMailOutboundIdentities } from './agentmail/outbound';
import { findDiscordDestinationByChannelId } from './discord-persistence';
import { findUserDirectMessageDestination } from './user-direct-message';

/** Resolve an existing setup chat destination before falling back to Email. */
export async function resolveSetupAutomationReportTarget(
  ownerUserId: string,
  client: DatabaseOrTransaction = db,
): Promise<AutomationTarget | null> {
  let settings;
  try {
    settings = await client.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
      columns: {
        managerSlackChannelId: true,
        managerDiscordChannelId: true,
        setupNewState: true,
      },
    });
  } catch {
    return null;
  }

  const state = normalizeSetupNewState(settings?.setupNewState ?? {});
  const candidates: Array<{
    provider: 'slack' | 'discord' | 'teams' | 'telegram';
    channelId: string;
    slackTeamId?: string;
  }> = [];
  if (settings?.managerSlackChannelId?.trim()) {
    candidates.push({
      provider: 'slack',
      channelId: settings.managerSlackChannelId.trim(),
    });
  }
  if (settings?.managerDiscordChannelId?.trim()) {
    candidates.push({
      provider: 'discord',
      channelId: settings.managerDiscordChannelId.trim(),
    });
  }
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
      candidates.push({
        provider,
        channelId,
        ...(provider === 'slack'
          ? { slackTeamId: state.slackTeamId!.trim() }
          : {}),
      });
    }
  }

  for (const { provider, channelId, slackTeamId } of candidates) {
    const target: AutomationTarget = {
      provider,
      targetKind: getAutomationTargetKind(provider, 'channel'),
      externalRef: channelId,
    };
    try {
      if (provider === 'slack') {
        if (!/^[CG][A-Z0-9]+$/.test(channelId)) continue;
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
              eq(slackInstallationChannels.channelId, channelId),
            ),
          )
          .where(
            and(
              eq(slackInstallations.isActive, true),
              ...(slackTeamId
                ? [eq(slackInstallations.teamId, slackTeamId)]
                : []),
            ),
          )
          .limit(2);
        const installation =
          installations.length === 1 ? installations[0] : null;
        if (
          installation?.botAccessToken &&
          installation.teamId &&
          (await new SlackNotifier(installation.botAccessToken).isAppInChannel(
            channelId,
          )) === true
        ) {
          return {
            ...target,
            metadata: { slackTeamId: installation.teamId },
          };
        }
        continue;
      }
      if (provider === 'discord') {
        if (
          (await resolveDiscordRuntimeCredentials()).botToken &&
          (await findDiscordDestinationByChannelId(channelId))
        ) {
          return target;
        }
        continue;
      }
      if (provider === 'teams') {
        const credentials = await resolveTeamsBotRuntimeCredentials();
        if (!credentials.botAppId || !credentials.botAppPassword) continue;
        const route = await findTeamsConversationRoute(channelId);
        if (route?.serviceUrl.trim()) {
          return { ...target, metadata: { serviceUrl: route.serviceUrl } };
        }
      }
      // A Telegram chat id alone is not evidence of an active bot-bound route.
    } catch {
      // A stale chat candidate must not prevent trying another route or Email.
    }
  }

  try {
    const providers = await listConnectedCommunicationProviders();
    for (const provider of providers) {
      try {
        if (await findUserDirectMessageDestination(provider, ownerUserId)) {
          return {
            provider,
            targetKind: getAutomationTargetKind(provider, 'direct_message'),
            externalRef: ownerUserId,
          };
        }
      } catch {
        // Continue through the connected chat providers before trying Email.
      }
    }
  } catch {
    // Provider discovery failure still permits the independently validated fallback.
  }

  try {
    const [identity] =
      await listAvailableAgentMailOutboundIdentities(ownerUserId);
    return identity
      ? {
          provider: 'email',
          targetKind: getAutomationTargetKind('email', 'direct_message'),
          externalRef: ownerUserId,
          metadata: { [AUTOMATION_TARGET_EMAIL_IDENTITY_KEY]: identity.id },
        }
      : null;
  } catch {
    return null;
  }
}
