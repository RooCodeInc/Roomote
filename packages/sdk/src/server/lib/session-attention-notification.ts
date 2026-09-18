import { randomUUID } from 'node:crypto';

import {
  and,
  asc,
  count,
  db,
  desc,
  eq,
  getUserChatInitiationProvider,
  isDeploymentExperimentEnabled,
  getSessionForTask,
  gt,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
  sessionAttentionNotificationMessages,
  sessionAttentionNotifications,
  sessions,
  taskRuns,
  taskMessages,
  fastAgentMessages,
  users,
} from '@roomote/db/server';
import {
  getSessionBrowserAttentionCapabilities,
  isSessionUserPresent,
  isSessionVoiceCallActive,
} from '@roomote/redis';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  extractAcpMessageText,
  extractVisibleAcpPromptText,
  getFastAgentParentFromPayload,
  isSystemInjectedAcpPromptText,
} from '@roomote/types';

import {
  sendUserDirectMessageBestEffortWithReceipts,
  hasAnyUserDirectMessageIdentity,
  type UserDirectMessageProvider,
  type UserDirectMessageReceipt,
} from './user-direct-message';
import {
  enqueueSessionAttentionNotification,
  type SessionAttentionNotificationJob,
} from './enqueue-session-attention-notification';
import { buildDeterministicMessageId } from './deterministic-message-id';

const DELIVERY_LEASE_MS = 2 * 60 * 1_000;
const RECOVERY_DELAY_MS = DELIVERY_LEASE_MS + 5_000;
const BROWSER_ATTENTION_FALLBACK_MS = 10_000;
const SHORT_WEB_GAP_MAX_MESSAGES = 4;

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type SessionAttentionKind = 'result_ready' | 'input_needed';
export type SessionAttentionPresentationKind = 'response' | 'error' | 'input';
export type SessionAttentionNotificationResult =
  | 'delivered'
  | 'deferred'
  | 'skipped'
  | 'already_claimed'
  | 'not_applicable'
  | 'failed';

type NotificationSubject = {
  sessionId: string;
  userId: string;
  eventKey: string;
  sourceEventId: string;
  kind: SessionAttentionKind;
  presentationKind: SessionAttentionPresentationKind;
  taskId?: string;
  runId?: number;
  message?: string;
  fastConversationId?: string;
  fastEventId?: string;
  initialPrompt?: string | null;
};

async function recordNotification(subject: NotificationSubject) {
  const [inserted] = await db
    .insert(sessionAttentionNotifications)
    .values({
      sessionId: subject.sessionId,
      userId: subject.userId,
      eventKey: subject.eventKey,
      kind: subject.kind,
      presentationKind: subject.presentationKind,
      body: subject.message?.trim() || null,
      taskId: subject.taskId ?? null,
      runId: subject.runId ?? null,
    })
    .onConflictDoNothing()
    .returning({
      id: sessionAttentionNotifications.id,
      outcome: sessionAttentionNotifications.outcome,
    });
  if (inserted) return inserted;
  return db.query.sessionAttentionNotifications.findFirst({
    where: and(
      eq(sessionAttentionNotifications.sessionId, subject.sessionId),
      eq(sessionAttentionNotifications.eventKey, subject.eventKey),
    ),
    columns: { id: true, outcome: true },
  });
}

type SessionAttentionContinuation = {
  omittedMessageCount: number;
  latestUserMessage?: { senderDisplayName: string | null; text: string };
  linkToSession: boolean;
};

function buildIdempotencyKey(sessionId: string, eventKey: string): string {
  return buildDeterministicMessageId(
    `session-attention:${sessionId}:${eventKey}`,
  );
}

async function claimNotification(
  subject: NotificationSubject,
  executor: Pick<DbTransaction, 'insert' | 'update'>,
) {
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + DELIVERY_LEASE_MS);
  const [inserted] = await executor
    .insert(sessionAttentionNotifications)
    .values({
      sessionId: subject.sessionId,
      userId: subject.userId,
      eventKey: subject.eventKey,
      kind: subject.kind,
      taskId: subject.taskId ?? null,
      runId: subject.runId ?? null,
      leaseToken,
      leaseExpiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: sessionAttentionNotifications.id });
  if (inserted) return { id: inserted.id, leaseToken };

  const [reclaimed] = await executor
    .update(sessionAttentionNotifications)
    .set({ leaseToken, leaseExpiresAt, outcome: null, updatedAt: new Date() })
    .where(
      and(
        eq(sessionAttentionNotifications.sessionId, subject.sessionId),
        eq(sessionAttentionNotifications.eventKey, subject.eventKey),
        or(
          eq(sessionAttentionNotifications.outcome, 'failed'),
          and(
            isNull(sessionAttentionNotifications.outcome),
            or(
              isNull(sessionAttentionNotifications.leaseExpiresAt),
              lt(sessionAttentionNotifications.leaseExpiresAt, new Date()),
            ),
          ),
        ),
      ),
    )
    .returning({ id: sessionAttentionNotifications.id });
  return reclaimed ? { id: reclaimed.id, leaseToken } : null;
}

