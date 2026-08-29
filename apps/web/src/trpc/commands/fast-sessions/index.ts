import { randomUUID } from 'node:crypto';
import { after } from 'next/server';

import {
  acquireFastAgentTurnLock,
  answerFastAgentQuestion,
  createFastAgentWebTaskLauncher,
  getOrCreateFastAgentSession,
  resolveApiBaseUrl,
  type FastAgentPlatformEventKind,
  type FastAgentPlatformEventVisibility,
  type FastAgentTurnSource,
  upsertFastAgentMessage,
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
  fastAgentMessages,
  and,
  sql,
  getSessionForFastConversation,
  retireCanonicalPrReviewActionsForDestinationKey,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  formatErrorForLog,
  getUserDisplayName,
  parseAcpRequestUserInputAnswers,
  parseAcpRequestUserInputPayload,
  parseAcpRequestUserInputQuestion,
  type ReasoningEffort,
} from '@roomote/types';
import type { FastAgentTurnAdapter } from '@roomote/cloud-agents/server';

import type { UserAuthSuccess } from '@/types';
import {
  findAccessibleFastSession,
  buildFastSessionPrReviewDestinationKey,
  getFastSessionById,
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
  turnSource?: FastAgentTurnSource;
  platformEventKind?: FastAgentPlatformEventKind;
  platformEventVisibility?: FastAgentPlatformEventVisibility;
  setupSnapshot?: string;
  setupSession?: boolean;
  adapterExtensions?: Partial<FastAgentTurnAdapter>;
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
  turnSource,
  platformEventKind,
  platformEventVisibility,
  setupSnapshot,
  setupSession,
  adapterExtensions,
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
      ...(turnSource
        ? {
            turnSource,
            ...(platformEventKind ? { platformEventKind } : {}),
            ...(platformEventVisibility ? { platformEventVisibility } : {}),
          }
        : {}),
      ...(setupSnapshot ? { setupSnapshot } : {}),
      setupSession,
      adapter: {
        resolveMcpServerConfigs: () =>
          resolveUserMcpServerConfigs({
            userId,
            apiBaseUrl,
            includeRoomoteMemberTools: true,
          }),
        ...delivery.adapter,
        ...adapterExtensions,
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

export async function getFastSessionTasksCommand(
  auth: UserAuthSuccess,
  sessionId: string,
) {
  return getFastSessionTasks(auth, sessionId);
}

/** Client-facing Fast transcript load: canonical rows plus paging state. */
export async function getFastSessionMessagesCommand(
  auth: UserAuthSuccess,
  sessionId: string,
) {
  const session = await findAccessibleFastSession(auth, sessionId);
  if (!session) {
    throw new Error('Fast session not found');
  }
  const detail = await getFastSessionById(auth, sessionId);
  if (!detail) {
    throw new Error('Fast session not found');
  }
  return {
    sessionId: detail.id,
    title: detail.title,
    model: detail.model,
    reasoningEffort: detail.reasoningEffort,
    messages: detail.messages,
    hasOlderMessages: detail.hasOlderMessages,
  };
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

/**
 * Submit an authenticated structured response to a Fast session's pending
 * `request_user_input` request. The response is persisted as a canonical
 * transcript event, duplicate or already-resolved submissions are rejected,
 * and the same Fast conversation resumes automatically with a hidden
 * normalized answer payload while the visible transcript keeps only the
 * structured response event.
 */
export async function submitFastSessionUserInputCommand(
  auth: UserAuthSuccess,
  input: {
    sessionId: string;
    requestId: string;
    answers: Record<string, { answers: string[] }>;
  },
  options: {
    adapterExtensions?: Partial<FastAgentTurnAdapter>;
    setupSnapshot?: string;
    setupSession?: boolean;
  } = {},
): Promise<{ success: true }> {
  const session = await findAccessibleFastSession(auth, input.sessionId);
  if (!session) {
    throw new Error('Fast session not found');
  }

  const [request] = await db
    .select({
      eventId: fastAgentMessages.eventId,
      turnId: fastAgentMessages.turnId,
      payload: fastAgentMessages.payload,
    })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, session.id),
        sql`${fastAgentMessages.eventType} = ${ACP_ENVELOPE_EVENT_TYPES.RequestUserInput}`,
        sql`(${fastAgentMessages.payload}->>'requestId') = ${input.requestId}`,
      ),
    )
    .orderBy(sql`${fastAgentMessages.ts} desc`)
    .limit(1);

  if (!request) {
    throw new Error('This input request does not exist in the session.');
  }

  const [existingResponse] = await db
    .select({ eventId: fastAgentMessages.eventId })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, session.id),
        sql`${fastAgentMessages.eventType} = ${ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse}`,
        sql`(${fastAgentMessages.payload}->>'requestId') = ${input.requestId}`,
      ),
    )
    .limit(1);
  if (existingResponse) {
    throw new Error('This input request was already resolved.');
  }

  const requestPayload = parseAcpRequestUserInputPayload(request.payload);
  if (!requestPayload) {
    throw new Error('This input request is no longer valid.');
  }
  const submitted = parseAcpRequestUserInputAnswers(input.answers) ?? {};
  for (const question of requestPayload.questions.map((question) =>
    parseAcpRequestUserInputQuestion(question),
  )) {
    if (!question) continue;
    const answers = submitted[question.id]?.answers ?? [];
    const selectionMode = question.selectionMode ?? 'single';
    if (selectionMode === 'multiple') {
      const minSelections =
        question.minSelections ?? (question.options?.length ? 1 : 0);
      if (answers.length < minSelections) {
        throw new Error(
          `Select at least ${minSelections} option${minSelections === 1 ? '' : 's'}.`,
        );
      }
      if (
        question.options?.length &&
        answers.some(
          (answer) =>
            !question.options?.some((option) => option.label === answer),
        )
      ) {
        throw new Error('One or more selections are not valid options.');
      }
    } else if (answers.length > 1) {
      throw new Error('This question accepts a single answer.');
    }
  }

  const responseEventId = `${request.eventId}:response`;
  await upsertFastAgentMessage({
    sessionId: session.id,
    message: {
      eventId: responseEventId,
      turnId: request.turnId,
      turnSeq: 2_000_000_000,
      ts: Date.now(),
      eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse,
      role: 'user',
      contentBlocks: [
        {
          type: 'text' as const,
          text: JSON.stringify({ requestId: input.requestId, submitted }),
        },
      ],
      metadata: { visibleInTranscript: true },
      payload: {
        requestId: input.requestId,
        sessionId: session.id,
        turnId: request.turnId,
        callId: input.requestId,
        answers: submitted,
        resolution: 'submitted',
      },
      source: 'web',
    },
  });

  scheduleWebFastAgentTurn({
    userId: auth.userId,
    delivery: {
      conversation: {
        surface: 'web',
        workspaceId: session.userId,
        conversationId: session.conversationId,
      },
      adapter: {
        launchTask: createFastAgentWebTaskLauncher({
          userId: session.userId,
          conversation: {
            surface: 'web',
            workspaceId: session.userId,
            conversationId: session.conversationId,
          },
        }),
        postReply: async () => {},
      },
    },
    question: `<structured_input_response>${JSON.stringify({
      requestId: input.requestId,
      answers: submitted,
    })}</structured_input_response>`,
    turnSource: 'platform_event',
    platformEventKind: 'input_response',
    platformEventVisibility: 'required',
    ...(options.adapterExtensions
      ? { adapterExtensions: options.adapterExtensions }
      : {}),
    ...(options.setupSnapshot ? { setupSnapshot: options.setupSnapshot } : {}),
    setupSession: options.setupSession ?? false,
  });

  return { success: true };
}
