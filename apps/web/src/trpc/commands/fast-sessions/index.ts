export { getFastSessionComposerSuggestionCommand } from './composer-suggestion';

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
  persistFastAgentInlineHumanTurn,
  resolveUserMcpServerConfigs,
  wakeFastAgentParentEventNow,
  type FastAgentSurfaceReplyDelivery,
} from '@roomote/sdk/server';
import {
  and,
  db,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  getSessionForFastConversation,
  isNull,
  retireCanonicalPrReviewActionsForDestinationKey,
  sessions,
  sessionTasks,
  sql,
  taskRuns,
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
import { getArtifactBuildParentSession } from '@/lib/server/sessions';
import { handleWebPrReviewAction } from '@/lib/server/pr-review-actions';
import {
  currentEpochSeconds,
  signArtifactId,
} from '@/lib/server/artifact-signature';
import { notifySourceTaskArtifactBuild } from '../task-runs';

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
  /** Present for trusted platform-generated turns (e.g. the setup kickoff);
   * absent for human-authored web messages. */
  platformEventKind?: 'setup';
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
    artifactBuildLaunchId?: string;
    artifactBuildSessionId?: string;
  };
};

function findArtifactBuildTask(sessionId: string, launchId: string) {
  return db
    .select({ taskId: sessionTasks.taskId })
    .from(sessionTasks)
    .innerJoin(taskRuns, eq(taskRuns.taskId, sessionTasks.taskId))
    .where(
      and(
        eq(sessionTasks.sessionId, sessionId),
        sql`${taskRuns.payload}->>'launchIdempotencyKey' = ${`artifact-build:${launchId}`}`,
        isNull(taskRuns.canceledAt),
      ),
    )
    .limit(1);
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
  platformEventKind,
  currentMessageId,
  skipIfEventExists,
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
        if (skipIfEventExists.artifactBuildLaunchId) {
          const [existingTask] = skipIfEventExists.artifactBuildSessionId
            ? await findArtifactBuildTask(
                skipIfEventExists.artifactBuildSessionId,
                skipIfEventExists.artifactBuildLaunchId,
              )
            : [];
          if (!existingTask) {
            console.log(
              `[Fast Web] Recovering incomplete turn for ${conversation.conversationId}: event ${skipIfEventExists.eventId} exists without an attached task.`,
            );
          } else {
            console.log(
              `[Fast Web] Skipping duplicate turn for ${conversation.conversationId}: event ${skipIfEventExists.eventId} already launched task ${existingTask.taskId}.`,
            );
            return;
          }
        } else {
          console.log(
            `[Fast Web] Skipping duplicate turn for ${conversation.conversationId}: event ${skipIfEventExists.eventId} already ran.`,
          );
          return;
        }
      }
    }

    const turnMessageId = currentMessageId ?? `web-${randomUUID()}`;
    // Durable admission: a human web turn is persisted under this process's
    // claim before it runs, so an interruption hands it to the queue.
    const durableTurn =
      durableSessionId && !platformEventKind
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
        ...(durableTurn && durableSessionId
          ? {
              requestDurableResume: () =>
                wakeFastAgentParentEventNow({
                  conversationId: durableSessionId,
                  eventKey: durableTurn.eventKey,
                }),
            }
          : {}),
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

type ArtifactBuildInput = {
  launchId: string;
  environmentId: string;
  branch?: string;
  taskModel: string;
  sourceArtifactId: string;
  sourceArtifactPath: string;
  sourceArtifactVersion: number;
};