async function markOutcome(
  id: string,
  leaseToken: string,
  outcome: 'delivered' | 'skipped_present' | 'failed',
  executor: Pick<DbTransaction, 'update'>,
  deliveryChannel?: 'browser' | 'personal_provider',
) {
  await executor
    .update(sessionAttentionNotifications)
    .set({
      outcome,
      deliveryChannel: deliveryChannel ?? null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessionAttentionNotifications.id, id),
        eq(sessionAttentionNotifications.leaseToken, leaseToken),
      ),
    );
}

async function deliverNotification(
  subject: NotificationSubject,
  options: { allowBrowserOffer: boolean } = { allowBrowserOffer: false },
): Promise<SessionAttentionNotificationResult> {
  await recordNotification(subject);
  return db.transaction(async (tx) => {
    // Different attention events can settle concurrently. Serialize the
    // Session/recipient chain so each delivery observes the last successful
    // provider receipt and advances transcript coverage monotonically.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`session-attention:${subject.sessionId}:${subject.userId}`}, 0))`,
    );
    const claim = await claimNotification(subject, tx);
    if (!claim) return 'already_claimed';

    const present = await isSessionUserPresent({
      sessionId: subject.sessionId,
      userId: subject.userId,
    }).catch((error) => {
      console.warn(
        `[sessionAttentionNotification] Presence lookup failed for ${subject.eventKey}; notifying defensively: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    });
    console.info(
      `[sessionAttentionNotification] Presence check for ${subject.eventKey}: ${present ? 'present' : 'absent'}`,
    );
    if (present) {
      await markOutcome(claim.id, claim.leaseToken, 'skipped_present', tx);
      return 'skipped';
    }
    const voiceCallActive = subject.fastConversationId
      ? await isSessionVoiceCallActive({
          sessionId: subject.sessionId,
          userId: subject.userId,
        }).catch((error) => {
          console.warn(
            `[sessionAttentionNotification] Voice state lookup failed for ${subject.eventKey}; notifying defensively: ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        })
      : false;
    if (voiceCallActive) {
      await markOutcome(claim.id, claim.leaseToken, 'skipped_present', tx);
      return 'skipped';
    }

    if (
      options.allowBrowserOffer &&
      (await isDeploymentExperimentEnabled('browserNotifications', tx))
    ) {
      const capabilities = await getSessionBrowserAttentionCapabilities({
        sessionId: subject.sessionId,
        userId: subject.userId,
      }).catch(() => null);
      if (capabilities?.granted.length) {
        const now = new Date();
        const offerExpiresAt = new Date(
          now.getTime() + BROWSER_ATTENTION_FALLBACK_MS,
        );
        await tx
          .update(sessionAttentionNotifications)
          .set({
            browserOfferedAt: now,
            browserOfferExpiresAt: offerExpiresAt,
            updatedAt: now,
          })
          .where(eq(sessionAttentionNotifications.id, claim.id));
        const scheduled = await enqueueSessionAttentionNotification(
          {
            ...(subject.taskId && subject.runId !== undefined
              ? {
                  target: 'task' as const,
                  runId: subject.runId,
                  eventId: subject.sourceEventId,
                  kind: subject.kind,
                  presentationKind: subject.presentationKind,
                  message: subject.message,
                }
              : {
                  target: 'fast_session' as const,
                  fastConversationId: subject.fastConversationId!,
                  eventId: subject.fastEventId!,
                  kind: subject.kind,
                  presentationKind: subject.presentationKind,
                  message: subject.message,
                  manual: true,
                }),
            phase: 'browser_fallback',
          },
          { delay: BROWSER_ATTENTION_FALLBACK_MS },
        );
        if (scheduled) {
          await tx
            .update(sessionAttentionNotifications)
            .set({ leaseToken: null, leaseExpiresAt: null })
            .where(
              and(
                eq(sessionAttentionNotifications.id, claim.id),
                eq(sessionAttentionNotifications.leaseToken, claim.leaseToken),
              ),
            );
          return 'deferred';
        }
      } else if (capabilities?.default.length) {
        await tx
          .update(sessionAttentionNotifications)
          .set({ browserPromptEligibleAt: new Date(), updatedAt: new Date() })
          .where(eq(sessionAttentionNotifications.id, claim.id));
      }
    }

    const responseText = subject.message?.trim();
    const notificationText =
      responseText ||
      (subject.kind === 'input_needed'
        ? 'Your input is needed.'
        : 'A new response is ready.');
    const previousDelivery = await findLatestSessionAttentionDelivery(
      {
        sessionId: subject.sessionId,
        userId: subject.userId,
      },
      tx,
    );
    const currentFastMessageId =
      subject.fastConversationId && subject.fastEventId
        ? await findCurrentFastAttentionMessageId(
            {
              conversationId: subject.fastConversationId,
              eventId: subject.fastEventId,
              kind: subject.kind,
            },
            tx,
          )
        : null;
    const webGap =
      subject.fastConversationId &&
      previousDelivery?.fastMessageId &&
      currentFastMessageId
        ? await findOmittedWebConversation(
            {
              conversationId: subject.fastConversationId,
              previousFastMessageId: previousDelivery.fastMessageId,
              currentFastMessageId,
            },
            tx,
          )
        : null;
    const continuation = webGap?.continuation ?? null;
    const deliveredFastMessageId =
      webGap?.deliveredFastMessageId ?? currentFastMessageId;
    const initialPresentation = await resolveSessionAttentionPresentation({
      sessionId: subject.sessionId,
      userId: subject.userId,
      ...(subject.initialPrompt !== undefined
        ? { taskPrompt: subject.initialPrompt }
        : {}),
      ...(subject.fastConversationId
        ? { fastConversationId: subject.fastConversationId }
        : {}),
      includeInitialMessage: true,
    });
    const replyPresentation = await resolveSessionAttentionPresentation({
      sessionId: subject.sessionId,
      userId: subject.userId,
      includeInitialMessage: false,
      ...(continuation ? { continuation } : {}),
    });
    const preferredProvider = await getUserChatInitiationProvider(
      subject.userId,
      tx,
    );
    if (!(await hasAnyUserDirectMessageIdentity(subject.userId))) {
      await markOutcome(claim.id, claim.leaseToken, 'failed', tx);
      return 'failed';
    }
    const { receipts } = await sendUserDirectMessageBestEffortWithReceipts({
      userId: subject.userId,
      text: notificationText,
      teamsText: `${notificationText}\n\nIf Teams does not attach the reply, start your message with \`continue:\`.`,
      logContext: 'sessionAttentionNotification',
      idempotencyKey: buildIdempotencyKey(subject.sessionId, subject.eventKey),
      ...(previousDelivery ? { replyAnchor: previousDelivery.receipt } : {}),
      ...(preferredProvider ? { preferredProvider } : {}),
      presentation: initialPresentation,
      replyPresentation,
    });
    if (receipts.length === 0) {
      await markOutcome(claim.id, claim.leaseToken, 'failed', tx);
      return 'failed';
    }

    await tx
      .insert(sessionAttentionNotificationMessages)
      .values(
        receipts.map((receipt) => ({
          notificationId: claim.id,
          provider: receipt.provider,
          workspaceId: receipt.workspaceId,
          channelId: receipt.channelId,
          threadId: receipt.threadId ?? null,
          messageId: receipt.messageId,
          fastMessageId: deliveredFastMessageId,
        })),
      )
      .onConflictDoNothing();
    await markOutcome(
      claim.id,
      claim.leaseToken,
      'delivered',
      tx,
      'personal_provider',
    );
    return 'delivered';
  });
}

