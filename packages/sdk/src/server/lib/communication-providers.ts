import type {
  AgentMailCommunicationProvider,
  CommunicationProviderAdapter,
  DiscordCommunicationProvider,
  TeamsCommunicationProvider,
  TelegramCommunicationProvider,
} from '@roomote/communication';
import { and, db, eq, slackInstallations } from '@roomote/db/server';
import { SlackCommunicationProvider, SlackNotifier } from '@roomote/slack';
import type { CommunicationProvider } from '@roomote/types';

import { createAgentMailCommunicationProviderFromRuntimeCredentials } from './agentmail-communication';
import { createDiscordCommunicationProviderFromRuntimeCredentials } from './discord-communication';
import { createTeamsCommunicationProviderFromRuntimeCredentials } from './teams-communication';
import { createTelegramCommunicationProviderFromRuntimeCredentials } from './telegram-communication';

export type RuntimeCommunicationProviderAdapter = CommunicationProviderAdapter &
  (
    | SlackCommunicationProvider
    | TeamsCommunicationProvider
    | TelegramCommunicationProvider
    | DiscordCommunicationProvider
    | AgentMailCommunicationProvider
  );

/**
 * Builds a `SlackCommunicationProvider` from the deployment's active Slack
 * installation, or `null` when Slack is not connected.
 */
async function createSlackCommunicationProviderFromInstallation(
  slackTeamId?: string | null,
): Promise<SlackCommunicationProvider | null> {
  const installation = await db.query.slackInstallations.findFirst({
    where: slackTeamId
      ? and(
          eq(slackInstallations.isActive, true),
          eq(slackInstallations.teamId, slackTeamId),
        )
      : eq(slackInstallations.isActive, true),
    columns: { botAccessToken: true, teamId: true },
  });

  if (!installation?.botAccessToken) {
    return null;
  }

  return new SlackCommunicationProvider(
    new SlackNotifier(installation.botAccessToken),
    installation.teamId,
  );
}

/**
 * Resolves the outbound communication adapter for a provider from the
 * deployment's runtime credentials, or `null` when that provider is not
 * connected.
 */
export async function getCommunicationProviderAdapter(
  provider: CommunicationProvider,
  options: { slackTeamId?: string | null } = {},
): Promise<RuntimeCommunicationProviderAdapter | null> {
  switch (provider) {
    case 'slack':
      return createSlackCommunicationProviderFromInstallation(
        options.slackTeamId,
      );
    case 'teams':
      return createTeamsCommunicationProviderFromRuntimeCredentials();
    case 'telegram':
      return createTelegramCommunicationProviderFromRuntimeCredentials();
    case 'discord':
      return createDiscordCommunicationProviderFromRuntimeCredentials();
    case 'agentmail':
      return createAgentMailCommunicationProviderFromRuntimeCredentials();
  }
}