async function startArtifactBuildInParentSession(
  auth: UserAuthSuccess,
  input: { text: string; artifactBuild: ArtifactBuildInput },
): Promise<{ sessionId: string; fastConversationId: string }> {
  const source = await getArtifactBuildParentSession(
    auth,
    input.artifactBuild.sourceArtifactId,
  );
  if (!source) {
    throw new Error('The artifact could not be found.');
  }
  if (!source.sessionId) {
    throw new Error(
      'The task that created this artifact is not attached to a Session.',
    );
  }
  if (!source.fastConversationId) {
    throw new Error("This artifact's Session cannot start a delegated task.");
  }
  const parentFastConversationId = source.fastConversationId;

  const [existingTask] = await findArtifactBuildTask(
    source.sessionId,
    input.artifactBuild.launchId,
  );
  if (existingTask) {
    return {
      sessionId: source.sessionId,
      fastConversationId: parentFastConversationId,
    };
  }

  const senderDisplayName =
    getUserDisplayName({ name: auth.name, email: auth.primaryEmail }) ?? null;
  const delivery = await buildFastAgentSurfaceReplyDelivery({
    sessionId: parentFastConversationId,
    userId: auth.userId,
    senderDisplayName,
    question: input.text,
  });
  if (!delivery) {
    throw new Error(
      "This artifact's Session is not connected, so the build cannot be started.",
    );
  }

  const launchTask = delivery.adapter.launchTask;
  const attributedLaunchTask = async (
    params: Parameters<typeof launchTask>[0],
  ) => {
    const result = await launchTask({
      ...params,
      environmentId: input.artifactBuild.environmentId,
      branch: input.artifactBuild.branch,
      launchIdempotencyKey: `artifact-build:${input.artifactBuild.launchId}`,
      model: input.artifactBuild.taskModel,
      parentSessionId: parentFastConversationId,
    });
    if (result.success) {
      try {
        await notifySourceTaskArtifactBuild({
          auth,
          sourceTaskId: source.sourceTaskId,
          sourceArtifactId: input.artifactBuild.sourceArtifactId,
          sourceArtifactPath: source.sourceArtifactPath,
          sourceArtifactVersion: source.sourceArtifactVersion,
          newTaskId: result.taskId,
        });
      } catch (error) {
        console.error(
          `[startFastSession] Failed to notify Slack threads for source task ${source.sourceTaskId}: ${formatErrorForLog(error)}`,
        );
      }
    }
    return result;
  };

  const currentMessageId = `artifact-build:${input.artifactBuild.launchId}`;
  scheduleWebFastAgentTurn({
    userId: auth.userId,
    delivery: {
      ...delivery,
      adapter: { ...delivery.adapter, launchTask: attributedLaunchTask },
    },
    question: input.text,
    ...(senderDisplayName ? { senderDisplayName } : {}),
    currentMessageId,
    skipIfEventExists: {
      conversationId: parentFastConversationId,
      eventId: `${currentMessageId}:user`,
      artifactBuildLaunchId: input.artifactBuild.launchId,
      artifactBuildSessionId: source.sessionId,
    },
  });

  return {
    sessionId: source.sessionId,
    fastConversationId: parentFastConversationId,
  };
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
    artifactBuild?: {
      launchId: string;
      environmentId: string;
      branch?: string;
      taskModel: string;
      sourceArtifactId: string;
      sourceArtifactPath: string;
      sourceArtifactVersion: number;
    };
  },
): Promise<{ sessionId: string; fastConversationId?: string }> {
  if (input.artifactBuild) {
    return startArtifactBuildInParentSession(auth, {
      text: input.text,
      artifactBuild: input.artifactBuild,
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
  const unifiedSession = await getSessionForFastConversation(db, session.id);

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

  // The kickoff turn runs under a deterministic turn ID, so its persisted
  // prompt row has a knowable event ID. Claiming on that exact row (rather
  // than transcript emptiness) means an early human reply in the new session
  // can never masquerade as an already-run kickoff.
  const kickoffTurnId = `setup-kickoff:${session.id}`;
  const kickoffPromptEventId = `${kickoffTurnId}:user`;

  let scheduleKickoff = session.created;
  if (!scheduleKickoff) {
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
    scheduleKickoff = !existingKickoff;
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
          launchTask: createFastAgentWebTaskLauncher({
            userId: auth.userId,
            conversation,
          }),
          postReply: async () => {},
        },
      },
      question: `<platform_event>${JSON.stringify(input.event)}</platform_event>`,
      platformEventKind: 'setup',
      currentMessageId: kickoffTurnId,
      skipIfEventExists: {
        conversationId: session.id,
        eventId: kickoffPromptEventId,
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