export async function notifyDirectWebTaskAttention(
  input: {
    runId: number;
    eventId: string;
    kind: SessionAttentionKind;
    presentationKind?: SessionAttentionPresentationKind;
    message?: string;
  },
  enqueueRetry = true,
): Promise<SessionAttentionNotificationResult> {
  const run = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, input.runId),
    columns: { id: true, taskId: true, payload: true },
    with: {
      task: {
        columns: {
          id: true,
          initiatorUserId: true,
          initiatorKind: true,
          trigger: true,
          surface: true,
          privacy: true,
          prompt: true,
        },
      },
    },
  });
  if (
    !run?.task ||
    run.task.privacy === 'private' ||
    run.task.surface !== 'web' ||
    run.task.trigger !== 'manual' ||
    run.task.initiatorKind !== 'user' ||
    !run.task.initiatorUserId ||
    getFastAgentParentFromPayload(run.payload)
  ) {
    return 'not_applicable';
  }
  const session = await getSessionForTask(db, run.taskId);
  if (!session) return 'not_applicable';
  const recoveryScheduled = enqueueRetry
    ? await enqueueSessionAttentionNotification(
        { target: 'task', ...input },
        { delay: RECOVERY_DELAY_MS },
      )
    : true;

  const result = await deliverNotification(
    {
      sessionId: session.id,
      userId: run.task.initiatorUserId,
      eventKey: `task:${run.id}:${input.kind}:${input.eventId}`,
      sourceEventId: input.eventId,
      kind: input.kind,
      presentationKind:
        input.presentationKind ??
        (input.kind === 'input_needed' ? 'input' : 'response'),
      taskId: run.taskId,
      runId: run.id,
      initialPrompt: run.task.prompt,
      message:
        input.message ??
        (await findTaskAttentionMessage(run.id, input.kind, input.eventId)),
    },
    { allowBrowserOffer: enqueueRetry },
  );
  if (result === 'failed' && !recoveryScheduled) {
    await db
      .delete(sessionAttentionNotifications)
      .where(
        and(
          eq(
            sessionAttentionNotifications.eventKey,
            `task:${run.id}:${input.kind}:${input.eventId}`,
          ),
          eq(sessionAttentionNotifications.outcome, 'failed'),
        ),
      );
  }
  return result;
}

