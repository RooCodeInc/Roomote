export { getFastSessionComposerSuggestionCommand } from './composer-suggestion';

import { randomUUID } from 'node:crypto';
import { after } from 'next/server';

import {
  acquireFastAgentTurnLock,
  answerFastAgentQuestion,
  createFastAgentWebTaskLauncher,
  FastAgentDurableRetryScheduledError,
  getOrCreateFastAgentSession,
  resolveApiBaseUrl,
  type FastAgentPlatformEventKind,
  type FastAgentPlatformEventVisibility,
  type FastAgentTurnSource,
  upsertFastAgentMessage,
} from '@roomote/cloud-agents/server';
import {
  buildFastAgentArtifactCreator,
  buildFastAgentSurfaceReplyDelivery,
  createFastAgentSessionArtifact,
  persistFastAgentInlineHumanTurn,
  resolveUserMcpServerConfigs,
  wakeFastAgentParentEventAt,
  wakeFastAgentParentEventNow,
  type FastAgentSurfaceReplyDelivery,
} from '@roomote/sdk/server';
import {
  and,
  db,
  ensureSessionForFastConversation,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  getSessionForFastConversation,
  retireCanonicalPrReviewActionsForDestinationKey,
  sessions,
  sql,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  formatRequestUserInputResponseText,
  formatErrorForLog,
  getAcpRequestUserInputValidationError,
  getUserDisplayName,
  parseAcpRequestUserInputAnswers,
  parseAcpRequestUserInputPayload,
  parseAcpRequestUserInputResponsePayload,
  type AcpRequestUserInputAnswers,
  type AcpRequestUserInputPayload,
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
import {
  currentEpochSeconds,
  signArtifactId,
} from '@/lib/server/artifact-signature';
import type { PinnedFastSessionLaunchInput } from './input';
import { startPinnedFastSessionLaunch } from './pinned-launch';

const ARTIFACT_SIGNATURE_CACHE_WINDOW_SECONDS = 60 * 60;

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
  /** Deterministic turn ID override. Canonical event IDs derive from it, so a
   * fixed value lets a turn be claimed idempotently across retries. */
  currentMessageId?: string;
  /** Fast conversation id for durable admission of a human turn. Platform
   * turns (kickoffs, artifact builds) omit it and stay non-replayable. */
  durableSessionId?: string;
  /** Skip the turn if this exact canonical event row already exists when the
   * turn acquires its lock. This is the atomic claim for the setup kickoff:
   * concurrent submits can both pass the pre-schedule check, but the first
   * kickoff persists its prompt row under the turn lock, so the re-check
   * under the same lock is race-free — and unlike a transcript-emptiness
   * probe it is not fooled by an early human reply in the new session. */
  skipIfEventExists?: {
    conversationId: string;
    eventId: string;
  };
  /** Skip an idempotent platform turn only after it has a durable terminal
   * response. The synthetic prompt is deliberately not a completion marker:
   * it is persisted before inference and must remain retryable after failure. */
  skipIfTurnCompleted?: { conversationId: string; turnId: string };
  setupSnapshot?: string;
  setupSession?: boolean;
  adapterExtensions?: Partial<FastAgentTurnAdapter>;
};

