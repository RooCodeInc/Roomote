import {
  agentmailConversationParticipants,
  agentmailConversations,
  agentmailUserMappings,
  and,
  authUsers,
  db,
  eq,
  inArray,
  sql,
  users,
} from '@roomote/db/server';

export type AgentMailConversationRow =
  typeof agentmailConversations.$inferSelect;

export type AgentMailReplyRouteData = {
  inboxId: string;
  replyToMessageId: string | null;
  recipientEmail: string | null;
  subject: string | null;
};

export function normalizeEmailAddress(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Resolve a sender address to a user id: verified auth_users emails first,
 * then explicit link-code mappings. Unverified account emails never match.
 */
export async function resolveAgentMailSenderUserId(
  senderEmail: string,
): Promise<string | null> {
  const normalized = normalizeEmailAddress(senderEmail);

  // Verified emails live on Better Auth's auth_users; the app users table
  // shares its id. Only a verified address matches automatically.
  const verifiedAuthUser = await db.query.authUsers.findFirst({
    where: and(
      eq(authUsers.email, normalized),
      eq(authUsers.emailVerified, true),
    ),
    columns: { id: true },
  });
  if (verifiedAuthUser) {
    const appUser = await db.query.users.findFirst({
      where: eq(users.id, verifiedAuthUser.id),
      columns: { id: true },
    });
    if (appUser) {
      return appUser.id;
    }
  }

  const mapping = await db.query.agentmailUserMappings.findFirst({
    where: eq(agentmailUserMappings.emailAddress, normalized),
    columns: { userId: true },
  });

  return mapping?.userId ?? null;
}

/**
 * The durable reply route for a conversation. Replies target the latest
 * inbound message and address the latest authorized sender only; the adapter
 * reads this at send time and never trusts caller-supplied values.
 */
export async function resolveAgentMailReplyRoute(
  conversationId: string,
): Promise<AgentMailReplyRouteData | null> {
  const conversation = await db.query.agentmailConversations.findFirst({
    where: eq(agentmailConversations.id, conversationId),
    columns: {
      inboxId: true,
      latestInboundMessageId: true,
      latestInboundSenderEmail: true,
      subject: true,
    },
  });

  if (!conversation) {
    return null;
  }

  return {
    inboxId: conversation.inboxId,
    replyToMessageId: conversation.latestInboundMessageId,
    recipientEmail: conversation.latestInboundSenderEmail,
    subject: conversation.subject,
  };
}

/**
 * Advance the inbound anchor. Inbound and outbound anchors are separate
 * columns so an in-flight send can never overwrite this, and the guard is the
 * total order (latest_inbound_at, latest_inbound_message_id) so out-of-order
 * webhook deliveries and same-timestamp messages resolve deterministically.
 * Returns true when the anchor advanced (false = an equal-or-newer message
 * already holds it, which is fine).
 */
export async function advanceAgentMailInboundAnchor(input: {
  conversationId: string;
  messageId: string;
  providerTimestamp: Date;
  senderEmail: string;
  senderUserId: string | null;
}): Promise<boolean> {
  const timestampIso = input.providerTimestamp.toISOString();
  const updated = await db
    .update(agentmailConversations)
    .set({
      latestInboundMessageId: input.messageId,
      latestInboundAt: input.providerTimestamp,
      latestInboundSenderEmail: normalizeEmailAddress(input.senderEmail),
      latestInboundUserId: input.senderUserId,
      version: sql`${agentmailConversations.version} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentmailConversations.id, input.conversationId),
        sql`(
          ${agentmailConversations.latestInboundAt} IS NULL
          OR (${agentmailConversations.latestInboundAt}, ${agentmailConversations.latestInboundMessageId})
             < (${timestampIso}::timestamp, ${input.messageId})
        )`,
      ),
    )
    .returning({ id: agentmailConversations.id });

  return updated.length > 0;
}

/** Record a completed outbound send. Never touches the inbound anchor. */
export async function recordAgentMailOutboundMessage(input: {
  conversationId: string;
  messageId: string;
}): Promise<void> {
  await db
    .update(agentmailConversations)
    .set({
      latestOutboundMessageId: input.messageId,
      version: sql`${agentmailConversations.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(agentmailConversations.id, input.conversationId));
}

type AgentMailConversationResolution = {
  conversation: AgentMailConversationRow;
  created: boolean;
  joinedAsCc: boolean;
};

/**
 * Deterministic sender → conversation resolution, never "first database row":
 *
 * 1. The sender is already a participant of a conversation on this provider
 *    thread → that conversation (unique by the participant-table invariant).
 * 2. No match, but exactly one existing conversation's participants intersect
 *    the inbound to/cc identities → join it as a cc participant.
 * 3. Zero or multiple candidates → create an isolated fork owned by the
 *    sender. Forwarding never grants access to an existing conversation.
 *
 * Creation runs conversation + owner participant in one transaction; the
 * unique (inbox_id, provider_thread_id, user_id) participant index turns a
 * simultaneous double-create into an insert conflict, and the loser retries
 * resolution from the top, finding the winner's conversation.
 */
export async function resolveOrCreateAgentMailConversation(input: {
  inboxId: string;
  providerThreadId: string;
  senderUserId: string;
  subject: string | null;
  /** Normalized to/cc addresses of the inbound message, sender excluded. */
  recipientAddresses: string[];
}): Promise<AgentMailConversationResolution> {
  const inboxId = normalizeEmailAddress(input.inboxId);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const senderMembership =
      await db.query.agentmailConversationParticipants.findFirst({
        where: and(
          eq(agentmailConversationParticipants.inboxId, inboxId),
          eq(
            agentmailConversationParticipants.providerThreadId,
            input.providerThreadId,
          ),
          eq(agentmailConversationParticipants.userId, input.senderUserId),
        ),
        columns: { conversationId: true },
      });

    if (senderMembership) {
      const conversation = await db.query.agentmailConversations.findFirst({
        where: eq(agentmailConversations.id, senderMembership.conversationId),
      });
      if (conversation) {
        return { conversation, created: false, joinedAsCc: false };
      }
    }

    const ccCandidate = await findSingleCcJoinCandidate({
      inboxId,
      providerThreadId: input.providerThreadId,
      recipientAddresses: input.recipientAddresses,
    });

    if (ccCandidate) {
      try {
        await db.insert(agentmailConversationParticipants).values({
          conversationId: ccCandidate.id,
          inboxId,
          providerThreadId: input.providerThreadId,
          userId: input.senderUserId,
          role: 'participant',
          source: 'cc',
        });
        return {
          conversation: ccCandidate,
          created: false,
          joinedAsCc: true,
        };
      } catch (error) {
        if (isUniqueViolation(error)) {
          continue;
        }
        throw error;
      }
    }

    try {
      const conversation = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(agentmailConversations)
          .values({
            inboxId,
            providerThreadId: input.providerThreadId,
            ownerUserId: input.senderUserId,
            subject: input.subject,
          })
          .returning();
        if (!created) {
          throw new Error('agentmail conversation insert returned no row');
        }
        await tx.insert(agentmailConversationParticipants).values({
          conversationId: created.id,
          inboxId,
          providerThreadId: input.providerThreadId,
          userId: input.senderUserId,
          role: 'owner',
          source: 'initiator',
        });
        return created;
      });
      return { conversation, created: true, joinedAsCc: false };
    } catch (error) {
      if (isUniqueViolation(error)) {
        // A concurrent first message from the same sender won the race;
        // retry resolution and find their conversation.
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    'agentmail conversation resolution did not converge after retry',
  );
}

/**
 * Step 2 of resolution: the single conversation on this thread whose
 * participant set intersects the inbound to/cc identities, or null when zero
 * or multiple qualify (ambiguity always forks).
 */
async function findSingleCcJoinCandidate(input: {
  inboxId: string;
  providerThreadId: string;
  recipientAddresses: string[];
}): Promise<AgentMailConversationRow | null> {
  const addresses = input.recipientAddresses
    .map(normalizeEmailAddress)
    .filter((address) => address && address !== input.inboxId);

  if (addresses.length === 0) {
    return null;
  }

  const recipientUsers = await db.query.authUsers.findMany({
    where: and(
      inArray(authUsers.email, addresses),
      eq(authUsers.emailVerified, true),
    ),
    columns: { id: true },
  });
  const mappedUsers = await db.query.agentmailUserMappings.findMany({
    where: inArray(agentmailUserMappings.emailAddress, addresses),
    columns: { userId: true },
  });
  const recipientUserIds = new Set([
    ...recipientUsers.map((user) => user.id),
    ...mappedUsers.map((mapping) => mapping.userId),
  ]);

  if (recipientUserIds.size === 0) {
    return null;
  }

  const memberships = await db.query.agentmailConversationParticipants.findMany(
    {
      where: and(
        eq(agentmailConversationParticipants.inboxId, input.inboxId),
        eq(
          agentmailConversationParticipants.providerThreadId,
          input.providerThreadId,
        ),
      ),
      columns: { conversationId: true, userId: true },
    },
  );

  const candidateConversationIds = new Set(
    memberships
      .filter((membership) => recipientUserIds.has(membership.userId))
      .map((membership) => membership.conversationId),
  );

  if (candidateConversationIds.size !== 1) {
    return null;
  }

  const [conversationId] = candidateConversationIds;
  const conversation = await db.query.agentmailConversations.findFirst({
    where: eq(agentmailConversations.id, conversationId!),
  });

  return conversation ?? null;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } }).code;
  const causeCode = (error as { cause?: { code?: string } }).cause?.code;
  return code === '23505' || causeCode === '23505';
}