export async function notifyFastWebSessionAttention(
  input: {
    fastConversationId: string;
    eventId: string;
    kind: SessionAttentionKind;
    presentationKind?: SessionAttentionPresentationKind;
    message?: string;
    manual: boolean;
  },
  enqueueRetry = true,
): Promise<SessionAttentionNotificationResult> {
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.fastConversationId, input.fastConversationId),
    columns: {
      id: true,
      ownerUserId: true,
      sourceSurface: true,
      privacy: true,
    },
  });
  if (
    !session?.ownerUserId ||
    session.sourceSurface !== 'web' ||
    session.privacy === 'private' ||
    input.manual !== true
  ) {
    return 'not_applicable';
  }
  if (enqueueRetry) {
    await enqueueSessionAttentionNotification(
      { target: 'fast_session', ...input },
      { delay: RECOVERY_DELAY_MS },
    );
  }
  const result = await deliverNotification(
    {
      sessionId: session.id,
      userId: session.ownerUserId,
      eventKey: `fast:${input.kind}:${input.eventId}`,
      sourceEventId: input.eventId,
      kind: input.kind,
      presentationKind:
        input.presentationKind ??
        (input.kind === 'input_needed' ? 'input' : 'response'),
      message: input.message,
      fastConversationId: input.fastConversationId,
      fastEventId: input.eventId,
    },
    { allowBrowserOffer: enqueueRetry },
  );
  return result;
}

export async function resolveSessionAttentionPresentation(input: {
  sessionId: string;
  userId: string;
  taskPrompt?: string | null;
  fastConversationId?: string;
  includeInitialMessage: boolean;
  continuation?: SessionAttentionContinuation;
}) {
  if (input.continuation) {
    return {
      sessionId: input.sessionId,
      continuation: input.continuation,
    };
  }
  if (!input.includeInitialMessage) return { sessionId: input.sessionId };
  const user = await db.query.users.findFirst({
    where: eq(users.id, input.userId),
    columns: { name: true },
  });
  let text = input.taskPrompt?.trim();
  if (!text && input.fastConversationId) {
    const message = await db.query.fastAgentMessages.findFirst({
      where: and(
        eq(fastAgentMessages.conversationId, input.fastConversationId),
        eq(fastAgentMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.UserPrompt),
      ),
      columns: { contentBlocks: true, payload: true },
      orderBy: [asc(fastAgentMessages.ts), asc(fastAgentMessages.turnSeq)],
    });
    text = message
      ? extractAcpMessageText(
          message.contentBlocks,
          message.payload as Record<string, unknown>,
        )?.trim()
      : undefined;
  }
  if (!text) return { sessionId: input.sessionId };
  if (isSystemInjectedAcpPromptText(text)) {
    text = extractVisibleAcpPromptText(text).trim();
  }
  return {
    sessionId: input.sessionId,
    ...(text
      ? { initialUserMessage: { senderDisplayName: user?.name ?? null, text } }
      : {}),
  };
}

export async function findTaskAttentionMessage(
  runId: number,
  kind: SessionAttentionKind,
  eventId: string,
): Promise<string | undefined> {
  const row = await db.query.taskMessages.findFirst({
    where: and(
      eq(taskMessages.runId, runId),
      eq(
        taskMessages.eventType,
        kind === 'input_needed'
          ? ACP_ENVELOPE_EVENT_TYPES.RequestUserInput
          : ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
      ),
      ...(kind === 'input_needed'
        ? [sql`${taskMessages.payload} ->> 'requestId' = ${eventId}`]
        : []),
    ),
    columns: { contentBlocks: true, payload: true },
    orderBy: [desc(taskMessages.ts), desc(taskMessages.createdAt)],
  });
  return row
    ? extractAcpMessageText(
        row.contentBlocks,
        row.payload as Record<string, unknown>,
      )
    : undefined;
}