async function hasCompletedWebFastAgentTurn(input: {
  conversationId: string;
  turnId: string;
}): Promise<boolean> {
  const [completion] = await db
    .select({ id: fastAgentMessages.id })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, input.conversationId),
        eq(fastAgentMessages.turnId, input.turnId),
        sql`(
          (${fastAgentMessages.eventType} = ${ACP_ENVELOPE_EVENT_TYPES.AssistantMessage}
            AND ${fastAgentMessages.metadata} ->> 'purpose' IN ('closeout', 'clarification'))
          OR ${fastAgentMessages.eventType} = ${ACP_ENVELOPE_EVENT_TYPES.RequestUserInput}
        )`,
      ),
    )
    .limit(1);
  return Boolean(completion);
}

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
  currentMessageId,
  skipIfEventExists,
  skipIfTurnCompleted,
  turnSource,
  platformEventKind,
  platformEventVisibility,
  setupSnapshot,
  setupSession,
  adapterExtensions,
  durableSessionId,
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
    if (skipIfEventExists) {
      const [existingEvent] = await db
        .select({ id: fastAgentMessages.id })
        .from(fastAgentMessages)
        .where(
          and(
            eq(
              fastAgentMessages.conversationId,
              skipIfEventExists.conversationId,
            ),
            eq(fastAgentMessages.eventId, skipIfEventExists.eventId),
          ),
        )
        .limit(1);
      if (existingEvent) {
        console.log(
          `[Fast Web] Skipping duplicate turn for ${conversation.conversationId}: event ${skipIfEventExists.eventId} already ran.`,
        );
        return;
      }
    }

    if (skipIfTurnCompleted) {
      if (await hasCompletedWebFastAgentTurn(skipIfTurnCompleted)) {
        console.log(
          `[Fast Web] Skipping completed turn for ${conversation.conversationId}: turn ${skipIfTurnCompleted.turnId} already finished.`,
        );
        return;
      }
    }

    const turnMessageId = currentMessageId ?? `web-${randomUUID()}`;
    // Durable admission: a web turn is persisted under this process's claim
    // before it runs, so an interruption hands it to the queue. Platform
    // events ride the same row with their framing recorded; the ones that
    // need adapter extensions or a setup snapshot cannot be rebuilt by the
    // queue and stay process-bound.
    const durableTurn =
      durableSessionId && !adapterExtensions && !setupSnapshot
        ? await persistFastAgentInlineHumanTurn({
            parent: { sessionId: durableSessionId, conversation },
            event: {
              type: 'human_follow_up',
              eventId: turnMessageId,
              currentMessageId: turnMessageId,
              userId,
              question,
              ...(images?.length ? { images } : {}),
              ...(senderDisplayName ? { senderDisplayName } : {}),
              ...(turnSource === 'platform_event'
                ? {
                    turnSource,
                    ...(platformEventKind ? { platformEventKind } : {}),
                    ...(platformEventVisibility
                      ? { platformEventVisibility }
                      : {}),
                  }
                : {}),
              ...(setupSession ? { setupSession: true } : {}),
            },
          }).catch((error) => {
            console.error(
              `[Fast Web] Failed to persist turn admission: ${formatErrorForLog(error)}`,
            );
            return null;
          })
        : null;
    if (durableTurn && durableSessionId) {
      release.durableRowId = durableTurn.id;
      release.durableResume = () =>
        wakeFastAgentParentEventNow({
          conversationId: durableSessionId,
          eventKey: durableTurn.eventKey,
        });
    }
    await answerFastAgentQuestion({
      question,
      images,
      attachmentTexts,
      userId,
      apiBaseUrl,
      conversation,
      currentMessageId: turnMessageId,
      signal: release.signal,
      ...(durableTurn ? { durableAdmission: { eventId: durableTurn.id } } : {}),
      // A row admission found still pending is an interrupted earlier
      // attempt (a kickoff re-scheduled after a restart); run it as a
      // resumption so recorded actions are not repeated.
      ...(durableTurn?.resumed ? { resumedAfterInterruption: true } : {}),
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
        ...(durableTurn && durableSessionId
          ? {
              requestDurableResume: () =>
                wakeFastAgentParentEventNow({
                  conversationId: durableSessionId,
                  eventKey: durableTurn.eventKey,
                }),
              requestDurableRetry: (retryAt: Date) =>
                wakeFastAgentParentEventAt(
                  {
                    conversationId: durableSessionId,
                    eventKey: durableTurn.eventKey,
                  },
                  retryAt,
                ),
            }
          : {}),
        ...delivery.adapter,
        ...adapterExtensions,
      },
    });
  } catch (error) {
    if (error instanceof FastAgentDurableRetryScheduledError) {
      // Not a failure: the queue re-runs this turn at the scheduled time.
      console.info(
        `[Fast Web] Turn parked for a durable retry for ${conversation.conversationId}: ${error.message}`,
      );
      return;
    }
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
    pinnedLaunch?: PinnedFastSessionLaunchInput;
  },
): Promise<{
  sessionId: string;
  fastConversationId?: string;
  taskId?: string;
}> {
  if (input.pinnedLaunch) {
    return startPinnedFastSessionLaunch(auth, {
      text: input.text,
      images: input.images,
      attachmentTexts: input.attachmentTexts,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      pinnedLaunch: input.pinnedLaunch,
    });
  }

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
  const unifiedSession = await ensureSessionForFastConversation(db, session.id);

  const kickoffTurnId = input.conversationId
    ? `web-kickoff:${session.id}`
    : undefined;
  const kickoffPromptEventId = kickoffTurnId
    ? `${kickoffTurnId}:user`
    : undefined;
  let scheduleKickoff = session.created;
  if (!scheduleKickoff && kickoffPromptEventId) {
    const [existingKickoff] = await db
      .select({ id: fastAgentMessages.id })
      .from(fastAgentMessages)
      .where(
        and(
          eq(fastAgentMessages.conversationId, session.id),
          eq(fastAgentMessages.eventId, kickoffPromptEventId),
        ),
      )
      .limit(1);
    if (!existingKickoff) {
      scheduleKickoff = true;
    }
  }

  if (scheduleKickoff) {
    const launchTask = createFastAgentWebTaskLauncher({
      userId: auth.userId,
      conversation,
    });

    scheduleWebFastAgentTurn({
      userId: auth.userId,
      delivery: {
        conversation,
        adapter: {
          createArtifact: (artifact) => {
            return createFastAgentSessionArtifact({
              sessionId: unifiedSession.id,
              ...artifact,
            });
          },
          launchTask,
          postReply: async () => {},
        },
      },
      question: input.text,
      images: input.images,
      attachmentTexts: input.attachmentTexts,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      durableSessionId: session.id,
      ...(kickoffTurnId && kickoffPromptEventId
        ? {
            currentMessageId: kickoffTurnId,
            skipIfEventExists: {
              conversationId: session.id,
              eventId: kickoffPromptEventId,
            },
          }
        : {}),
    });
  }

  return {
    sessionId: unifiedSession?.id ?? session.id,
    fastConversationId: session.id,
  };
}

