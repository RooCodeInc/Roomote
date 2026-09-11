import { AgentMailCommunicationProvider } from '@roomote/communication/agentmail-provider';
import { resolveAgentMailRuntimeCredentials } from '@roomote/db/server';
import { isEmailChannelEnabled } from '@roomote/env';

import {
  recordAgentMailOutboundMessage,
  resolveAgentMailReplyRoute,
} from './agentmail/conversation-store';
import {
  AgentMailRecipientUnavailableError,
  resolveAgentMailOutboundRecipient,
} from './agentmail/outbound';
import { buildAgentMailUnsubscribeUrl } from './agentmail/unsubscribe-tokens';

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
    resolveRoute: async (conversationId) => {
      const route = await resolveAgentMailReplyRoute(conversationId);
      // An inbound anchor always wins: the reply goes to whoever last wrote
      // in (the owner or a cc'd participant), exactly as recorded.
      if (!route || route.replyToMessageId) {
        return route;
      }
      // Roomote-initiated conversation nobody has replied to yet: anchor on
      // our own latest message and re-check the consented recipient, since
      // the pinned identity may have been revoked since the first send.
      const recipient = await resolveAgentMailOutboundRecipient(
        route.ownerUserId,
        route.outboundIdentityId,
      );
      if (!recipient.ok) {
        throw new AgentMailRecipientUnavailableError(
          conversationId,
          recipient.reason,
        );
      }
      const unsubscribeUrl = buildAgentMailUnsubscribeUrl(
        recipient.emailAddress,
      );
      return {
        ...route,
        replyToMessageId: route.latestOutboundMessageId,
        recipientEmail: recipient.emailAddress,
        ...(!route.latestOutboundMessageId
          ? {
              outboundStart: {
                textFooter: `\n\nTo stop receiving these emails: ${unsubscribeUrl}`,
                htmlFooter: `<p style="color:#8a93a3;font-size:12px;margin-top:24px"><a href="${unsubscribeUrl}" style="color:#8a93a3">Stop receiving these emails</a></p>`,
                headers: {
                  'List-Unsubscribe': `<${unsubscribeUrl}>`,
                  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                },
              },
            }
          : {}),
      };
    },
    onMessageSent: async ({ conversationId, messageId, threadId }) => {
      await recordAgentMailOutboundMessage({
        conversationId,
        messageId,
        ...(threadId ? { providerThreadId: threadId } : {}),
      });
    },
    ...(options?.fetch ? { fetch: options.fetch } : {}),
  });
}