async function findCurrentFastAttentionMessageId(
  input: {
    conversationId: string;
    eventId: string;
    kind: SessionAttentionKind;
  },
  executor: Pick<DbTransaction, 'select'>,
): Promise<string | null> {
  const [message] = await executor
    .select({ id: fastAgentMessages.id })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, input.conversationId),
        eq(fastAgentMessages.source, 'web'),
        sql`coalesce(${fastAgentMessages.metadata} ->> 'visibleInTranscript', 'true') <> 'false'`,
        or(
          and(
            eq(fastAgentMessages.turnId, input.eventId),
            eq(
              fastAgentMessages.eventType,
              ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
            ),
            sql`coalesce(${fastAgentMessages.payload} ->> 'purpose', ${fastAgentMessages.metadata} ->> 'purpose') in ('closeout', 'clarification')`,
          ),
          ...(input.kind === 'input_needed'
            ? [
                and(
                  eq(
                    fastAgentMessages.eventType,
                    ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
                  ),
                  sql`${fastAgentMessages.payload} ->> 'requestId' = ${input.eventId}`,
                ),
              ]
            : []),
        ),
      ),
    )
    .orderBy(
      desc(fastAgentMessages.ts),
      desc(fastAgentMessages.turnSeq),
      desc(fastAgentMessages.createdAt),
      desc(fastAgentMessages.id),
    )
    .limit(1);
  return message?.id ?? null;
}

