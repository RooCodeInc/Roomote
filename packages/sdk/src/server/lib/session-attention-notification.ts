import { createHash, randomUUID } from 'node:crypto';

import { Env } from '@roomote/env';
import {
  and,
  db,
  eq,
  getSessionForTask,
  isNull,
  inArray,
  lt,
  or,
  sessionAttentionNotificationMessages,
  sessionAttentionNotifications,
  sessions,
  taskRuns,
} from '@roomote/db/server';
import { isSessionUserPresent } from '@roomote/redis';
import { getFastAgentParentFromPayload } from '@roomote/types';
import {
  getOrCreateFastAgentSession,
  type FastAgentConversation,
} from '@roomote/cloud-agents/server';

import {
  sendUserDirectMessageBestEffortWithReceipts,
  type UserDirectMessageProvider,
} from './user-direct-message';
import {
  enqueueSessionAttentionNotification,
  type SessionAttentionNotificationJob,
} from './enqueue-session-attention-notification';

const DELIVERY_LEASE_MS = 2 * 60 * 1_000;

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
  title: string;
  eventKey: string;
  kind: SessionAttentionKind;
  taskId?: string;
  runId?: number;
};

function buildIdempotencyKey(sessionId: string, eventKey: string): string {
  const hash = createHash('sha256')
    .update(`session-attention:${sessionId}:${eventKey}`)
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function claimNotification(subject: NotificationSubject) {
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + DELIVERY_LEASE_MS);
  const [inserted] = await db
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

  const [reclaimed] = await db
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
) {
  await db
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

async function deliverNotification(
  subject: NotificationSubject,
): Promise<SessionAttentionNotificationResult> {
  const claim = await claimNotification(subject);
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
  if (present) {
    await markOutcome(claim.id, claim.leaseToken, 'skipped_present');
    return 'skipped';
  }

  const statusText =
    subject.kind === 'input_needed'
      ? 'needs your input.'
      : 'has a new response.';
  const sessionUrl = new URL(`/sessions/${subject.sessionId}`, Env.R_APP_URL);
  sessionUrl.searchParams.set('utm_source', 'notification');
  sessionUrl.searchParams.set('utm_medium', 'direct_message');
  sessionUrl.searchParams.set('utm_campaign', 'session-attention');

  const receipts = await sendUserDirectMessageBestEffortWithReceipts({
    userId: subject.userId,
    text: `**${subject.title}** ${statusText}\n\nReply to this message to continue, or [open the Session](${sessionUrl.toString()}).`,
    logContext: 'sessionAttentionNotification',
    idempotencyKey: buildIdempotencyKey(subject.sessionId, subject.eventKey),
  });
  if (receipts.length === 0) {
    await markOutcome(claim.id, claim.leaseToken, 'failed');
    return 'failed';
  }

  await db.transaction(async (tx) => {
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
        })),
      )
      .onConflictDoNothing();
    await tx
      .update(sessionAttentionNotifications)
      .set({
        outcome: 'delivered',
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessionAttentionNotifications.id, claim.id),
          eq(sessionAttentionNotifications.leaseToken, claim.leaseToken),
        ),
      );
  });
  return 'delivered';
}

export async function notifyDirectWebTaskAttention(
  input: {
    runId: number;
    eventId: string;
    kind: SessionAttentionKind;
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
          surface: true,
          title: true,
        },
      },
    },
  });
  if (
    !run?.task ||
    run.task.surface !== 'web' ||
    !run.task.initiatorUserId ||
    getFastAgentParentFromPayload(run.payload)
  ) {
    return 'not_applicable';
  }
  const session = await getSessionForTask(db, run.taskId);
  if (!session) return 'not_applicable';

  const result = await deliverNotification({
    sessionId: session.id,
    userId: run.task.initiatorUserId,
    title: run.task.title,
    eventKey: `task:${run.id}:${input.kind}:${input.eventId}`,
    kind: input.kind,
    taskId: run.taskId,
    runId: run.id,
  });
  if (result === 'failed' && enqueueRetry) {
    await enqueueSessionAttentionNotification({ target: 'task', ...input });
  }
  return result;
}

export async function notifyFastWebSessionAttention(
  input: {
    fastConversationId: string;
    eventId: string;
    kind: SessionAttentionKind;
  },
  enqueueRetry = true,
): Promise<SessionAttentionNotificationResult> {
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.fastConversationId, input.fastConversationId),
    columns: {
      id: true,
      ownerUserId: true,
      sourceSurface: true,
      title: true,
    },
  });
  if (!session?.ownerUserId || session.sourceSurface !== 'web') {
    return 'not_applicable';
  }
  const result = await deliverNotification({
    sessionId: session.id,
    userId: session.ownerUserId,
    title: session.title,
    eventKey: `fast:${input.kind}:${input.eventId}`,
    kind: input.kind,
  });
  if (result === 'failed' && enqueueRetry) {
    await enqueueSessionAttentionNotification({
      target: 'fast_session',
      ...input,
    });
  }
  return result;
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
        inArray(sessionAttentionNotifications.outcome, [
          'delivered',
          'skipped_present',
        ]),
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
}): Promise<{ sessionId: string; kind: SessionAttentionKind } | null> {
  if (!input.replyToMessageId && !input.threadId) return null;
  const row = await db
    .select({
      sessionId: sessionAttentionNotifications.sessionId,
      userId: sessionAttentionNotifications.userId,
      kind: sessionAttentionNotifications.kind,
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
        eq(sessionAttentionNotificationMessages.channelId, input.channelId),
        ...(input.replyToMessageId
          ? [
              eq(
                sessionAttentionNotificationMessages.messageId,
                input.replyToMessageId,
              ),
            ]
          : [
              eq(
                sessionAttentionNotificationMessages.threadId,
                input.threadId!,
              ),
            ]),
      ),
    )
    .limit(1);
  const match = row[0];
  return match?.userId === input.userId
    ? { sessionId: match.sessionId, kind: match.kind }
    : null;
}

export async function isSessionAttentionNotificationMessage(input: {
  provider: UserDirectMessageProvider;
  workspaceId: string;
  channelId: string;
  messageId: string;
}): Promise<boolean> {
  return Boolean(
    await db.query.sessionAttentionNotificationMessages.findFirst({
      where: and(
        eq(sessionAttentionNotificationMessages.provider, input.provider),
        eq(sessionAttentionNotificationMessages.workspaceId, input.workspaceId),
        eq(sessionAttentionNotificationMessages.channelId, input.channelId),
        eq(sessionAttentionNotificationMessages.messageId, input.messageId),
      ),
      columns: { id: true },
    }),
  );
}

export async function resolveSessionAttentionFastConversation(input: {
  sessionId: string;
  userId: string;
  deliveryConversation: FastAgentConversation;
}): Promise<string | null> {
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, input.sessionId),
    columns: { id: true, ownerUserId: true },
  });
  if (!session || session.ownerUserId !== input.userId) return null;
  const fastSession = await getOrCreateFastAgentSession({
    userId: input.userId,
    conversation: input.deliveryConversation,
    sessionId: session.id,
  });
  return fastSession.id;
}
