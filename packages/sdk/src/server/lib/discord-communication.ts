import { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import { resolveDiscordRuntimeCredentials } from '@roomote/db/server';

type DiscordCommunicationProviderRuntimeOptions = {
  /** Custom fetch, e.g. a base-URL-rewriting fetch for mock-server testing. */
  fetch?: typeof fetch;
};

/**
 * Builds a `DiscordCommunicationProvider` from the resolved runtime
 * credentials (env vars, or values saved from the comms settings UI), or
 * `null` when no bot token is configured.
 */
export async function createDiscordCommunicationProviderFromRuntimeCredentials(
  options?: DiscordCommunicationProviderRuntimeOptions,
): Promise<DiscordCommunicationProvider | null> {
  const { botToken, applicationId } = await resolveDiscordRuntimeCredentials();

  if (!botToken) {
    return null;
  }

  return new DiscordCommunicationProvider({
    botToken,
    ...(applicationId ? { applicationId } : {}),
    ...(options?.fetch ? { fetch: options.fetch } : {}),
  });
}
