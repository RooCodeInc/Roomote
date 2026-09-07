import { TelegramCommunicationProvider } from '@roomote/communication/telegram-provider';
import {
  db,
  eq,
  fastAgentConversations,
  resolveTelegramManagedBotCredentials,
  resolveTelegramRuntimeCredentials,
} from '@roomote/db/server';

type TelegramCommunicationProviderRuntimeOptions = {
  /** Custom fetch, e.g. a base-URL-rewriting fetch for webhook admin calls. */
  fetch?: typeof fetch;
  workspaceId?: string;
  sessionId?: string;
};

/**
 * Builds a `TelegramCommunicationProvider` from the resolved runtime
 * credentials (env vars, or values saved from the comms settings UI), or
 * `null` when no bot token is configured.
 */
export async function createTelegramCommunicationProviderFromRuntimeCredentials(
  options?: TelegramCommunicationProviderRuntimeOptions,
): Promise<TelegramCommunicationProvider | null> {
  const workspaceId = options?.workspaceId;
  if (workspaceId?.startsWith('telegram-bot:')) {
    const binding = await resolveTelegramManagedBotCredentials(workspaceId);
    if (
      !binding ||
      (options?.sessionId && binding.sessionId !== options.sessionId)
    ) {
      return null;
    }
    return new TelegramCommunicationProvider({
      botToken: binding.botToken,
      fetch: async (input, init) => {
        // Queued turns and cached adapters must stop sending after disconnect.
        const current = await resolveTelegramManagedBotCredentials(workspaceId);
        if (
          !current ||
          current.botToken !== binding.botToken ||
          current.sessionId !== binding.sessionId ||
          current.ownerTelegramUserId !== binding.ownerTelegramUserId
        ) {
          throw new Error('Telegram session bot is disconnected.');
        }
        const body =
          typeof init?.body === 'string'
            ? (JSON.parse(init.body) as { chat_id?: unknown })
            : null;
        if (
          body?.chat_id !== undefined &&
          String(body.chat_id) !== current.ownerTelegramUserId
        ) {
          throw new Error(
            'Telegram session bot requires its private owner chat.',
          );
        }
        try {
          return await (options?.fetch ?? fetch)(input, init);
        } catch {
          throw new Error('Telegram session bot request failed.');
        }
      },
    });
  }
  const { botToken } = await resolveTelegramRuntimeCredentials();

  if (!botToken) {
    return null;
  }

  return new TelegramCommunicationProvider({
    botToken,
    ...(options?.sessionId && workspaceId
      ? {
          fetch: async (
            input: Parameters<typeof fetch>[0],
            init?: RequestInit,
          ) => {
            const current = await db.query.fastAgentConversations.findFirst({
              where: eq(fastAgentConversations.id, options.sessionId!),
              columns: { workspaceId: true, surface: true },
            });
            if (
              current?.surface !== 'telegram' ||
              current.workspaceId !== workspaceId
            ) {
              throw new Error('Telegram Session delivery route changed.');
            }
            return (options.fetch ?? fetch)(input, init);
          },
        }
      : options?.fetch
        ? { fetch: options.fetch }
        : {}),
  });
}
