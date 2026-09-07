import { fastAgentConversationRepository } from '@roomote/cloud-agents/server';
import {
  getCommunicationChannelFromTaskPayload,
  getCommunicationMessageIdFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  getFastAgentParentFromPayload,
} from '@roomote/types';
import { createTelegramCommunicationProviderFromRuntimeCredentials } from '../telegram-communication';

export async function resolveTelegramTaskRunRouting(payload: unknown) {
  const parent = getFastAgentParentFromPayload(payload);
  if (parent) {
    if (parent.conversation.surface !== 'telegram') return null;

    // Activation can move an existing Session after this child was queued.
    const session = await fastAgentConversationRepository.findById({
      id: parent.sessionId,
      fallbackConversation: parent.conversation,
    });
    if (!session || session.conversation.surface !== 'telegram') return null;

    const provider =
      await createTelegramCommunicationProviderFromRuntimeCredentials({
        workspaceId: session.conversation.workspaceId,
        sessionId: session.id,
      });
    if (!provider) return null;

    return {
      provider,
      channelId: session.conversation.replyTarget.channelId,
      threadId: session.conversation.replyTarget.threadId,
      messageId: undefined,
    };
  }

  const channelId = getCommunicationChannelFromTaskPayload(payload);
  if (!channelId) return null;
  const provider =
    await createTelegramCommunicationProviderFromRuntimeCredentials();
  if (!provider) return null;

  return {
    provider,
    channelId,
    threadId: getCommunicationThreadIdFromTaskPayload(payload),
    messageId: getCommunicationMessageIdFromTaskPayload(payload),
  };
}
