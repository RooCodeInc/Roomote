import { createTeamsCommunicationProviderFromRuntimeCredentials } from '@roomote/sdk/server';

import { apiLogger } from '../../logging.js';

// The primary-conversation lookup moved to @roomote/sdk so the web setup
// flow can target the same proactive Teams destination; this module keeps
// the historical apps/api import path. The narrow subpath import keeps the
// full sdk server barrel out of this handler's module graph.
export { findTeamsPrimaryConversation } from '@roomote/sdk/server/teams-primary-conversation';

export async function postTeamsAutomationMessageBestEffort(input: {
  conversationId: string;
  serviceUrl: string;
  threadId?: string;
  text: string;
}): Promise<{ messageId: string | null } | null> {
  const provider =
    await createTeamsCommunicationProviderFromRuntimeCredentials();

  if (!provider) {
    apiLogger.warn(
      '[teams] Skipping Teams automation message because bot credentials are not configured',
    );
    return null;
  }

  try {
    const result = await provider.postMessage({
      channelId: input.conversationId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      serviceUrl: input.serviceUrl,
      text: input.text,
      textFormat: 'markdown',
    });

    return { messageId: result.messageId || null };
  } catch (error) {
    apiLogger.warn(
      `[teams] Failed to post Teams automation message: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