/**
 * Creates (or reuses) the first-run setup session and schedules its kickoff
 * as a trusted setup platform event instead of a human message. The
 * deterministic conversationId makes creation idempotent per launch batch. A
 * kickoff is scheduled on creation, and again on reuse while the transcript
 * is still empty: creation can commit while a later failure (or a process
 * crash) loses the kickoff, and an empty transcript means it never ran.
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

  // The kickoff turn runs under a deterministic turn ID. Only a durable
  // terminal response completes it; a prompt row left by failed inference is
  // intentionally retried.
  const kickoffTurnId = `setup-kickoff:${session.id}`;

  let scheduleKickoff = session.created;
  if (!scheduleKickoff) {
    scheduleKickoff = !(await hasCompletedWebFastAgentTurn({
      conversationId: session.id,
      turnId: kickoffTurnId,
    }));
  }

  if (scheduleKickoff) {
    // Fixed, human-authored-style title: marking it user-edited keeps the
    // LLM title refresh from renaming the setup session later. Best-effort:
    // a failed rename must never cost the kickoff and the starter launches.
    const titleEditedByUserAt = new Date();
    try {
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
    } catch (error) {
      console.error(
        `[Fast Web] Failed to title setup session ${session.id}: ${formatErrorForLog(error)}`,
      );
    }

    scheduleWebFastAgentTurn({
      userId: auth.userId,
      delivery: {
        conversation,
        adapter: {
          createArtifact: buildFastAgentArtifactCreator(session.id),
          launchTask: createFastAgentWebTaskLauncher({
            userId: auth.userId,
            conversation,
          }),
          postReply: async () => {},
        },
      },
      question: `<platform_event>${JSON.stringify(input.event)}</platform_event>`,
      turnSource: 'platform_event',
      platformEventKind: 'setup',
      platformEventVisibility: 'required',
      currentMessageId: kickoffTurnId,
      durableSessionId: session.id,
      skipIfTurnCompleted: {
        conversationId: session.id,
        turnId: kickoffTurnId,
      },
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
  const tasks = await getFastSessionTasks(auth, sessionId);
  if (!tasks) return null;

  const artifactSignatureTimestamp =
    Math.floor(
      currentEpochSeconds() / ARTIFACT_SIGNATURE_CACHE_WINDOW_SECONDS,
    ) * ARTIFACT_SIGNATURE_CACHE_WINDOW_SECONDS;

  return tasks.map((task) => ({
    ...task,
    artifacts: task.artifacts.map((artifact) => {
      const isImage = artifact.contentType.startsWith('image/');
      const isVideo = artifact.contentType.startsWith('video/');
      const previewUrl =
        isImage || isVideo
          ? `/api/artifacts/${artifact.id}/raw?sig=${signArtifactId(artifact.id, artifactSignatureTimestamp)}&ts=${artifactSignatureTimestamp}`
          : undefined;

      return {
        ...artifact,
        thumbnailUrl: isImage ? previewUrl : undefined,
        previewUrl: isVideo ? previewUrl : undefined,
      };
    }),
  }));
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
    durableSessionId: session.id,
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
    resolution?: 'submitted' | 'cancelled';
  },
  options: {
    adapterExtensions?: Partial<FastAgentTurnAdapter>;
    setupSnapshot?: string;
    setupSession?: boolean;
    persistSetupPresetResponse?: (input: {
      fastConversationId: string;
      request: {
        eventId: string;
        turnId: string;
        payload: AcpRequestUserInputPayload;
      };
      answers: Record<string, { answers: string[] }>;
    }) => Promise<unknown>;
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
    .select({
      eventId: fastAgentMessages.eventId,
      payload: fastAgentMessages.payload,
    })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, session.id),
        sql`${fastAgentMessages.eventType} = ${ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse}`,
        sql`(${fastAgentMessages.payload}->>'requestId') = ${input.requestId}`,
      ),
    )
    .limit(1);
  const requestPayload = parseAcpRequestUserInputPayload(request.payload);
  if (!requestPayload) {
    throw new Error('This input request is no longer valid.');
  }
  const submitted = parseAcpRequestUserInputAnswers(input.answers) ?? {};
  const resolution = input.resolution ?? 'submitted';
  if (requestPayload.preset && resolution === 'cancelled') {
    throw new Error('This required setup choice cannot be cancelled.');
  }
  const validationError = getAcpRequestUserInputValidationError(
    requestPayload.questions,
    submitted,
    resolution,
  );
  if (validationError) {
    throw new Error(validationError);
  }

  const scheduleResponseTurn = (answers: AcpRequestUserInputAnswers) => {
    const responseTurnId = `input-response:${input.requestId}`;
    scheduleWebFastAgentTurn({
      userId: auth.userId,
      delivery: {
        conversation: {
          surface: 'web',
          workspaceId: session.userId,
          conversationId: session.conversationId,
        },
        adapter: {
          createArtifact: buildFastAgentArtifactCreator(session.id),
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
        answers,
      })}</structured_input_response>`,
      turnSource: 'platform_event',
      platformEventKind: 'input_response',
      platformEventVisibility: 'required',
      currentMessageId: responseTurnId,
      durableSessionId: session.id,
      skipIfTurnCompleted: {
        conversationId: session.id,
        turnId: responseTurnId,
      },
      ...(options.adapterExtensions
        ? { adapterExtensions: options.adapterExtensions }
        : {}),
      ...(options.setupSnapshot
        ? { setupSnapshot: options.setupSnapshot }
        : {}),
      setupSession: options.setupSession ?? false,
    });
  };

  if (existingResponse) {
    const persistedResponse = parseAcpRequestUserInputResponsePayload(
      existingResponse.payload,
    );
    if (
      !requestPayload.preset &&
      persistedResponse?.resolution === 'submitted'
    ) {
      scheduleResponseTurn(persistedResponse.answers);
    }
    return { success: true };
  }

  const responseEventId = `${request.eventId}:response`;
  if (requestPayload.preset) {
    if (!options.persistSetupPresetResponse || resolution !== 'submitted') {
      throw new Error('This trusted setup response cannot be handled here.');
    }
    await options.persistSetupPresetResponse({
      fastConversationId: session.id,
      request: {
        eventId: request.eventId,
        turnId: request.turnId,
        payload: requestPayload,
      },
      answers: submitted,
    });
    return { success: true };
  }
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
          text: formatRequestUserInputResponseText(requestPayload, {
            answers: submitted,
            resolution,
          }),
        },
      ],
      metadata: { visibleInTranscript: true },
      payload: {
        requestId: input.requestId,
        sessionId: session.id,
        turnId: request.turnId,
        callId: input.requestId,
        answers: submitted,
        resolution,
      },
      source: 'web',
    },
  });

  if (resolution === 'cancelled') return { success: true };
  scheduleResponseTurn(submitted);

  return { success: true };
}
