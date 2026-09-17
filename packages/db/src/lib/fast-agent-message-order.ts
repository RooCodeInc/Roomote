import { and, asc, eq, isNull, max, sql } from 'drizzle-orm';

import type { DatabaseOrTransaction } from '../db';
import { fastAgentMessages } from '../schema';

export async function lockFastAgentConversation(
  database: DatabaseOrTransaction,
  conversationId: string,
): Promise<void> {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`fast-agent-conversation:${conversationId}`}, 0))`,
  );
}

/** Allocate canonical admission order while the conversation lock is held. */
export async function allocateFastAgentConversationSequence(
  database: DatabaseOrTransaction,
  conversationId: string,
): Promise<number> {
  await lockFastAgentConversation(database, conversationId);
  const [row] = await database
    .select({ value: max(fastAgentMessages.conversationSeq) })
    .from(fastAgentMessages)
    .where(eq(fastAgentMessages.conversationId, conversationId));
  let next = Number(row?.value ?? 0) + 1;
  // During the N-1 window an older binary can still insert a null sequence.
  // Repair those rows under the same lock before admitting the new event.
  const legacyRows = await database
    .select({ id: fastAgentMessages.id })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, conversationId),
        isNull(fastAgentMessages.conversationSeq),
      ),
    )
    .orderBy(
      asc(fastAgentMessages.createdAt),
      asc(fastAgentMessages.ts),
      asc(fastAgentMessages.turnSeq),
      asc(fastAgentMessages.id),
    );
  for (const legacy of legacyRows) {
    await database
      .update(fastAgentMessages)
      .set({ conversationSeq: next })
      .where(
        and(
          eq(fastAgentMessages.id, legacy.id),
          isNull(fastAgentMessages.conversationSeq),
        ),
      );
    next += 1;
  }
  return next;
}
