import {
  getOrCreateFastAgentSession,
  type FastAgentActiveTask,
} from '@roomote/cloud-agents/server';

import { queueFastAgentSurfaceReply } from './fast-agent-surface-reply';
import {
  buildSourceControlFastConversation,
  type SourceControlFastDiscussion,
} from './source-control-fast-delivery';

export type StartSourceControlFastSessionTurnResult =
  | { status: 'queued'; fastConversationId: string }
  | { status: 'unavailable' };

/**
 * Enters a mention into the discussion's Fast Session. Turns are queued so
 * a busy Session steers or replays them instead of dropping them.
 */
export async function startSourceControlFastSessionTurn(input: {
  discussion: SourceControlFastDiscussion;
  userId: string;
  senderDisplayName: string | null;
  question: string;
  agentContext: string;
  currentMessageId: string;
  activeTasks?: FastAgentActiveTask[];
}): Promise<StartSourceControlFastSessionTurnResult> {
  const conversation = buildSourceControlFastConversation(input.discussion);
  const fastSession = await getOrCreateFastAgentSession({
    userId: input.userId,
    conversation,
  });
  const queued = await queueFastAgentSurfaceReply({
    sessionId: fastSession.id,
    userId: input.userId,
    senderDisplayName: input.senderDisplayName,
    question: input.question,
    agentContext: input.agentContext,
    currentMessageId: input.currentMessageId,
    ...(input.activeTasks?.length ? { activeTasks: input.activeTasks } : {}),
  });
  return queued
    ? { status: 'queued', fastConversationId: fastSession.id }
    : { status: 'unavailable' };
}
