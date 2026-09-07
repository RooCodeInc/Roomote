import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { db, type DatabaseOrTransaction } from '../db';
import {
  fastAgentConversations,
  fastAgentParentEvents,
  sessions,
  telegramManagedBotCandidates as candidates,
  telegramManagedBotPairings as pairings,
  telegramUserMappings,
  users,
} from '../schema';
import { decrypt } from './encryption';

type Pairing = typeof pairings.$inferSelect;
const pendingStates = ['pending', 'provisioning', 'ready'] as const;
const hashTicket = (ticket: string) =>
  createHash('sha256').update(ticket).digest('hex');

async function ownerValid(tx: DatabaseOrTransaction, row: Pairing) {
  const [owner] = await tx
    .select({ id: telegramUserMappings.userId })
    .from(telegramUserMappings)
    .innerJoin(users, eq(users.id, telegramUserMappings.userId))
    .innerJoin(
      fastAgentConversations,
      eq(fastAgentConversations.id, row.sessionId),
    )
    .leftJoin(sessions, eq(sessions.fastConversationId, row.sessionId))
    .where(
      and(
        eq(telegramUserMappings.telegramUserId, row.ownerTelegramUserId),
        eq(telegramUserMappings.userId, row.ownerUserId),
        isNull(users.deletedAt),
        eq(fastAgentConversations.userId, row.ownerUserId),
        eq(fastAgentConversations.surface, 'telegram'),
        eq(
          fastAgentConversations.workspaceId,
          row.state === 'active'
            ? `telegram-bot:${row.botId}`
            : row.ownerTelegramUserId,
        ),
        eq(
          fastAgentConversations.currentReplyChannelId,
          row.ownerTelegramUserId,
        ),
        ...(row.state === 'active'
          ? [isNull(fastAgentConversations.currentReplyThreadId)]
          : []),
        or(
          isNull(sessions.id),
          and(
            eq(sessions.ownerKind, 'user'),
            eq(sessions.ownerUserId, row.ownerUserId),
          ),
        ),
      ),
    );
  return Boolean(owner);
}

async function lockOwner(tx: DatabaseOrTransaction, owner: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`telegram-managed:${owner}`}, 0))`,
  );
}

async function lockBot(tx: DatabaseOrTransaction, botId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`telegram-managed-bot:${botId}`}, 0))`,
  );
}

