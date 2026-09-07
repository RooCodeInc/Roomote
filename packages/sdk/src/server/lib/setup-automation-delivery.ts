import {
  and,
  db,
  deploymentSettings,
  eq,
  resolveTeamsBotRuntimeCredentials,
  resolveDiscordRuntimeCredentials,
  slackInstallationChannels,
  slackInstallations,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import { SlackNotifier } from '@roomote/slack';
import {
  getCommunicationAutomationTargetKind,
  hasSetupChatHandoffDestination,
  normalizeSetupNewState,
  type AutomationTarget,
  type CommunicationProvider,
} from '@roomote/types';

import { findTeamsConversationRoute } from '../automations/destination';
import { findDiscordDestinationByChannelId } from './discord-persistence';

/**
 * Resolves only explicitly configured or persisted setup report destinations.
 * Settings and Slack reads use client; existing Discord/Teams helpers use db.
 * This does not create DMs, join channels, or select a primary conversation.
 */
export async function resolveSetupAutomationReportTarget(
  client: DatabaseOrTransaction = db,
): Promise<(AutomationTarget & { provider: CommunicationProvider }) | null> {
  try {
    const settings = await client.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
      columns: {
        managerSlackChannelId: true,
        managerDiscordChannelId: true,
        setupNewState: true,
      },
    });
    if (!settings) return null;

    const state = normalizeSetupNewState(settings.setupNewState);
    const candidates: Array<{
      provider: CommunicationProvider;
      channelId: string;
      slackTeamId?: string;
    }> = [];
    if (settings.managerSlackChannelId?.trim()) {
      candidates.push({
        provider: 'slack',
        channelId: settings.managerSlackChannelId.trim(),
      });
    }
    if (settings.managerDiscordChannelId?.trim()) {
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
      if (channelId && (provider !== 'slack' || state.slackTeamId?.trim())) {
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
      const target: AutomationTarget & { provider: CommunicationProvider } = {
        provider,
        targetKind: getCommunicationAutomationTargetKind(provider, 'channel'),
        externalRef: channelId,
      };
      switch (provider) {
        case 'slack': {
          // Setup historically opened a user DM. Do not turn it into a channel target.
          if (!/^[CG][A-Z0-9]+$/.test(channelId)) break;
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
          // An unscoped channel id must have exactly one active owner.
          const installation =
            installations.length === 1 ? installations[0] : null;
          if (
            installation?.botAccessToken &&
            installation.teamId &&
            (await new SlackNotifier(
              installation.botAccessToken,
            ).isAppInChannel(channelId)) === true
          )
            return {
              ...target,
              metadata: { slackTeamId: installation.teamId },
            };
          break;
        }
        case 'discord':
          if (
            (await resolveDiscordRuntimeCredentials()).botToken &&
            (await findDiscordDestinationByChannelId(channelId))
          )
            return target;
          break;
        case 'teams': {
          const credentials = await resolveTeamsBotRuntimeCredentials();
          if (!credentials.botAppId || !credentials.botAppPassword) break;
          const route = await findTeamsConversationRoute(channelId);
          if (route?.serviceUrl.trim()) {
            return { ...target, metadata: { serviceUrl: route.serviceUrl } };
          }
          break;
        }
        case 'telegram':
          // Primary-chat/user mappings have no active installation or bot binding.
          // A token and a historical chat id alone cannot authorize this route.
          break;
      }
    }
    return null;
  } catch {
    // Validation failures must not expose credentials or invent a destination.
    return null;
  }
}
