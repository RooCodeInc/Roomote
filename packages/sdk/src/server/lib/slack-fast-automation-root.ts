import { fastAgentConversationRepository } from '@roomote/cloud-agents/server';
import { acquireSlackFastRootBindingLock } from '@roomote/slack';
import type { FastAgentConversation } from '@roomote/types';

type SlackFastConversation = Extract<
  FastAgentConversation,
  { surface: 'slack' }
>;

type BoundSlackFastAutomationConversation = Omit<
  SlackFastConversation,
  'replyTarget'
> & {
  replyTarget: SlackFastConversation['replyTarget'] & { threadId: string };
};

type BoundSlackFastAutomationRoot = {
  conversation: BoundSlackFastAutomationConversation;
  threadId: string;
  created: boolean;
};

function toBoundConversation(
  conversation: SlackFastConversation,
): BoundSlackFastAutomationConversation | null {
  const threadId = conversation.replyTarget.threadId;
  if (!threadId) return null;

  return {
    ...conversation,
    replyTarget: { ...conversation.replyTarget, threadId },
  };
}

/** Owns the pending-to-bound lifecycle for delayed Slack automation roots. */
export async function ensureSlackFastAutomationRoot(params: {
  sessionId: string;
  fallbackConversation: SlackFastConversation;
  postRoot: (
    conversation: SlackFastConversation,
  ) => Promise<string | undefined>;
}): Promise<BoundSlackFastAutomationRoot | null> {
  const alreadyBound = toBoundConversation(params.fallbackConversation);
  if (alreadyBound) {
    return {
      conversation: alreadyBound,
      threadId: alreadyBound.replyTarget.threadId,
      created: false,
    };
  }

  const releaseRootBindingLock = await acquireSlackFastRootBindingLock({
    teamId: params.fallbackConversation.workspaceId,
    channelId: params.fallbackConversation.replyTarget.channelId,
  });
  try {
    const canonicalSession = await fastAgentConversationRepository.findById({
      id: params.sessionId,
      fallbackConversation: params.fallbackConversation,
    });
    if (
      !canonicalSession ||
      canonicalSession.conversation.surface !== 'slack'
    ) {
      return null;
    }

    const canonicalConversation = canonicalSession.conversation;
    const boundConversation = toBoundConversation(canonicalConversation);
    if (boundConversation) {
      return {
        conversation: boundConversation,
        threadId: boundConversation.replyTarget.threadId,
        created: false,
      };
    }

    const threadId = await params.postRoot(canonicalConversation);
    if (!threadId) {
      throw new Error('Slack did not create the Fast automation root.');
    }

    const conversation: BoundSlackFastAutomationConversation = {
      ...canonicalConversation,
      replyTarget: { ...canonicalConversation.replyTarget, threadId },
    };
    await fastAgentConversationRepository.getOrCreate({
      userId: canonicalSession.userId,
      conversation,
    });

    return { conversation, threadId, created: true };
  } finally {
    await releaseRootBindingLock().catch(() => {});
  }
}
