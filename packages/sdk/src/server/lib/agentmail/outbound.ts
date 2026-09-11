import { createHash, randomUUID } from 'node:crypto';

import {
  AgentMailApiClient,
  buildAgentMailEmailBody,
} from '@roomote/communication';
import { isEmailChannelEnabled } from '@roomote/env';
import {
  agentmailConversationParticipants,
  agentmailConversations,
  agentmailSuppressions,
  and,
  authUsers,
  db,
  eq,
  isNull,
  resolveAgentMailRuntimeCredentials,
  users,
} from '@roomote/db/server';

import { buildAgentMailUnsubscribeUrl } from './unsubscribe-tokens';
import {
  isUniqueViolation,
  normalizeEmailAddress,
  recordAgentMailOutboundMessage,
} from './conversation-store';

const LOG_PREFIX = '[agentmail-outbound]';

/**
 * Outbound-initiated (transactional) email. The consent invariant lives
 * here, enforced in code rather than call-site discipline: Roomote initiates
 * email only to the recipient's own verified account address, and never to a
 * suppressed address. Replies within an existing conversation do not pass
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
  | {
      ok: false;
      reason: 'no_active_member' | 'no_permitted_address' | 'suppressed';
    };

export type AgentMailOutboundIdentity = {
  id: string;
  emailAddress: string;
  kind: 'verified';
};

/** Thrown when a stored conversation's consented recipient is no longer eligible. */
export class AgentMailRecipientUnavailableError extends Error {
  readonly conversationId: string;
  readonly reason: Exclude<
    AgentMailOutboundAddressResolution,
    { ok: true }
  >['reason'];

  constructor(
    conversationId: string,
    reason: Exclude<AgentMailOutboundAddressResolution, { ok: true }>['reason'],
  ) {
    super(
      `AgentMail conversation ${conversationId} cannot be delivered: the selected recipient identity is no longer eligible (${reason}).`,
    );
    this.name = 'AgentMailRecipientUnavailableError';
    this.conversationId = conversationId;
    this.reason = reason;
  }
}

function buildVerifiedEmailIdentityId(userId: string, emailAddress: string) {
  const digest = createHash('sha256')
    .update(normalizeEmailAddress(emailAddress))
    .digest('hex')
    .slice(0, 24);
  return `verified:${userId}:${digest}`;
}

async function findActiveMember(userId: string): Promise<boolean> {
  const member = await db.query.users.findFirst({
    where: and(eq(users.id, userId), isNull(users.deletedAt)),
    columns: { id: true },
  });
  return Boolean(member);
}

/**
 * The user's explicitly verified account email as a selectable identity, or
 * why there is none. Shared by the identity list (which hides the reason) and
 * the exact-identity resolver (which reports it).
 */
async function resolveVerifiedAccountIdentity(
  userId: string,
): Promise<
  | { status: 'ok'; identity: AgentMailOutboundIdentity }
  | { status: 'no_active_member' | 'no_permitted_address' | 'suppressed' }
> {
  if (!(await findActiveMember(userId))) {
    return { status: 'no_active_member' };
  }
  const authUser = await db.query.authUsers.findFirst({
    where: and(eq(authUsers.id, userId), eq(authUsers.emailVerified, true)),
    columns: { email: true },
  });
  if (!authUser?.email) {
    return { status: 'no_permitted_address' };
  }
  const emailAddress = normalizeEmailAddress(authUser.email);
  if (await isAgentMailAddressSuppressed(emailAddress)) {
    return { status: 'suppressed' };
  }
  return {
    status: 'ok',
    identity: {
      id: buildVerifiedEmailIdentityId(userId, emailAddress),
      emailAddress,
      kind: 'verified',
    },
  };
}

export async function listAgentMailOutboundIdentities(
  userId: string,
): Promise<AgentMailOutboundIdentity[]> {
  const resolved = await resolveVerifiedAccountIdentity(userId);
  return resolved.status === 'ok' ? [resolved.identity] : [];
}

/**
 * The identities a user could pick as an automation destination right now:
 * empty when the email channel is disabled or unconfigured, so callers need
 * neither a separate availability probe nor a second pass over the same rows.
 */
