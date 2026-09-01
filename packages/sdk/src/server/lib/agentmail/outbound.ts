import { randomUUID } from 'node:crypto';

import {
  AgentMailApiClient,
  buildAgentMailEmailBody,
} from '@roomote/communication';
import { isEmailChannelEnabled } from '@roomote/env';
import {
  agentmailConversationParticipants,
  agentmailConversations,
  agentmailSuppressions,
  agentmailUserMappings,
  and,
  authUsers,
  db,
  desc,
  eq,
  resolveAgentMailRuntimeCredentials,
  users,
} from '@roomote/db/server';

import { buildAgentMailUnsubscribeUrl } from './email-link-tokens';
import {
  normalizeEmailAddress,
  recordAgentMailOutboundMessage,
} from './conversation-store';

const LOG_PREFIX = '[agentmail-outbound]';

/**
 * Outbound-initiated (transactional) email. The consent invariant lives
 * here, enforced in code rather than call-site discipline: Roomote initiates
 * email only to (a) the recipient's own verified account address or (b) an
 * address they explicitly linked by proving mailbox possession — and never to
 * a suppressed address. Replies within an existing conversation do not pass
 * through this module and are never suppressed.
 */

export type AgentMailSuppressionReason = 'bounce' | 'complaint' | 'unsubscribe';

export async function isAgentMailAddressSuppressed(
  emailAddress: string,
): Promise<boolean> {
  const suppression = await db.query.agentmailSuppressions.findFirst({
    where: eq(
      agentmailSuppressions.emailAddress,
      normalizeEmailAddress(emailAddress),
    ),
    columns: { id: true },
  });
  return Boolean(suppression);
}

/**
 * Sticky, first-reason-wins: a complaint arriving after a bounce (or a repeat
 * delivery of the same webhook) is a no-op, which also makes the webhook
 * processing path idempotent.
 */
export async function suppressAgentMailAddress(input: {
  emailAddress: string;
  reason: AgentMailSuppressionReason;
  details?: string | null;
  providerMessageId?: string | null;
}): Promise<boolean> {
  const inserted = await db
    .insert(agentmailSuppressions)
    .values({
      emailAddress: normalizeEmailAddress(input.emailAddress),
      reason: input.reason,
      details: input.details ?? null,
      providerMessageId: input.providerMessageId ?? null,
    })
    .onConflictDoNothing({ target: agentmailSuppressions.emailAddress })
    .returning({ id: agentmailSuppressions.id });
  return inserted.length > 0;
}

export type AgentMailOutboundAddressResolution =
  | { ok: true; emailAddress: string }
  | { ok: false; reason: 'no_permitted_address' | 'suppressed' };

/**
 * The address Roomote may initiate email to for this user: their verified
 * account email first, then their most recently linked mailbox-possession
 * address. Unverified account emails never qualify.
 */
export async function resolveAgentMailOutboundAddress(
  userId: string,
): Promise<AgentMailOutboundAddressResolution> {
  const candidates: string[] = [];

  const authUser = await db.query.authUsers.findFirst({
    where: and(eq(authUsers.id, userId), eq(authUsers.emailVerified, true)),
    columns: { email: true },
  });
  if (authUser?.email) {
    candidates.push(normalizeEmailAddress(authUser.email));
  }

  const mapping = await db.query.agentmailUserMappings.findFirst({
    where: eq(agentmailUserMappings.userId, userId),
    orderBy: [desc(agentmailUserMappings.createdAt)],
    columns: { emailAddress: true },
  });
  if (mapping) {
    candidates.push(normalizeEmailAddress(mapping.emailAddress));
  }

  if (candidates.length === 0) {
    return { ok: false, reason: 'no_permitted_address' };
  }

  for (const emailAddress of [...new Set(candidates)]) {
    if (!(await isAgentMailAddressSuppressed(emailAddress))) {
      return { ok: true, emailAddress };
    }
  }

  return { ok: false, reason: 'suppressed' };
}

/** Whether an outbound-initiated email to this user could be sent right now. */
export async function canStartAgentMailConversationWithUser(
  userId: string,
): Promise<boolean> {
  if (!isEmailChannelEnabled()) {
    return false;
  }
  const credentials = await resolveAgentMailRuntimeCredentials();
  if (!credentials.apiKey || !credentials.inboxId) {
    return false;
  }
  const resolution = await resolveAgentMailOutboundAddress(userId);
  return resolution.ok;
}

/**
 * The single entry point for Roomote-initiated email. Sends a fresh message
 * (new provider thread) to the user's permitted address with one-click
 * List-Unsubscribe headers, then records the conversation so a reply threads
 * straight back into the normal inbound pipeline — every transactional email
 * is answerable.
 */
