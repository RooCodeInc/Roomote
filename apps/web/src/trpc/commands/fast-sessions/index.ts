import { randomUUID } from 'node:crypto';

import {
  acquireFastAgentTurnLock,
  answerFastAgentQuestion,
  createFastAgentWebTaskLauncher,
  getOrCreateFastAgentSession,
  resolveApiBaseUrl,
} from '@roomote/cloud-agents/server';
import { resolveUserMcpServerConfigs } from '@roomote/sdk/server';
import { db, eq, fastAgentConversations } from '@roomote/db/server';
import { formatErrorForLog, type ReasoningEffort } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import { findAccessibleFastSession } from '@/lib/server/fast-sessions';

/**
 * Persist the session's model settings when the caller sent an explicit
 * choice, and return the effective settings for this turn. An omitted field
 * falls back to what the session already stores, so the choice sticks across
 * replies and reloads.
 */
async function resolveSessionModelSettings(
  sessionId: string,
  input: {
    model?: string | null;
    reasoningEffort?: ReasoningEffort | null;
  },
  stored: { model: string | null; reasoningEffort: ReasoningEffort | null },
): Promise<{ model?: string; reasoningEffort?: ReasoningEffort }> {
  const changes: Partial<{
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
  }> = {};
  if (input.model !== undefined && input.model !== stored.model) {
    changes.model = input.model || null;
  }
  if (
    input.reasoningEffort !== undefined &&
    input.reasoningEffort !== stored.reasoningEffort
  ) {
    changes.reasoningEffort = input.reasoningEffort || null;
  }
  if (Object.keys(changes).length > 0) {
    await db
      .update(fastAgentConversations)
      .set(changes)
      .where(eq(fastAgentConversations.id, sessionId));
  }

  return {
    model: input.model ?? stored.model ?? undefined,
    reasoningEffort:
      input.reasoningEffort ?? stored.reasoningEffort ?? undefined,
  };
}

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
  model,
  reasoningEffort,
}: {
  userId: string;
  conversation: WebFastAgentConversation;
  question: string;
  images?: string[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
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
      model,
      reasoningEffort,
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
  input: {
    text: string;
    images?: string[];
    model?: string | null;
    reasoningEffort?: ReasoningEffort | null;
  },
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
  const settings = await resolveSessionModelSettings(session.id, input, {
    model: null,
    reasoningEffort: null,
  });

  void runWebFastAgentTurn({
    userId: auth.userId,
    conversation,
    question: input.text,
    images: input.images,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
  });

  return { sessionId: session.id };
}

export async function replyToFastSessionCommand(
  auth: UserAuthSuccess,
  input: {
    sessionId: string;
    text: string;
    images?: string[];
    model?: string | null;
    reasoningEffort?: ReasoningEffort | null;
  },
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

  const settings = await resolveSessionModelSettings(session.id, input, {
    model: session.model,
    reasoningEffort: session.reasoningEffort,
  });

  void runWebFastAgentTurn({
    userId: auth.userId,
    conversation: {
      surface: 'web',
      workspaceId: session.workspaceId,
      conversationId: session.conversationId,
    },
    question: input.text,
    images: input.images,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
  });

  return { success: true };
}