export async function listAvailableAgentMailOutboundIdentities(
  userId: string,
): Promise<AgentMailOutboundIdentity[]> {
  if (!isEmailChannelEnabled()) {
    return [];
  }
  const credentials = await resolveAgentMailRuntimeCredentials();
  if (!credentials.apiKey || !credentials.inboxId) {
    return [];
  }
  return listAgentMailOutboundIdentities(userId);
}

export async function resolveAgentMailOutboundIdentity(
  userId: string,
  identityId: string,
): Promise<AgentMailOutboundAddressResolution> {
  const resolved = await resolveVerifiedAccountIdentity(userId);
  if (resolved.status !== 'ok') {
    return { ok: false, reason: resolved.status };
  }
  return resolved.identity.id === identityId
    ? { ok: true, emailAddress: resolved.identity.emailAddress }
    : { ok: false, reason: 'no_permitted_address' };
}

/**
 * The consented recipient for an outbound send: the exact pinned identity when
 * one was selected, otherwise the user's best permitted address.
 */
export async function resolveAgentMailOutboundRecipient(
  userId: string,
  identityId?: string | null,
): Promise<AgentMailOutboundAddressResolution> {
  return identityId
    ? resolveAgentMailOutboundIdentity(userId, identityId)
    : resolveAgentMailOutboundAddress(userId);
}

/**
 * The address Roomote may initiate email to for this user: their verified
 * account email. Unverified account emails never qualify.
 */
export async function resolveAgentMailOutboundAddress(
  userId: string,
): Promise<AgentMailOutboundAddressResolution> {
  if (!(await findActiveMember(userId))) {
    return { ok: false, reason: 'no_active_member' };
  }

  const authUser = await db.query.authUsers.findFirst({
    where: and(eq(authUsers.id, userId), eq(authUsers.emailVerified, true)),
    columns: { email: true },
  });
  if (!authUser?.email) {
    return { ok: false, reason: 'no_permitted_address' };
  }

  const emailAddress = normalizeEmailAddress(authUser.email);
  if (await isAgentMailAddressSuppressed(emailAddress)) {
    return { ok: false, reason: 'suppressed' };
  }
  return { ok: true, emailAddress };
}

/** Whether an outbound-initiated email to this user could be sent right now. */
export async function canStartAgentMailConversationWithUser(
  userId: string,
  identityId?: string,
): Promise<boolean> {
  if (!isEmailChannelEnabled()) {
    return false;
  }
  const credentials = await resolveAgentMailRuntimeCredentials();
  if (!credentials.apiKey || !credentials.inboxId) {
    return false;
  }
  const resolution = await resolveAgentMailOutboundRecipient(
    userId,
    identityId,
  );
  return resolution.ok;
}

/**
 * The single entry point for Roomote-initiated email. Sends a fresh message
 * (new provider thread) to the user's permitted address with one-click
 * List-Unsubscribe headers, then records the conversation so a reply threads
 * straight back into the normal inbound pipeline — every transactional email
 * is answerable.
 */
export type StartAgentMailConversationResult =
  | { sent: false }
  | {
      sent: true;
      conversation: {
        conversationId: string;
        inboxId: string;
        messageId: string | null;
      } | null;
    };

/** Reserve a replyable conversation without sending its first email yet. */
export async function prepareAgentMailConversation(input: {
  userId: string;
  identityId: string;
  subject: string;
  conversationKey: string;
}): Promise<{
  conversationId: string;
  inboxId: string;
  messageId: null;
} | null> {
  if (!isEmailChannelEnabled()) return null;
  const credentials = await resolveAgentMailRuntimeCredentials();
  if (!credentials.apiKey || !credentials.inboxId) return null;
  const resolution = await resolveAgentMailOutboundIdentity(
    input.userId,
    input.identityId,
  );
  if (!resolution.ok) return null;

  const inboxId = normalizeEmailAddress(credentials.inboxId);
  const providerThreadId = `pending:${createHash('sha256')
    .update(input.conversationKey)
    .digest('hex')}`;
  const existing = await db.query.agentmailConversations.findFirst({
    where: and(
      eq(agentmailConversations.inboxId, inboxId),
      eq(agentmailConversations.providerThreadId, providerThreadId),
      eq(agentmailConversations.ownerUserId, input.userId),
    ),
    columns: { id: true },
  });
  if (existing) {
    return { conversationId: existing.id, inboxId, messageId: null };
  }

  const [conversation] = await db
    .insert(agentmailConversations)
    .values({
      inboxId,
      providerThreadId,
      ownerUserId: input.userId,
      outboundIdentityId: input.identityId,
      subject: input.subject,
    })
    .returning({ id: agentmailConversations.id });
  return conversation
    ? { conversationId: conversation.id, inboxId, messageId: null }
    : null;
}

