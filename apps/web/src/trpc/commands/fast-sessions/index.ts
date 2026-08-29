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
import {
  db,
  eq,
  fastAgentConversations,
  getSessionForFastConversation,
  retireCanonicalPrReviewActionsForDestinationKey,
  sessions,
} from '@roomote/db/server';
import {
  formatErrorForLog,
  getUserDisplayName,
  type ReasoningEffort,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import {
  findAccessibleFastSession,
  buildFastSessionPrReviewDestinationKey,
  getFastSessionPrReviewOfferStatus,
  getFastSessionTasks,
  updateFastSessionPrReviewOfferStatus,
} from '@/lib/server/fast-sessions';
import { handleWebPrReviewAction } from '@/lib/server/pr-review-actions';

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
  attachmentTexts?: string[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
  senderDisplayName?: string;
  /** Present for trusted platform-generated turns (e.g. the setup kickoff);
   * absent for human-authored web messages. */
  platformEventKind?: 'setup';
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
  attachmentTexts,
  model,
  reasoningEffort,
  senderDisplayName,
  platformEventKind,
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
      attachmentTexts,
      userId,
      apiBaseUrl,
      conversation,
      currentMessageId: `web-${randomUUID()}`,
      signal: release.signal,
      model,
      reasoningEffort,
      senderDisplayName,
      ...(platformEventKind
        ? {
            turnSource: 'platform_event' as const,
            platformEventKind,
            platformEventVisibility: 'required' as const,
          }
        : {}),
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
    attachmentTexts?: string[];
    model?: string | null;
    reasoningEffort?: ReasoningEffort | null;
    conversationId?: string;
  },
): Promise<{ sessionId: string; fastConversationId?: string }> {
  const conversation: WebFastAgentConversation = {
    surface: 'web',
    workspaceId: auth.userId,
    conversationId: input.conversationId ?? randomUUID(),
  };

  const session = await getOrCreateFastAgentSession({
    userId: auth.userId,
    conversation,
  });
  const settings = await resolveSessionModelSettings(session.id, input, {
    model: null,
    reasoningEffort: null,
  });

  if (session.created) {
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
      attachmentTexts: input.attachmentTexts,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
    });
  }

  const unifiedSession = await getSessionForFastConversation(db, session.id);
  return {
    sessionId: unifiedSession?.id ?? session.id,
    fastConversationId: session.id,
  };
}

/**
 * Creates (or reuses) the first-run setup session and, on creation, schedules
 * its kickoff as a trusted setup platform event instead of a human message.
 * The deterministic conversationId makes creation idempotent per launch batch,
 * and the `created` guard means a re-submit never schedules a second kickoff.
 */
export async function startSetupFastSessionCommand(
  auth: UserAuthSuccess,
  input: {
    conversationId: string;
    title: string;
    event: Record<string, unknown>;
  },
): Promise<{ sessionId: string; created: boolean }> {
  const conversation: WebFastAgentConversation = {
    surface: 'web',
    workspaceId: auth.userId,
    conversationId: input.conversationId,
  };

  const session = await getOrCreateFastAgentSession({
    userId: auth.userId,
    conversation,
  });

  if (session.created) {
    // Fixed, human-authored-style title: marking it user-edited keeps the
    // LLM title refresh from renaming the setup session later.
    const titleEditedByUserAt = new Date();
    await Promise.all([
      db
        .update(fastAgentConversations)
        .set({ title: input.title, titleEditedByUserAt })
        .where(eq(fastAgentConversations.id, session.id)),
      db
        .update(sessions)
        .set({ title: input.title, titleEditedByUserAt })
        .where(eq(sessions.fastConversationId, session.id)),
    ]);

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
      question: `<platform_event>${JSON.stringify(input.event)}</platform_event>`,
      platformEventKind: 'setup',
    });
  }

  const unifiedSession = await getSessionForFastConversation(db, session.id);
  return {
    sessionId: unifiedSession?.id ?? session.id,
    created: session.created,
  };
}

export async function getFastSessionTasksCommand(
  auth: UserAuthSuccess,
  sessionId: string,
) {
  return getFastSessionTasks(auth, sessionId);
}

export async function updateFastSessionModelSelectionCommand(
  auth: UserAuthSuccess,
  input: {
    sessionId: string;
    model?: string | null;
    reasoningEffort?: ReasoningEffort | null;
  },
): Promise<{ success: true }> {
  const session = await findAccessibleFastSession(auth, input.sessionId);
  if (!session) {
    throw new Error('Fast session not found');
  }

  await resolveSessionModelSettings(session.id, input, {
    model: session.model,
    reasoningEffort: session.reasoningEffort,
  });

  return { success: true };
}

export async function replyToFastSessionCommand(
  auth: UserAuthSuccess,
  input: {
    sessionId: string;
    text: string;
    images?: string[];
    attachmentTexts?: string[];
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

  const retiredDeliveryIds =
    await retireCanonicalPrReviewActionsForDestinationKey({
      destinationKind: 'fast_conversation',
      destinationKey: buildFastSessionPrReviewDestinationKey(session),
    });
  await updateFastSessionPrReviewOfferStatus(
    session.id,
    retiredDeliveryIds,
    'dismissed',
  );

  scheduleWebFastAgentTurn({
    userId: auth.userId,
    delivery,
    question: input.text,
    images: input.images,
    attachmentTexts: input.attachmentTexts,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    ...(senderDisplayName ? { senderDisplayName } : {}),
  });

  return { success: true };
}

export async function handleFastSessionPrReviewActionCommand(
  auth: UserAuthSuccess,
  input: {
    sessionId: string;
    deliveryId: string;
    choice: 'yes' | 'auto' | 'dismiss';
  },
): Promise<{
  status: 'pending' | 'resolved' | 'auto_resolved' | 'dismissed' | 'stale';
}> {
  const session = await findAccessibleFastSession(auth, input.sessionId);
  if (!session) throw new Error('Fast session not found');

  return handleWebPrReviewAction({
    deliveryId: input.deliveryId,
    choice: input.choice,
    actingUserId: auth.userId,
    expectedDestinationKind: 'fast_conversation',
    expectedDestinationKey: buildFastSessionPrReviewDestinationKey(session),
    getOfferStatus: () =>
      getFastSessionPrReviewOfferStatus(session.id, input.deliveryId),
    updateOfferStatus: (status) =>
      updateFastSessionPrReviewOfferStatus(
        session.id,
        [input.deliveryId],
        status,
      ),
  });
}
