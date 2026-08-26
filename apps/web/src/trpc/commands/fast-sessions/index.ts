import { randomUUID } from 'node:crypto';

import {
  acquireFastAgentTurnLock,
  answerFastAgentQuestion,
  createFastAgentWebTaskLauncher,
  getOrCreateFastAgentSession,
  resolveApiBaseUrl,
} from '@roomote/cloud-agents/server';
import { resolveUserMcpServerConfigs } from '@roomote/sdk/server';
import { formatErrorForLog } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import { findAccessibleFastSession } from '@/lib/server/fast-sessions';

type WebFastAgentConversation = {
  surface: 'web';
  workspaceId: string;
  conversationId: string;
};

/**
 * Run one Fast turn for a web-surface conversation. Fire-and-forget: the
 * caller returns immediately and the transcript view picks up canonical rows
 * as the turn persists them. The Redis turn lock serializes turns per
 * conversation, so queued replies simply wait their turn.
 */
async function runWebFastAgentTurn({
  userId,
  conversation,
  question,
  images,
}: {
  userId: string;
  conversation: WebFastAgentConversation;
  question: string;
  images?: string[];
}): Promise<void> {
  const release = await acquireFastAgentTurnLock({ conversation });
  if (!release) {
    console.error(
      `[Fast Web] Turn lock did not become available for ${conversation.conversationId}`,
    );
    return;
  }

  const apiBaseUrl = resolveApiBaseUrl() ?? undefined;
  try {
    await answerFastAgentQuestion({
      question,
      images,
      userId,
      apiBaseUrl,
      conversation,
      currentMessageId: `web-${randomUUID()}`,
      signal: release.signal,
      adapter: {
        resolveMcpServerConfigs: () =>
          resolveUserMcpServerConfigs({
            userId,
            apiBaseUrl,
            includeRoomoteMemberTools: true,
          }),
        launchTask: createFastAgentWebTaskLauncher({ userId, conversation }),
        // Web has no side channel to post into: the canonical transcript the
        // service persists is the reply surface.
        postReply: async () => {},
      },
    });
  } catch (error) {
    console.error(
      `[Fast Web] Turn failed for ${conversation.conversationId}: ${formatErrorForLog(error)}`,
    );
  } finally {
    await release().catch(() => {});
  }
}

export async function startFastSessionCommand(
  auth: UserAuthSuccess,
  input: { text: string; images?: string[] },
): Promise<{ sessionId: string }> {
  const conversation: WebFastAgentConversation = {
    surface: 'web',
    workspaceId: auth.userId,
    conversationId: randomUUID(),
  };

  const session = await getOrCreateFastAgentSession({
    userId: auth.userId,
    conversation,
  });

  void runWebFastAgentTurn({
    userId: auth.userId,
    conversation,
    question: input.text,
    images: input.images,
  });

  return { sessionId: session.id };
}

export async function replyToFastSessionCommand(
  auth: UserAuthSuccess,
  input: { sessionId: string; text: string; images?: string[] },
): Promise<{ success: true }> {
  const session = await findAccessibleFastSession(auth, input.sessionId);
  if (!session) {
    throw new Error('Fast session not found');
  }
  if (session.surface !== 'web') {
    throw new Error(
      'This session lives on another surface. Reply in its original thread instead.',
    );
  }

  void runWebFastAgentTurn({
    userId: auth.userId,
    conversation: {
      surface: 'web',
      workspaceId: session.workspaceId,
      conversationId: session.conversationId,
    },
    question: input.text,
    images: input.images,
  });

  return { success: true };
}
