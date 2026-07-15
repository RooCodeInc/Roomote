import { TelegramCommunicationProvider } from '@roomote/communication/telegram-provider';
import { resolveTelegramRuntimeCredentials } from '@roomote/db/server';

type TelegramCommunicationProviderRuntimeOptions = {
  /** Custom fetch, e.g. a base-URL-rewriting fetch for webhook admin calls. */
  fetch?: typeof fetch;
};

/**
 * Builds a `TelegramCommunicationProvider` from the resolved runtime
 * credentials (env vars, or values saved from the comms settings UI), or
 * `null` when no bot token is configured.
 */
export async function createTelegramCommunicationProviderFromRuntimeCredentials(
  options?: TelegramCommunicationProviderRuntimeOptions,
): Promise<TelegramCommunicationProvider | null> {
  const { botToken } = await resolveTelegramRuntimeCredentials();

  if (!botToken) {
    return null;
  }

  return new TelegramCommunicationProvider({
    botToken,
    ...(options?.fetch ? { fetch: options.fetch } : {}),
  });
}
