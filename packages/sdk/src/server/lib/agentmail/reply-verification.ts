import { createHash, randomBytes } from 'node:crypto';

import type { AgentMailMessage } from '@roomote/communication';
import {
  agentmailConversationParticipants,
  agentmailReplyVerificationProofs,
  and,
  authUsers,
  db,
  eq,
  isNull,
  users,
} from '@roomote/db/server';

import { normalizeEmailAddress } from './conversation-store';

/**
 * Implicit reply verification for Roomote-initiated email. When a
 * Roomote-initiated email goes to an account address that is not yet verified
 * for inbound commands, it carries a random single-use reference token in its
 * footer. A DMARC-passing reply from that exact address on a conversation the
 * account already participates in, quoting the token, proves the mailbox
 * received the mail: the proof is consumed and the canonical
 * `auth_users.email_verified` flag is persisted, after which the reply is
 * processed like any other verified sender's.
 *
 * Provider thread ids and Message-ID references are deliberately NOT proof:
 * they are shared with anyone a thread is forwarded to. The token is the
 * unguessable account-bound reference, and it is validated alongside sender
 * authentication, never instead of it. The proof also never widens authority:
 * it is bound to the user the email was sent to and the exact address it was
 * sent to, so a forwarded thread cannot verify a different account, and
 * unsolicited mail (no participant row on the thread, no token) stays blocked.
 */

export const AGENTMAIL_REPLY_VERIFICATION_TOKEN_PATTERN =
  /rvk_[A-Za-z0-9_-]{32}/g;

const TOKEN_BYTES = 24;
// Generous enough that a notification read weeks later still verifies; expiry
// bounds how long a leaked token stays usable. Manual verification in
// Settings remains available after expiry.
const PROOF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashReplyVerificationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Candidate reference tokens quoted anywhere in a reply. */
function extractAgentMailReplyVerificationTokens(text: string): string[] {
  return text.match(AGENTMAIL_REPLY_VERIFICATION_TOKEN_PATTERN) ?? [];
}

/**
 * Create the reply-verification proof for one Roomote-initiated email and
 * return the footer that carries its token, or null when the recipient's
 * account email is already verified (nothing to prove) or no longer matches
 * the account (nothing safe to prove). The proof row is written before the
 * send; if the send fails the token was never delivered, so the unconsumed
 * row is harmless.
 */
export async function buildAgentMailReplyVerificationFooter(input: {
  userId: string;
  emailAddress: string;
}): Promise<{ textFooter: string; htmlFooter: string } | null> {
  const emailAddress = normalizeEmailAddress(input.emailAddress);
  const authUser = await db.query.authUsers.findFirst({
    where: and(
      eq(authUsers.id, input.userId),
      eq(authUsers.email, emailAddress),
    ),
    columns: { emailVerified: true },
  });
  if (!authUser || authUser.emailVerified) {
    return null;
  }

  const token = `rvk_${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  await db.insert(agentmailReplyVerificationProofs).values({
    userId: input.userId,
    emailAddress,
    tokenHash: hashReplyVerificationToken(token),
    expiresAt: new Date(Date.now() + PROOF_TTL_MS),
  });

  return {
    textFooter: `\n\nReplying to this email verifies this address on your Roomote account (reference: ${token}).`,
    htmlFooter: `<p style="color:#8a93a3;font-size:12px">Replying to this email verifies this address on your Roomote account (reference: ${token}).</p>`,
  };
}

/**
 * Consume a reply-carried proof and verify the sender's account email, or
 * return null when the reply proves nothing. Every gate must pass:
 *
 * - the sender address is an account email that is still unverified, on an
 *   active member (membership loss revokes the privilege with the account);
 * - the account participates in a conversation on this provider thread (the
 *   reply is to a Roomote thread, not unsolicited mail);
 * - the reply quotes a live, unconsumed, unexpired token bound to that exact
 *   (user, address) pair.
 *
 * The verification write is conditional on the account still holding that
 * address unverified, so an address change or a concurrent verification can
 * never be clobbered, and the proof is consumed in the same transaction so a
 * replayed token verifies no one twice.
 */
export async function consumeAgentMailReplyVerification(input: {
  inboxId: string;
  providerThreadId: string;
  senderEmail: string;
  message: AgentMailMessage;
}): Promise<string | null> {
  const senderEmail = normalizeEmailAddress(input.senderEmail);
  const authUser = await db.query.authUsers.findFirst({
    where: and(
      eq(authUsers.email, senderEmail),
      eq(authUsers.emailVerified, false),
    ),
    columns: { id: true },
  });
  if (!authUser) {
    return null;
  }

  const member = await db.query.users.findFirst({
    where: and(eq(users.id, authUser.id), isNull(users.deletedAt)),
    columns: { id: true },
  });
  if (!member) {
    return null;
  }

  const participation =
    await db.query.agentmailConversationParticipants.findFirst({
      where: and(
        eq(
          agentmailConversationParticipants.inboxId,
          normalizeEmailAddress(input.inboxId),
        ),
        eq(
          agentmailConversationParticipants.providerThreadId,
          input.providerThreadId,
        ),
        eq(agentmailConversationParticipants.userId, authUser.id),
      ),
      columns: { id: true },
    });
  if (!participation) {
    return null;
  }

  // Search the full raw bodies, not just the extracted reply text: the token
  // lives in the quoted Roomote footer below the reply.
  const searchable = [
    input.message.text,
    input.message.extracted_text,
    input.message.html,
    input.message.extracted_html,
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n');
  const candidates = extractAgentMailReplyVerificationTokens(searchable);

  for (const token of candidates) {
    const proof = await db.query.agentmailReplyVerificationProofs.findFirst({
      where: eq(
        agentmailReplyVerificationProofs.tokenHash,
        hashReplyVerificationToken(token),
      ),
    });
    if (
      !proof ||
      proof.userId !== authUser.id ||
      proof.emailAddress !== senderEmail ||
      proof.consumedAt ||
      proof.expiresAt.getTime() <= Date.now()
    ) {
      continue;
    }

    const verifiedUserId = await db.transaction(async (tx) => {
      const updated = await tx
        .update(authUsers)
        .set({ emailVerified: true, updatedAt: new Date() })
        .where(
          and(
            eq(authUsers.id, authUser.id),
            eq(authUsers.email, senderEmail),
            eq(authUsers.emailVerified, false),
          ),
        )
        .returning({ id: authUsers.id });
      if (updated.length === 0) {
        return null;
      }
      await tx
        .update(agentmailReplyVerificationProofs)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(agentmailReplyVerificationProofs.id, proof.id),
            isNull(agentmailReplyVerificationProofs.consumedAt),
          ),
        );
      return authUser.id;
    });
    if (verifiedUserId) {
      return verifiedUserId;
    }

    // The conditional write found the address already verified (a concurrent
    // reply beat this one) or changed away. Either state still authorizes
    // this sender through the normal verified path.
    const current = await db.query.authUsers.findFirst({
      where: and(
        eq(authUsers.id, authUser.id),
        eq(authUsers.email, senderEmail),
        eq(authUsers.emailVerified, true),
      ),
      columns: { id: true },
    });
    if (current) {
      return current.id;
    }
  }

  return null;
}