async function findOmittedWebConversation(
  input: {
    conversationId: string;
    previousFastMessageId: string;
    currentFastMessageId: string;
  },
  executor: Pick<DbTransaction, 'select'>,
): Promise<{
  continuation: SessionAttentionContinuation | null;
  deliveredFastMessageId: string;
}> {
  const loadPosition = async (id: string) => {
    const [row] = await executor
      .select({
        id: fastAgentMessages.id,
        ts: fastAgentMessages.ts,
        turnSeq: fastAgentMessages.turnSeq,
        createdAt: fastAgentMessages.createdAt,
      })
      .from(fastAgentMessages)
      .where(
        and(
          eq(fastAgentMessages.id, id),
          eq(fastAgentMessages.conversationId, input.conversationId),
        ),
      )
      .limit(1);
    return row ?? null;
  };
  const previous = await loadPosition(input.previousFastMessageId);
  const current = await loadPosition(input.currentFastMessageId);
  if (!previous || !current) {
    return {
      continuation: null,
      deliveredFastMessageId: input.currentFastMessageId,
    };
  }

  const comparePosition = (
    left: typeof previous,
    right: typeof previous,
  ): number =>
    left.ts - right.ts ||
    left.turnSeq - right.turnSeq ||
    left.createdAt.getTime() - right.createdAt.getTime() ||
    left.id.localeCompare(right.id);
  if (comparePosition(current, previous) <= 0) {
    return {
      continuation: null,
      deliveredFastMessageId: previous.id,
    };
  }

  const afterPrevious = or(
    gt(fastAgentMessages.ts, previous.ts),
    and(
      eq(fastAgentMessages.ts, previous.ts),
      gt(fastAgentMessages.turnSeq, previous.turnSeq),
    ),
    and(
      eq(fastAgentMessages.ts, previous.ts),
      eq(fastAgentMessages.turnSeq, previous.turnSeq),
      gt(fastAgentMessages.createdAt, previous.createdAt),
    ),
    and(
      eq(fastAgentMessages.ts, previous.ts),
      eq(fastAgentMessages.turnSeq, previous.turnSeq),
      eq(fastAgentMessages.createdAt, previous.createdAt),
      gt(fastAgentMessages.id, previous.id),
    ),
  );
  const beforeCurrent = or(
    lt(fastAgentMessages.ts, current.ts),
    and(
      eq(fastAgentMessages.ts, current.ts),
      lt(fastAgentMessages.turnSeq, current.turnSeq),
    ),
    and(
      eq(fastAgentMessages.ts, current.ts),
      eq(fastAgentMessages.turnSeq, current.turnSeq),
      lt(fastAgentMessages.createdAt, current.createdAt),
    ),
    and(
      eq(fastAgentMessages.ts, current.ts),
      eq(fastAgentMessages.turnSeq, current.turnSeq),
      eq(fastAgentMessages.createdAt, current.createdAt),
      lt(fastAgentMessages.id, current.id),
    ),
  );
  const isRealWebConversationMessage = and(
    eq(fastAgentMessages.conversationId, input.conversationId),
    eq(fastAgentMessages.source, 'web'),
    sql`coalesce(${fastAgentMessages.metadata} ->> 'visibleInTranscript', 'true') <> 'false'`,
    sql`${fastAgentMessages.metadata} ->> 'inferenceRetryNotice' is distinct from 'true'`,
    sql`${fastAgentMessages.metadata} ->> 'interruptionReason' is null`,
    or(
      and(
        eq(fastAgentMessages.role, 'user'),
        eq(fastAgentMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.UserPrompt),
      ),
      and(
        eq(fastAgentMessages.role, 'assistant'),
        or(
          eq(
            fastAgentMessages.eventType,
            ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
          ),
          eq(
            fastAgentMessages.eventType,
            ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
          ),
        ),
      ),
    ),
    afterPrevious,
    beforeCurrent,
    ne(fastAgentMessages.id, previous.id),
    ne(fastAgentMessages.id, current.id),
  );
  const [countRow] = await executor
    .select({ value: count() })
    .from(fastAgentMessages)
    .where(isRealWebConversationMessage);
  const omittedMessageCount = Number(countRow?.value ?? 0);
  if (omittedMessageCount === 0) {
    return {
      continuation: null,
      deliveredFastMessageId: current.id,
    };
  }

  let latestUserMessage:
    | { senderDisplayName: string | null; text: string }
    | undefined;
  if (omittedMessageCount <= SHORT_WEB_GAP_MAX_MESSAGES) {
    const [latestUser] = await executor
      .select({
        contentBlocks: fastAgentMessages.contentBlocks,
        payload: fastAgentMessages.payload,
      })
      .from(fastAgentMessages)
      .where(
        and(
          isRealWebConversationMessage,
          eq(fastAgentMessages.role, 'user'),
          eq(fastAgentMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.UserPrompt),
        ),
      )
      .orderBy(
        desc(fastAgentMessages.ts),
        desc(fastAgentMessages.turnSeq),
        desc(fastAgentMessages.createdAt),
        desc(fastAgentMessages.id),
      )
      .limit(1);
    const text = latestUser
      ? extractAcpMessageText(
          latestUser.contentBlocks,
          latestUser.payload as Record<string, unknown>,
        )?.trim()
      : undefined;
    if (text) latestUserMessage = { senderDisplayName: 'You', text };
  }

  return {
    continuation: {
      omittedMessageCount,
      linkToSession: omittedMessageCount > SHORT_WEB_GAP_MAX_MESSAGES,
      ...(latestUserMessage ? { latestUserMessage } : {}),
    },
    deliveredFastMessageId: current.id,
  };
}

async function findLatestSessionAttentionDelivery(
  input: { sessionId: string; userId: string },
  executor: Pick<DbTransaction, 'select'>,
): Promise<{
  receipt: UserDirectMessageReceipt;
  fastMessageId: string | null;
} | null> {
  const [delivery] = await executor
    .select({
      provider: sessionAttentionNotificationMessages.provider,
      workspaceId: sessionAttentionNotificationMessages.workspaceId,
      channelId: sessionAttentionNotificationMessages.channelId,
      messageId: sessionAttentionNotificationMessages.messageId,
      threadId: sessionAttentionNotificationMessages.threadId,
    })
    .from(sessionAttentionNotificationMessages)
    .innerJoin(
      sessionAttentionNotifications,
      eq(
        sessionAttentionNotifications.id,
        sessionAttentionNotificationMessages.notificationId,
      ),
    )
    .where(
      and(
        eq(sessionAttentionNotifications.sessionId, input.sessionId),
        eq(sessionAttentionNotifications.userId, input.userId),
        eq(sessionAttentionNotifications.outcome, 'delivered'),
      ),
    )
    .orderBy(
      desc(sessionAttentionNotifications.updatedAt),
      desc(sessionAttentionNotificationMessages.createdAt),
    )
    .limit(1);
  if (!delivery) return null;

  const [coverage] = await executor
    .select({
      fastMessageId: sessionAttentionNotificationMessages.fastMessageId,
    })
    .from(sessionAttentionNotificationMessages)
    .innerJoin(
      sessionAttentionNotifications,
      eq(
        sessionAttentionNotifications.id,
        sessionAttentionNotificationMessages.notificationId,
      ),
    )
    .where(
      and(
        eq(sessionAttentionNotifications.sessionId, input.sessionId),
        eq(sessionAttentionNotifications.userId, input.userId),
        eq(sessionAttentionNotifications.outcome, 'delivered'),
        isNotNull(sessionAttentionNotificationMessages.fastMessageId),
      ),
    )
    .orderBy(
      desc(sessionAttentionNotifications.updatedAt),
      desc(sessionAttentionNotificationMessages.createdAt),
    )
    .limit(1);
  return {
    receipt: {
      provider: delivery.provider,
      workspaceId: delivery.workspaceId,
      channelId: delivery.channelId,
      messageId: delivery.messageId,
      ...(delivery.threadId ? { threadId: delivery.threadId } : {}),
    },
    fastMessageId: coverage?.fastMessageId ?? null,
  };
}

