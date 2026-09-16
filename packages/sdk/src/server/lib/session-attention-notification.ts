import { randomUUID } from 'node:crypto';

import {
  and,
  asc,
  count,
  db,
  desc,
  eq,
  getUserChatInitiationProvider,
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
import { isSessionUserPresent, isSessionVoiceCallActive } from '@roomote/redis';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  extractAcpMessageText,
  extractVisibleAcpPromptText,
  getFastAgentParentFromPayload,
  isSystemInjectedAcpPromptText,
  type IosPushKind,
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
import { enqueueIosPush } from './ios-push/enqueue';
import { findPendingSessionAttention } from './ios-push/pending-attention';

const DELIVERY_LEASE_MS = 2 * 60 * 1_000;
const RECOVERY_DELAY_MS = DELIVERY_LEASE_MS + 5_000;
const SHORT_WEB_GAP_MAX_MESSAGES = 4;

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type SessionAttentionKind = 'result_ready' | 'input_needed';
export type SessionAttentionNotificationResult =
  | 'delivered'
  | 'skipped'
  | 'already_claimed'
  | 'not_applicable'
  | 'failed';

type NotificationSubject = {
  sessionId: string;
  userId: string;
  eventKey: string;
  /** The attention event id; for `input_needed` this is the requestId. */
  eventId: string;
  kind: SessionAttentionKind;
  taskId?: string;
  runId?: number;
  message?: string;
  fastConversationId?: string;
  fastEventId?: string;
  initialPrompt?: string | null;
};

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
) {
  await executor
    .update(sessionAttentionNotifications)
    .set({
      outcome,
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

/**
 * Queue the matching iOS push. Additive to the chat DM: it runs beside the
 * provider waterfall, never replaces it, and never fails the delivery.
 */
async function enqueueAttentionIosPush(
  subject: NotificationSubject,
  notificationText: string,
  executor: Pick<DbTransaction, 'select'>,
): Promise<void> {
  try {
    const [session] = await executor
      .select({
        title: sessions.title,
        fastConversationId: sessions.fastConversationId,
      })
      .from(sessions)
      .where(eq(sessions.id, subject.sessionId))
      .limit(1);
    const fastConversationId =
      subject.fastConversationId ?? session?.fastConversationId ?? undefined;
    const pending = fastConversationId
      ? await findPendingSessionAttention(fastConversationId, executor)
      : { request: null, offer: null };
    const kind: IosPushKind =
      subject.kind === 'input_needed'
        ? 'user_input'
        : pending.offer
          ? 'capability_offer'
          : 'reply';
    await enqueueIosPush({
      userId: subject.userId,
      kind,
      title: session?.title?.trim() || 'Roomote',
      body: notificationText,
      sessionId: subject.sessionId,
      ...(fastConversationId ? { fastConversationId } : {}),
      ...(subject.taskId ? { taskId: subject.taskId } : {}),
      ...(kind === 'user_input'
        ? { requestId: pending.request?.requestId ?? subject.eventId }
        : {}),
      ...(kind === 'capability_offer' && pending.offer
        ? {
            offerId: pending.offer.offerId,
            capability: pending.offer.capability,
          }
        : {}),
      eventKey: subject.eventKey,
      collapseId: `${kind}:${subject.sessionId}`,
    });
  } catch (error) {
    console.warn(
      `[sessionAttentionNotification] iOS push enqueue failed for ${subject.eventKey}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function deliverNotification(
  subject: NotificationSubject,
): Promise<SessionAttentionNotificationResult> {
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

    const responseText = subject.message?.trim();
    const notificationText =
      responseText ||
      (subject.kind === 'input_needed'
        ? 'Your input is needed.'
        : 'A new response is ready.');
    await enqueueAttentionIosPush(subject, notificationText, tx);
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
    await markOutcome(claim.id, claim.leaseToken, 'delivered', tx);
    return 'delivered';
  });
}

export async function notifyDirectWebTaskAttention(
  input: {
    runId: number;
    eventId: string;
    kind: SessionAttentionKind;
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
          prompt: true,
        },
      },
    },
  });
  if (
    !run?.task ||
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
  if (!(await hasAnyUserDirectMessageIdentity(run.task.initiatorUserId))) {
    return 'not_applicable';
  }

  const recoveryScheduled = enqueueRetry
    ? await enqueueSessionAttentionNotification(
        { target: 'task', ...input },
        { delay: RECOVERY_DELAY_MS },
      )
    : true;

  const result = await deliverNotification({
    sessionId: session.id,
    userId: run.task.initiatorUserId,
    eventKey: `task:${run.id}:${input.kind}:${input.eventId}`,
    eventId: input.eventId,
    kind: input.kind,
    taskId: run.taskId,
    runId: run.id,
    initialPrompt: run.task.prompt,
    message:
      input.message ??
      (await findTaskAttentionMessage(run.id, input.kind, input.eventId)),
  });
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
    },
  });
  if (
    !session?.ownerUserId ||
    session.sourceSurface !== 'web' ||
    input.manual !== true
  ) {
    return 'not_applicable';
  }
  if (!(await hasAnyUserDirectMessageIdentity(session.ownerUserId))) {
    return 'not_applicable';
  }
  if (enqueueRetry) {
    await enqueueSessionAttentionNotification(
      { target: 'fast_session', ...input },
      { delay: RECOVERY_DELAY_MS },
    );
  }
  const result = await deliverNotification({
    sessionId: session.id,
    userId: session.ownerUserId,
    eventKey: `fast:${input.kind}:${input.eventId}`,
    eventId: input.eventId,
    kind: input.kind,
    message: input.message,
    fastConversationId: input.fastConversationId,
    fastEventId: input.eventId,
  });
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
