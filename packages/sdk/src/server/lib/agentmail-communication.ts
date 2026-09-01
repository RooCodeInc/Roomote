import { AgentMailCommunicationProvider } from '@roomote/communication/agentmail-provider';
import { resolveAgentMailRuntimeCredentials } from '@roomote/db/server';
import { isEmailChannelEnabled } from '@roomote/env';

import {
  recordAgentMailOutboundMessage,
  resolveAgentMailReplyRoute,
} from './agentmail/conversation-store';

type AgentMailCommunicationProviderRuntimeOptions = {
  /** Custom fetch, e.g. a base-URL-rewriting fetch for the mock harness. */
  fetch?: typeof fetch;
};

/**
 * Builds an `AgentMailCommunicationProvider` from the resolved runtime
 * credentials (env vars, or values saved from the comms settings UI), or
 * `null` when no API key is configured or the email channel is disabled.
 * Every reply path (Fast surface replies, parent events, finish-run result
 * emails, MCP thread replies) builds its adapter here, so this null is what
 * makes R_EMAIL_CHANNEL_ENABLED a complete kill switch for already-admitted
 * conversations, not just for new ones. The adapter resolves reply anchors
 * and recipients from the durable conversation row at send time and writes
 * completed sends back to the outbound anchor only.
 */
export async function createAgentMailCommunicationProviderFromRuntimeCredentials(
  options?: AgentMailCommunicationProviderRuntimeOptions,
): Promise<AgentMailCommunicationProvider | null> {
  if (!isEmailChannelEnabled()) {
    return null;
  }

  const { apiKey } = await resolveAgentMailRuntimeCredentials();

  if (!apiKey) {
    return null;
  }

  return new AgentMailCommunicationProvider({
    apiKey,
    resolveRoute: async (conversationId) =>
      resolveAgentMailReplyRoute(conversationId),
    onMessageSent: async ({ conversationId, messageId }) => {
      await recordAgentMailOutboundMessage({ conversationId, messageId });
    },
    ...(options?.fetch ? { fetch: options.fetch } : {}),
  });
}