export async function findLatestSessionAttentionReceipt(input: {
  sessionId: string;
  userId: string;
}): Promise<UserDirectMessageReceipt | null> {
  return (await findLatestSessionAttentionDelivery(input, db))?.receipt ?? null;
}

export async function processSessionAttentionNotificationJob(
  job: SessionAttentionNotificationJob,
): Promise<SessionAttentionNotificationResult> {
  return job.target === 'task'
    ? notifyDirectWebTaskAttention(job, false)
    : notifyFastWebSessionAttention(job, false);
}

export type BrowserAttentionEvent = {
  notificationId: string;
  eventKey: string;
  mode: 'notify' | 'prompt';
  presentationKind: SessionAttentionPresentationKind;
  title: string;
  body: string;
  href: string;
  createdAt: Date;
  offerExpiresAt: Date | null;
};

/** Returns browser attention events recorded after this tab opened. */
export async function listSessionBrowserAttentionEvents(input: {
  sessionId: string;
  userId: string;
  since: Date;
}): Promise<BrowserAttentionEvent[]> {
  const rows = await db
    .select({
      id: sessionAttentionNotifications.id,
      eventKey: sessionAttentionNotifications.eventKey,
      presentationKind: sessionAttentionNotifications.presentationKind,
      body: sessionAttentionNotifications.body,
      taskId: sessionAttentionNotifications.taskId,
      outcome: sessionAttentionNotifications.outcome,
      browserPromptEligibleAt:
        sessionAttentionNotifications.browserPromptEligibleAt,
      browserOfferedAt: sessionAttentionNotifications.browserOfferedAt,
      browserOfferExpiresAt:
        sessionAttentionNotifications.browserOfferExpiresAt,
      browserAcceptedAt: sessionAttentionNotifications.browserAcceptedAt,
      createdAt: sessionAttentionNotifications.createdAt,
      sessionTitle: sessions.title,
    })
    .from(sessionAttentionNotifications)
    .innerJoin(
      sessions,
      eq(sessions.id, sessionAttentionNotifications.sessionId),
    )
    .where(
      and(
        eq(sessionAttentionNotifications.sessionId, input.sessionId),
        eq(sessionAttentionNotifications.userId, input.userId),
        gt(sessionAttentionNotifications.createdAt, input.since),
        or(
          and(
            isNotNull(sessionAttentionNotifications.browserOfferedAt),
            isNull(sessionAttentionNotifications.browserAcceptedAt),
            isNull(sessionAttentionNotifications.outcome),
          ),
          isNotNull(sessionAttentionNotifications.browserPromptEligibleAt),
        ),
      ),
    )
    .orderBy(asc(sessionAttentionNotifications.createdAt));

  return rows.flatMap((row) => {
    const presentationKind = row.presentationKind;
    const body = row.body?.trim();
    if (!presentationKind || !body) return [];
    const notify =
      row.browserOfferedAt !== null &&
      row.browserAcceptedAt === null &&
      row.outcome === null;
    return [
      {
        notificationId: row.id,
        eventKey: row.eventKey,
        mode: notify ? ('notify' as const) : ('prompt' as const),
        presentationKind,
        title:
          presentationKind === 'error'
            ? 'I ran into a problem'
            : presentationKind === 'input'
              ? 'I need your input'
              : row.sessionTitle || 'Roomote',
        body,
        href: row.taskId
          ? `/task/${row.taskId}`
          : `/sessions/${input.sessionId}`,
        createdAt: row.createdAt,
        offerExpiresAt: row.browserOfferExpiresAt,
      },
    ];
  });
}

