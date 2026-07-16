import { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import { resolveDiscordRuntimeCredentials } from '@roomote/db/server';

type ResolvedDiscordProvider = {
  applicationId: string;
  botToken: string;
  botUserId: string;
  provider: DiscordCommunicationProvider;
};

export class DiscordProviderNotConfiguredError extends Error {
  constructor() {
    super(
      'Discord bot credentials are not configured or could not be validated.',
    );
    this.name = 'DiscordProviderNotConfiguredError';
  }
}

export async function resolveDiscordProvider(): Promise<ResolvedDiscordProvider> {
  const credentials = await resolveDiscordRuntimeCredentials();
  if (
    !credentials.botToken ||
    !credentials.applicationId ||
    !credentials.botUserId
  ) {
    throw new DiscordProviderNotConfiguredError();
  }
  return {
    applicationId: credentials.applicationId,
    botToken: credentials.botToken,
    botUserId: credentials.botUserId,
    provider: new DiscordCommunicationProvider({
      botToken: credentials.botToken,
      applicationId: credentials.applicationId,
    }),
  };
}