export async function startAgentMailConversationWithResult(input: {
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
  /** A specific server-issued verified identity; never a raw address. */
  identityId?: string;
}): Promise<StartAgentMailConversationResult> {
  if (!isEmailChannelEnabled()) {
    return { sent: false };
  }
  const credentials = await resolveAgentMailRuntimeCredentials();
  if (!credentials.apiKey || !credentials.inboxId) {
    return { sent: false };
  }

  const resolution = await resolveAgentMailOutboundRecipient(
    input.userId,
    input.identityId,
  );
  if (!resolution.ok) {
    if (resolution.reason === 'suppressed') {
      console.warn(
        `${LOG_PREFIX} [${input.logContext}] Not emailing user ${input.userId}: address is suppressed.`,
      );
    }
    return { sent: false };
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
    return { sent: false };
  }

  let conversation: Awaited<ReturnType<typeof recordOutboundConversation>> =
    null;
  try {
    conversation = await recordOutboundConversation({
      inboxId,
      userId: input.userId,
      subject: input.subject,
      messageId: response.message_id ?? null,
      providerThreadId: response.thread_id ?? null,
      outboundIdentityId: input.identityId ?? null,
    });
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} [${input.logContext}] Sent email but failed to record its conversation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return { sent: true, conversation };
}

export async function startAgentMailConversation(
  input: Parameters<typeof startAgentMailConversationWithResult>[0],
): Promise<boolean> {
  return (await startAgentMailConversationWithResult(input)).sent;
}

async function recordOutboundConversation(input: {
  inboxId: string;
  userId: string;
  subject: string;
  messageId: string | null;
  providerThreadId: string | null;
  outboundIdentityId: string | null;
}): Promise<{
  conversationId: string;
  inboxId: string;
  messageId: string | null;
} | null> {
  if (!input.providerThreadId) {
    return null;
  }

  // The recipient must exist as an app user for the participant FK; the
  // resolver only produces addresses for real users, so this is a guard
  // against races, not a normal path.
  const appUser = await db.query.users.findFirst({
    where: eq(users.id, input.userId),
    columns: { id: true },
  });
  if (!appUser) {
    return null;
  }

  let conversation: { id: string } | undefined;
  try {
    conversation = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(agentmailConversations)
        .values({
          inboxId: input.inboxId,
          providerThreadId: input.providerThreadId!,
          ownerUserId: input.userId,
          outboundIdentityId: input.outboundIdentityId,
          subject: input.subject,
        })
        .returning({ id: agentmailConversations.id });
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
  } catch (error) {
    // Only a replayed send (same provider thread already recorded) is
    // recoverable here; anything else is a real failure to surface.
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const existing = await db.query.agentmailConversationParticipants.findFirst(
      {
        where: and(
          eq(agentmailConversationParticipants.inboxId, input.inboxId),
          eq(
            agentmailConversationParticipants.providerThreadId,
            input.providerThreadId,
          ),
          eq(agentmailConversationParticipants.userId, input.userId),
        ),
        columns: { conversationId: true },
      },
    );
    if (!existing) {
      throw error;
    }
    conversation = { id: existing.conversationId };
  }

  if (input.messageId) {
    await recordAgentMailOutboundMessage({
      conversationId: conversation.id,
      messageId: input.messageId,
    });
  }
  return {
    conversationId: conversation.id,
    inboxId: input.inboxId,
    messageId: input.messageId,
  };
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