export async function acknowledgeSessionBrowserAttention(input: {
  sessionId: string;
  userId: string;
  notificationId: string;
  clientId: string;
  action: 'accepted' | 'failed' | 'opened';
}): Promise<'accepted' | 'recorded' | 'not_applicable'> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`session-attention:${input.sessionId}:${input.userId}`}, 0))`,
    );
    if (input.action === 'opened') {
      const updated = await tx
        .update(sessionAttentionNotifications)
        .set({ browserOpenedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(sessionAttentionNotifications.id, input.notificationId),
            eq(sessionAttentionNotifications.sessionId, input.sessionId),
            eq(sessionAttentionNotifications.userId, input.userId),
            eq(sessionAttentionNotifications.deliveryChannel, 'browser'),
          ),
        )
        .returning({ id: sessionAttentionNotifications.id });
      return updated.length ? 'recorded' : 'not_applicable';
    }
    if (input.action === 'failed') return 'recorded';
    const now = new Date();
    const updated = await tx
      .update(sessionAttentionNotifications)
      .set({
        outcome: 'delivered',
        deliveryChannel: 'browser',
        browserAcceptedAt: now,
        browserClientId: input.clientId,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(sessionAttentionNotifications.id, input.notificationId),
          eq(sessionAttentionNotifications.sessionId, input.sessionId),
          eq(sessionAttentionNotifications.userId, input.userId),
          isNull(sessionAttentionNotifications.outcome),
          isNotNull(sessionAttentionNotifications.browserOfferedAt),
          gt(sessionAttentionNotifications.browserOfferExpiresAt, now),
        ),
      )
      .returning({ id: sessionAttentionNotifications.id });
    return updated.length ? 'accepted' : 'not_applicable';
  });
}

export async function hasTaskRunAttentionNotification(
  runId: number,
): Promise<boolean> {
  return Boolean(
    await db.query.sessionAttentionNotifications.findFirst({
      where: and(
        eq(sessionAttentionNotifications.runId, runId),
        eq(sessionAttentionNotifications.kind, 'result_ready'),
      ),
      columns: { id: true },
    }),
  );
}

export async function findSessionAttentionNotificationReply(input: {
  provider: UserDirectMessageProvider;
  workspaceId: string;
  channelId: string;
  userId: string;
  replyToMessageId?: string;
  threadId?: string;
  allowLatestChannelMatch?: boolean;
}): Promise<
  | { status: 'none' }
  | { status: 'foreign' }
  | {
      status: 'owned';
      attention: {
        sessionId: string;
        taskId: string | null;
        runId: number | null;
        kind: SessionAttentionKind;
      };
    }
> {
  if (
    !input.replyToMessageId &&
    !input.threadId &&
    !input.allowLatestChannelMatch
  ) {
    return { status: 'none' };
  }
  const row = await db
    .select({
      sessionId: sessionAttentionNotifications.sessionId,
      userId: sessionAttentionNotifications.userId,
      kind: sessionAttentionNotifications.kind,
      taskId: sessionAttentionNotifications.taskId,
      runId: sessionAttentionNotifications.runId,
    })
    .from(sessionAttentionNotificationMessages)
    .innerJoin(
      sessionAttentionNotifications,
      eq(
        sessionAttentionNotifications.id,
        sessionAttentionNotificationMessages.notificationId,
      ),
    )
    .where(
      and(
        eq(sessionAttentionNotificationMessages.provider, input.provider),
        eq(sessionAttentionNotificationMessages.workspaceId, input.workspaceId),
        ...(input.provider === 'agentmail' && input.threadId
          ? []
          : [
              eq(
                sessionAttentionNotificationMessages.channelId,
                input.channelId,
              ),
            ]),
        ...(input.replyToMessageId
          ? [
              eq(
                sessionAttentionNotificationMessages.messageId,
                input.replyToMessageId,
              ),
            ]
          : input.threadId
            ? [
                eq(
                  sessionAttentionNotificationMessages.threadId,
                  input.threadId,
                ),
              ]
            : [
                gt(
                  sessionAttentionNotificationMessages.createdAt,
                  new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000),
                ),
              ]),
      ),
    )
    .orderBy(desc(sessionAttentionNotificationMessages.createdAt))
    .limit(1);
  const match = row[0];
  if (!match) return { status: 'none' };
  if (match.userId !== input.userId) return { status: 'foreign' };
  return {
    status: 'owned',
    attention: {
      sessionId: match.sessionId,
      taskId: match.taskId,
      runId: match.runId,
      kind: match.kind,
    },
  };
}

export async function resolveSessionAttentionFastConversation(input: {
  sessionId: string;
  userId: string;
}): Promise<string | null> {
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, input.sessionId),
    columns: { ownerUserId: true, fastConversationId: true },
  });
  if (!session || session.ownerUserId !== input.userId) return null;
  return session.fastConversationId;
}
