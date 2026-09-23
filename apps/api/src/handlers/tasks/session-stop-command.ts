import {
  findFastAgentSessionForProviderConversation,
  stopSessionTaskRuns,
  type FastAgentReplyProvider,
} from '@roomote/sdk/server';

type ChatStopProvider = Extract<
  FastAgentReplyProvider,
  'discord' | 'slack' | 'teams' | 'telegram'
>;

type StopChatSessionTasksInput = {
  provider: ChatStopProvider;
  workspaceId: string;
  channelId: string;
  conversationId: string;
  threadId?: string;
  replyToMessageId?: string;
  userId: string;
  displayName?: string | null;
};

type StopChatSessionTasksResult =
  | { kind: 'unavailable'; text: string }
  | { kind: 'stopped'; stoppedCount: number; text: string }
  | {
      kind: 'partial';
      stoppedCount: number;
      failedCount: number;
      text: string;
    };

function pluralizeTask(count: number): string {
  return `${count} active task${count === 1 ? '' : 's'}`;
}

export async function stopChatSessionTasks(
  input: StopChatSessionTasksInput,
): Promise<StopChatSessionTasksResult> {
  const session = await findFastAgentSessionForProviderConversation({
    provider: input.provider,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    conversationId: input.conversationId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.replyToMessageId
      ? { replyToMessageId: input.replyToMessageId }
      : {}),
    userId: input.userId,
  });

  if (
    !session ||
    session.owner.kind !== 'user' ||
    session.owner.userId !== input.userId ||
    session.userId !== input.userId
  ) {
    return {
      kind: 'unavailable',
      text: "I couldn't find a Roomote session you can stop in this conversation.",
    };
  }

  const result = await stopSessionTaskRuns({
    sessionId: session.id,
    authUserId: input.userId,
    cancelledBy: {
      ...(input.displayName?.trim() ? { name: input.displayName.trim() } : {}),
      source: input.provider,
    },
  });

  if (!result.success) {
    const failedCount = result.failedCount ?? 0;
    return {
      kind: 'partial',
      stoppedCount: result.stoppedCount,
      failedCount,
      text: `Stopped ${pluralizeTask(result.stoppedCount)}, but ${failedCount} could not be stopped. The stopped tasks remain resumable; some work may still be running.`,
    };
  }

  if (result.stoppedCount === 0) {
    return {
      kind: 'stopped',
      stoppedCount: 0,
      text: 'There are no active tasks in this session to stop.',
    };
  }

  return {
    kind: 'stopped',
    stoppedCount: result.stoppedCount,
    text: `Stopped ${pluralizeTask(result.stoppedCount)}. The work remains resumable; send another message here to continue.`,
  };
}