export async function startAgentMailConversation(input: {
  userId: string;
  subject: string;
  text: string;
  logContext: string;
  /**
   * Stable logical-send id: retries carrying the same id replay the accepted
   * send at the provider instead of emailing the user twice. Callers with a
   * durable trigger (a webhook delivery, a queued job) should derive it from
   * that trigger; without one, a per-invocation id still makes the client's
   * internal retries (5xx / lost response) exactly-once.
   */
  clientSendId?: string;
}): Promise<boolean> {
  if (!isEmailChannelEnabled()) {
    return false;
  }
  const credentials = await resolveAgentMailRuntimeCredentials();
  if (!credentials.apiKey || !credentials.inboxId) {
    return false;
  }

  const resolution = await resolveAgentMailOutboundAddress(input.userId);
  if (!resolution.ok) {
    if (resolution.reason === 'suppressed') {
      console.warn(
        `${LOG_PREFIX} [${input.logContext}] Not emailing user ${input.userId}: address is suppressed.`,
      );
    }
    return false;
  }

  const inboxId = normalizeEmailAddress(credentials.inboxId);
  const body = buildAgentMailEmailBody(input.text);
  const unsubscribeUrl = buildAgentMailUnsubscribeUrl(resolution.emailAddress);

  let response: { message_id?: string; thread_id?: string };
  try {
    const client = new AgentMailApiClient({ apiKey: credentials.apiKey });
    response = await client.sendMessage(
      inboxId,
      {
        to: [resolution.emailAddress],
        subject: input.subject,
        text: `${body.text}\n\nTo stop receiving these emails: ${unsubscribeUrl}`,
        html: `${body.html}<p style="color:#8a93a3;font-size:12px;margin-top:24px"><a href="${unsubscribeUrl}" style="color:#8a93a3">Stop receiving these emails</a></p>`,
        headers: {
          // RFC 8058 one-click unsubscribe; Gmail and Yahoo require it for
          // sender reputation, and honoring it protects every tenant sharing
          // the sending infrastructure.
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      },
      {
        idempotencyKey: `agentmail:outbound:${input.clientSendId ?? randomUUID()}`,
      },
    );
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} [${input.logContext}] Failed to send email to user ${input.userId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }

  // The email is out; conversation bookkeeping failures must not report the
  // send as failed (a retry would email the user twice).
  try {
    await recordOutboundConversation({
      inboxId,
      userId: input.userId,
      subject: input.subject,
      messageId: response.message_id ?? null,
      providerThreadId: response.thread_id ?? null,
    });
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} [${input.logContext}] Sent email but failed to record its conversation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return true;
}

async function recordOutboundConversation(input: {
  inboxId: string;
  userId: string;
  subject: string;
  messageId: string | null;
  providerThreadId: string | null;
}): Promise<void> {
  if (!input.providerThreadId) {
    return;
  }

  // The recipient must exist as an app user for the participant FK; the
  // resolver only produces addresses for real users, so this is a guard
  // against races, not a normal path.
  const appUser = await db.query.users.findFirst({
    where: eq(users.id, input.userId),
    columns: { id: true },
  });
  if (!appUser) {
    return;
  }

  const conversation = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(agentmailConversations)
      .values({
        inboxId: input.inboxId,
        providerThreadId: input.providerThreadId!,
        ownerUserId: input.userId,
        subject: input.subject,
      })
      .returning();
    if (!created) {
      throw new Error('agentmail conversation insert returned no row');
    }
    await tx.insert(agentmailConversationParticipants).values({
      conversationId: created.id,
      inboxId: input.inboxId,
      providerThreadId: input.providerThreadId!,
      userId: input.userId,
      role: 'owner',
      source: 'outbound',
    });
    return created;
  });

  if (input.messageId) {
    await recordAgentMailOutboundMessage({
      conversationId: conversation.id,
      messageId: input.messageId,
    });
  }
}

export type AgentMailSystemEmailResult =
  | { sent: true }
  | {
      sent: false;
      reason:
        | 'channel_disabled'
        | 'not_configured'
        | 'suppressed'
        | 'send_failed';
    };

/**
 * Account-lifecycle email (verification, password reset): the one kind of
 * outbound email that must be able to reach an address Roomote has NOT yet
 * verified, because it is how the address gets verified. Deliberately
 * narrower than startAgentMailConversation — no unsubscribe link or header
 * (the recipient initiated the action and the mail is not a subscription),
 * no conversation record (a reply has nothing to route to), and only
 * bounce/complaint suppressions apply: an address that unsubscribed from
 * notifications must still be able to verify itself or reset a password.
 */
export async function sendAgentMailSystemEmail(input: {
  to: string;
  subject: string;
  text: string;
  logContext: string;
  clientSendId?: string;
}): Promise<AgentMailSystemEmailResult> {
  if (!isEmailChannelEnabled()) {
    return { sent: false, reason: 'channel_disabled' };
  }
  const credentials = await resolveAgentMailRuntimeCredentials();
  if (!credentials.apiKey || !credentials.inboxId) {
    return { sent: false, reason: 'not_configured' };
  }

  const to = normalizeEmailAddress(input.to);
  const suppression = await db.query.agentmailSuppressions.findFirst({
    where: eq(agentmailSuppressions.emailAddress, to),
    columns: { reason: true },
  });
  if (suppression && suppression.reason !== 'unsubscribe') {
    console.warn(
      `${LOG_PREFIX} [${input.logContext}] Not sending system email to ${to}: address is suppressed (${suppression.reason}).`,
    );
    return { sent: false, reason: 'suppressed' };
  }

  const body = buildAgentMailEmailBody(input.text);
  try {
    const client = new AgentMailApiClient({ apiKey: credentials.apiKey });
    await client.sendMessage(
      normalizeEmailAddress(credentials.inboxId),
      { to: [to], subject: input.subject, text: body.text, html: body.html },
      {
        idempotencyKey: `agentmail:system:${input.clientSendId ?? randomUUID()}`,
      },
    );
    return { sent: true };
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} [${input.logContext}] Failed to send system email to ${to}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { sent: false, reason: 'send_failed' };
  }
}
