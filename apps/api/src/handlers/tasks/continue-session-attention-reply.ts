import type { FastAgentConversation } from '@roomote/types';
import {
  queueFastAgentSurfaceReply,
  continueDirectTaskAttentionReply,
  resolveSessionAttentionFastConversation,
  type SessionAttentionKind,
} from '@roomote/sdk/server';

export async function continueSessionAttentionReply(input: {
  attention: {
    sessionId: string;
    taskId: string | null;
    runId: number | null;
    kind: SessionAttentionKind;
  };
  userId: string;
  senderDisplayName: string | null;
  question: string;
  currentMessageId: string;
  deliveryConversation: FastAgentConversation;
  images?: string[];
  attachmentTexts?: string[];
  agentContext?: string;
  replyToMessageId?: string;
}): Promise<boolean> {
  if (input.attention.taskId && input.attention.runId) {
    return continueDirectTaskAttentionReply({
      taskId: input.attention.taskId,
      runId: input.attention.runId,
      userId: input.userId,
      question: input.question,
      kind: input.attention.kind,
    });
  }

  const fastConversationId = await resolveSessionAttentionFastConversation({
    sessionId: input.attention.sessionId,
    userId: input.userId,
  });
  if (!fastConversationId) return false;

  return queueFastAgentSurfaceReply({
    sessionId: fastConversationId,
    userId: input.userId,
    senderDisplayName: input.senderDisplayName,
    question: input.question,
    currentMessageId: input.currentMessageId,
    deliveryConversation: input.deliveryConversation,
    ...(input.replyToMessageId
      ? { replyToMessageId: input.replyToMessageId }
      : {}),
    ...(input.images?.length ? { images: input.images } : {}),
    ...(input.attachmentTexts?.length
      ? { attachmentTexts: input.attachmentTexts }
      : {}),
    ...(input.agentContext ? { agentContext: input.agentContext } : {}),
  });
}
