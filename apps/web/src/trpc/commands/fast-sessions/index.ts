import { randomUUID } from 'node:crypto';
import { after } from 'next/server';

import {
  acquireFastAgentTurnLock,
  answerFastAgentQuestion,
  createFastAgentWebTaskLauncher,
  getOrCreateFastAgentSession,
  resolveApiBaseUrl,
} from '@roomote/cloud-agents/server';
import {
  buildFastAgentSurfaceReplyDelivery,
  resolveUserMcpServerConfigs,
  type FastAgentSurfaceReplyDelivery,
} from '@roomote/sdk/server';
import { db, eq, fastAgentConversations } from '@roomote/db/server';
import {
  formatErrorForLog,
  getUserDisplayName,
  type ReasoningEffort,
} from '@roomote/types';

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

  // An explicit null is a reset: it must yield undefined for this turn too,
  // not fall back to the stored override the update just cleared.
  return {
    model:
      (input.model === undefined ? stored.model : input.model) ?? undefined,
    reasoningEffort:
      (input.reasoningEffort === undefined
        ? stored.reasoningEffort
        : input.reasoningEffort) ?? undefined,
  };
}

type WebFastAgentConversation = {
  surface: 'web';
  workspaceId: string;
  conversationId: string;
};

type WebFastAgentTurnInput = {
  userId: string;
  delivery: FastAgentSurfaceReplyDelivery;
  question: string;
  images?: string[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
  senderDisplayName?: string;
};

/**
 * Run one web-initiated Fast turn after the caller's response is ready. The
 * transcript view picks up canonical rows as the turn persists them. The Redis
 * turn lock serializes turns per conversation, so queued replies simply wait
 * their turn. The delivery's adapter routes agent replies to the conversation's
 * home surface (Slack/Discord threads for sessions that live there; the
 * canonical transcript alone for web).
 */
async function runWebFastAgentTurn({
  userId,
  delivery,
  question,
  images,
  model,
  reasoningEffort,
  senderDisplayName,
}: WebFastAgentTurnInput): Promise<void> {
  const conversation = delivery.conversation;
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
      senderDisplayName,
      adapter: {
        resolveMcpServerConfigs: () =>
          resolveUserMcpServerConfigs({
            userId,
            apiBaseUrl,
            includeRoomoteMemberTools: true,
          }),
        ...delivery.adapter,
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

export function scheduleWebFastAgentTurn(input: WebFastAgentTurnInput): void {
  // Keep the server invocation alive after tRPC returns the session to the UI.
  // A detached promise can be suspended between a retry notice and its timer.
  after(() => runWebFastAgentTurn(input));
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

  scheduleWebFastAgentTurn({
    userId: auth.userId,
    delivery: {
      conversation,
      adapter: {
        launchTask: createFastAgentWebTaskLauncher({
          userId: auth.userId,
          conversation,
        }),
        postReply: async () => {},
      },
    },
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

  const senderDisplayName =
    getUserDisplayName({ name: auth.name, email: auth.primaryEmail }) ?? null;
  const [settings, delivery] = await Promise.all([
    resolveSessionModelSettings(session.id, input, {
      model: session.model,
      reasoningEffort: session.reasoningEffort,
    }),
    buildFastAgentSurfaceReplyDelivery({
      sessionId: session.id,
      userId: auth.userId,
      senderDisplayName,
      question: input.text,
    }),
  ]);
  if (!delivery) {
    throw new Error(
      "This session's chat surface is not connected, so replies cannot be delivered.",
    );
  }

  scheduleWebFastAgentTurn({
    userId: auth.userId,
    delivery,
    question: input.text,
    images: input.images,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    ...(senderDisplayName ? { senderDisplayName } : {}),
  });

  return { success: true };
}
