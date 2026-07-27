import type {
  CommunicationProviderAdapter,
  DiscordCommunicationProvider,
  TeamsCommunicationProvider,
  TelegramCommunicationProvider,
} from '@roomote/communication';
import { db, eq, slackInstallations } from '@roomote/db/server';
import { SlackCommunicationProvider, SlackNotifier } from '@roomote/slack';
import type { CommunicationProvider } from '@roomote/types';

import { createDiscordCommunicationProviderFromRuntimeCredentials } from './discord-communication';
import { createTeamsCommunicationProviderFromRuntimeCredentials } from './teams-communication';
import { createTelegramCommunicationProviderFromRuntimeCredentials } from './telegram-communication';

export type RuntimeCommunicationProviderAdapter = CommunicationProviderAdapter &
  (
    | SlackCommunicationProvider
    | TeamsCommunicationProvider
    | TelegramCommunicationProvider
    | DiscordCommunicationProvider
  );

/**
 * Builds a `SlackCommunicationProvider` from the deployment's active Slack
 * installation, or `null` when Slack is not connected.
 */
async function createSlackCommunicationProviderFromInstallation(): Promise<SlackCommunicationProvider | null> {
  const installation = await db.query.slackInstallations.findFirst({
    where: eq(slackInstallations.isActive, true),
    columns: { botAccessToken: true },
  });

  if (!installation?.botAccessToken) {
    return null;
  }

  return new SlackCommunicationProvider(
    new SlackNotifier(installation.botAccessToken),
  );
}

/**
 * Resolves the outbound communication adapter for a provider from the
 * deployment's runtime credentials, or `null` when that provider is not
 * connected.
 */
export async function getCommunicationProviderAdapter(
  provider: CommunicationProvider,
): Promise<RuntimeCommunicationProviderAdapter | null> {
  switch (provider) {
    case 'slack':
      return createSlackCommunicationProviderFromInstallation();
    case 'teams':
      return createTeamsCommunicationProviderFromRuntimeCredentials();
    case 'telegram':
      return createTelegramCommunicationProviderFromRuntimeCredentials();
    case 'discord':
      return createDiscordCommunicationProviderFromRuntimeCredentials();
  }
}