export async function beginTelegramManagedBotPairing(input: {
  sessionId?: string;
  ownerUserId: string;
  ownerTelegramUserId: string;
}) {
  return db.transaction(async (tx) => {
    await lockOwner(tx, input.ownerTelegramUserId);
    await tx
      .update(pairings)
      .set({ state: 'revoked', ticket: null, ticketHash: null })
      .where(
        and(
          eq(pairings.ownerTelegramUserId, input.ownerTelegramUserId),
          inArray(pairings.state, pendingStates),
          sql`${pairings.expiresAt} <= now()`,
        ),
      );
    const [existing] = await tx
      .select()
      .from(pairings)
      .where(
        and(
          eq(pairings.ownerTelegramUserId, input.ownerTelegramUserId),
          inArray(pairings.state, pendingStates),
        ),
      );
    if (existing)
      return existing.ownerUserId === input.ownerUserId &&
        (await ownerValid(tx, existing))
        ? { pairing: existing, existing: true }
        : null;
    const [conversation] = await tx
      .select()
      .from(fastAgentConversations)
      .where(
        input.sessionId
          ? eq(fastAgentConversations.id, input.sessionId)
          : and(
              eq(fastAgentConversations.surface, 'telegram'),
              eq(fastAgentConversations.workspaceId, input.ownerTelegramUserId),
              eq(
                fastAgentConversations.conversationId,
                `${input.ownerTelegramUserId}:user:${input.ownerUserId}`,
              ),
            ),
      )
      .for('update');
    if (
      !conversation ||
      conversation.surface !== 'telegram' ||
      conversation.userId !== input.ownerUserId ||
      conversation.workspaceId !== input.ownerTelegramUserId ||
      conversation.currentReplyChannelId !== input.ownerTelegramUserId
    )
      return null;
    const [row] = await tx
      .insert(pairings)
      .values({
        sessionId: conversation.id,
        ownerUserId: input.ownerUserId,
        ownerTelegramUserId: input.ownerTelegramUserId,
        state: 'pending',
        webhookSecret: randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 15 * 60_000),
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return null;
    if (!(await ownerValid(tx, row)))
      throw new Error('Managed bot owner mismatch');
    return { pairing: row, existing: false };
  });
}

export async function recordTelegramManagedBotCandidate(input: {
  ownerTelegramUserId: string;
  botId: string;
  botUsername: string | null;
  managementUpdateId?: number;
}) {
  return db.transaction(async (tx) => {
    await lockOwner(tx, input.ownerTelegramUserId);
    await lockBot(tx, input.botId);
    const [observed] = await tx
      .select()
      .from(candidates)
      .where(eq(candidates.botId, input.botId))
      .for('update');
    if (observed) {
      const changed =
        observed.ownerTelegramUserId !== input.ownerTelegramUserId ||
        (input.managementUpdateId !== undefined &&
          observed.managementUpdateId !== null &&
          observed.managementUpdateId !== input.managementUpdateId);
      if (observed.revoked || changed) {
        await tx
          .update(candidates)
          .set({ revoked: true })
          .where(eq(candidates.id, observed.id));
        if (observed.pairingId)
          await tx
            .update(pairings)
            .set({ state: 'revoked', ticket: null, ticketHash: null })
            .where(
              and(
                eq(pairings.id, observed.pairingId),
                eq(pairings.botId, input.botId),
              ),
            );
        return null;
      }
      if (
        input.managementUpdateId !== undefined &&
        observed.managementUpdateId === null
      )
        await tx
          .update(candidates)
          .set({ managementUpdateId: input.managementUpdateId })
          .where(eq(candidates.id, observed.id));
    }
    const [pairing] = await tx
      .select()
      .from(pairings)
      .where(
        and(
          eq(pairings.ownerTelegramUserId, input.ownerTelegramUserId),
          eq(pairings.state, 'pending'),
          sql`${pairings.expiresAt} > now()`,
        ),
      )
      .for('update');
    const eligible =
      pairing && (await ownerValid(tx, pairing)) ? pairing : null;
    // The first observation pins the bot to a request (or to no request).
    // Replayed creation events cannot offer an old bot for a later Session.
    if (!observed)
      await tx.insert(candidates).values({
        pairingId: eligible?.id ?? null,
        botId: input.botId,
        botUsername: input.botUsername,
        ownerTelegramUserId: input.ownerTelegramUserId,
        managementUpdateId: input.managementUpdateId ?? null,
      });
    if (!eligible || (observed && observed.pairingId !== eligible.id))
      return null;
    if (input.botUsername)
      await tx
        .update(candidates)
        .set({ botUsername: input.botUsername })
        .where(eq(candidates.botId, input.botId));
    const [candidate] = await tx
      .select()
      .from(candidates)
      .where(
        and(
          eq(candidates.pairingId, eligible.id),
          eq(candidates.botId, input.botId),
        ),
      );
    return candidate?.botUsername && candidate.managementUpdateId !== null
      ? { pairing: eligible, candidate }
      : null;
  });
}

export async function selectTelegramManagedBotCandidate(
  candidateId: string,
  ownerTelegramUserId: string,
) {
  return db.transaction(async (tx) => {
    await lockOwner(tx, ownerTelegramUserId);
    const [identity] = await tx
      .select({ botId: candidates.botId })
      .from(candidates)
      .where(eq(candidates.id, candidateId));
    if (!identity) return null;
    await lockBot(tx, identity.botId);
    const [candidate] = await tx
      .select()
      .from(candidates)
      .where(eq(candidates.id, candidateId));
    if (
      !candidate ||
      candidate.revoked ||
      !candidate.pairingId ||
      !candidate.botUsername ||
      candidate.managementUpdateId === null ||
      candidate.ownerTelegramUserId !== ownerTelegramUserId
    )
      return null;
    const [row] = await tx
      .select()
      .from(pairings)
      .where(eq(pairings.id, candidate.pairingId))
      .for('update');
    if (
      !row ||
      row.ownerTelegramUserId !== ownerTelegramUserId ||
      row.expiresAt <= new Date() ||
      !pendingStates.includes(row.state as (typeof pendingStates)[number]) ||
      !(await ownerValid(tx, row)) ||
      (row.botId && row.botId !== candidate.botId)
    )
      return null;
    if (row.state === 'pending') {
      const [selected] = await tx
        .update(pairings)
        .set({
          state: 'provisioning',
          botId: candidate.botId,
          botUsername: candidate.botUsername,
        })
        .where(eq(pairings.id, row.id))
        .returning();
      return selected ?? null;
    }
    return row;
  });
}

// Serialize provisioning across webhook retries. Selection is committed first, so
// external failures can retry only that explicitly confirmed bot, never another.
export async function provisionTelegramManagedBot(
  pairingId: string,
  ownerTelegramUserId: string,
  provision: (input: {
    botId: string;
    webhookSecret: string;
  }) => Promise<{ botToken: string; botUsername: string }>,
) {
  return db.transaction(async (tx) => {
    await lockOwner(tx, ownerTelegramUserId);
    const [identity] = await tx
      .select({ botId: pairings.botId })
      .from(pairings)
      .where(eq(pairings.id, pairingId));
    if (!identity?.botId) return null;
    await lockBot(tx, identity.botId);
    const [row] = await tx
      .select()
      .from(pairings)
      .where(eq(pairings.id, pairingId))
      .for('update');
    if (
      !row ||
      row.ownerTelegramUserId !== ownerTelegramUserId ||
      row.expiresAt <= new Date() ||
      !row.botId ||
      !row.webhookSecret ||
      !(await ownerValid(tx, row))
    )
      return null;
    if (row.state === 'ready' && row.ticket)
      return { botUsername: row.botUsername!, ticket: decrypt(row.ticket) };
    if (row.state !== 'provisioning') return null;
    const credentials = await provision({
      botId: row.botId,
      webhookSecret: decrypt(row.webhookSecret),
    });
    if (row.expiresAt <= new Date() || !(await ownerValid(tx, row)))
      return null;
    const ticket = randomBytes(32).toString('base64url');
    await tx
      .update(pairings)
      .set({
        state: 'ready',
        botToken: credentials.botToken,
        botUsername: credentials.botUsername,
        ticket,
        ticketHash: hashTicket(ticket),
        expiresAt: new Date(
          Math.min(row.expiresAt.getTime(), Date.now() + 5 * 60_000),
        ),
      })
      .where(eq(pairings.id, row.id));
    return { botUsername: credentials.botUsername, ticket };
  });
}

export async function getTelegramManagedBotRoute(botId: string) {
  const [row] = await db
    .select()
    .from(pairings)
    .where(
      and(
        eq(pairings.botId, botId),
        inArray(pairings.state, ['ready', 'active']),
      ),
    );
  if (
    !row ||
    !row.botToken ||
    !row.webhookSecret ||
    (row.state !== 'active' && row.expiresAt <= new Date()) ||
    !(await ownerValid(db, row))
  )
    return null;
  return {
    ...row,
    botToken: decrypt(row.botToken),
    webhookSecret: decrypt(row.webhookSecret),
  };
}

export async function activateTelegramManagedBot(
  botId: string,
  ownerTelegramUserId: string,
  ticket: string,
) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
  return db.transaction(async (tx) => {
    await lockOwner(tx, ownerTelegramUserId);
    await lockBot(tx, botId);
    const [row] = await tx
      .select()
      .from(pairings)
      .where(and(eq(pairings.botId, botId), eq(pairings.state, 'ready')))
      .for('update');
    if (
      !row ||
      row.ownerTelegramUserId !== ownerTelegramUserId ||
      row.expiresAt <= new Date() ||
      row.ticketHash !== hashTicket(ticket) ||
      !(await ownerValid(tx, row))
    )
      return null;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`fast-agent-conversation:${row.sessionId}`}, 0))`,
    );
    const [conversation] = await tx
      .select()
      .from(fastAgentConversations)
      .where(eq(fastAgentConversations.id, row.sessionId))
      .for('update');
    if (
      !conversation ||
      conversation.userId !== row.ownerUserId ||
      conversation.surface !== 'telegram' ||
      conversation.workspaceId !== ownerTelegramUserId ||
      conversation.currentReplyChannelId !== ownerTelegramUserId
    )
      return null;
    const [pending] = await tx
      .select({ id: fastAgentParentEvents.id })
      .from(fastAgentParentEvents)
      .where(
        and(
          eq(fastAgentParentEvents.conversationId, row.sessionId),
          isNull(fastAgentParentEvents.deliveredAt),
          isNull(fastAgentParentEvents.discardedAt),
        ),
      )
      .limit(1);
    const [responding] = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.fastConversationId, row.sessionId),
          sql`${sessions.respondingUntil} > now()`,
        ),
      )
      .limit(1);
    if (pending || responding) return null;
    await tx
      .update(fastAgentConversations)
      .set({
        workspaceId: `telegram-bot:${botId}`,
        currentReplyChannelId: ownerTelegramUserId,
        currentReplyThreadId: null,
        currentReplyServiceUrl: null,
        replyTargetVerified: true,
        updatedAt: new Date(),
      })
      .where(eq(fastAgentConversations.id, row.sessionId));
    await tx
      .update(pairings)
      .set({ state: 'active', ticket: null, ticketHash: null })
      .where(eq(pairings.id, row.id));
    return row.sessionId;
  });
}

export async function disconnectTelegramManagedBot(
  botId: string,
  ownerTelegramUserId: string,
) {
  return db.transaction(async (tx) => {
    await lockOwner(tx, ownerTelegramUserId);
    await lockBot(tx, botId);
    const [row] = await tx
      .select()
      .from(pairings)
      .where(
        and(
          eq(pairings.botId, botId),
          eq(pairings.ownerTelegramUserId, ownerTelegramUserId),
          ne(pairings.state, 'revoked'),
        ),
      )
      .for('update');
    if (!row || !(await ownerValid(tx, row))) return false;
    const rows = await tx
      .update(pairings)
      .set({ state: 'revoked', ticket: null, ticketHash: null })
      .where(
        and(
          eq(pairings.botId, botId),
          eq(pairings.ownerTelegramUserId, ownerTelegramUserId),
          ne(pairings.state, 'revoked'),
        ),
      )
      .returning({ id: pairings.id });
    // Deliberately retain the namespace: disconnected sessions cannot use the main token.
    return rows.length > 0;
  });
}

export async function resolveTelegramManagedBotCredentials(
  workspaceId: string,
): Promise<{
  botToken: string;
  botId: string;
  ownerTelegramUserId: string;
  sessionId: string;
} | null> {
  const match = /^telegram-bot:([1-9][0-9]*)$/.exec(workspaceId);
  if (!match) return null;
  const row = await getTelegramManagedBotRoute(match[1]!);
  if (!row || row.state !== 'active') return null;
  return {
    botToken: row.botToken,
    botId: match[1]!,
    ownerTelegramUserId: row.ownerTelegramUserId,
    sessionId: row.sessionId,
  };
}
