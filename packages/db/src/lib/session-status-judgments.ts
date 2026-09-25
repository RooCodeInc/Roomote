import { and, desc, eq, inArray, lt, max, or, sql } from 'drizzle-orm';

import type { SessionStatusJudgmentOutcome } from '@roomote/types';

import type { DatabaseOrTransaction } from '../db';
import {
  sessionStatusJudgments,
  sessions,
  type SessionStatusJudgmentSourceKind,
  type SessionStatusJudgmentState,
} from '../schema';
import { runInTransactionIfAvailable } from './transaction-utils';
import { isDeploymentExperimentEnabled } from './deployment-experiments';

const CLAIM_LEASE_MS = 2 * 60 * 1_000;
export const MAX_SESSION_STATUS_JUDGMENT_ATTEMPTS = 5;

export async function createSessionStatusJudgmentRequest(
  database: DatabaseOrTransaction,
  input: {
    sessionId: string;
    sourceEventId: string;
    sourceKind: SessionStatusJudgmentSourceKind;
    state: 'awaiting_settlement' | 'pending';
  },
) {
  if (
    !(await isDeploymentExperimentEnabled('sessionStatusJudgment', database))
  ) {
    return null;
  }
  return runInTransactionIfAvailable(database, async (tx) => {
    const [session] = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .for('update');
    if (!session) return null;

    const existing = await tx.query.sessionStatusJudgments.findFirst({
      where: and(
        eq(sessionStatusJudgments.sessionId, input.sessionId),
        eq(sessionStatusJudgments.sourceEventId, input.sourceEventId),
      ),
    });
    if (existing) return existing;

    const [latest] = await tx
      .select({ generation: max(sessionStatusJudgments.generation) })
      .from(sessionStatusJudgments)
      .where(eq(sessionStatusJudgments.sessionId, input.sessionId));
    const generation = (latest?.generation ?? 0) + 1;

    await tx
      .update(sessionStatusJudgments)
      .set({
        state: 'stale',
        claimedAt: null,
        errorCode: 'superseded',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessionStatusJudgments.sessionId, input.sessionId),
          inArray(sessionStatusJudgments.state, [
            'awaiting_settlement',
            'pending',
            'processing',
          ]),
        ),
      );

    const [created] = await tx
      .insert(sessionStatusJudgments)
      .values({
        sessionId: input.sessionId,
        sourceEventId: input.sourceEventId,
        generation,
        sourceKind: input.sourceKind,
        state: input.state,
      })
      .returning();

    return created ?? null;
  });
}

export async function settleSessionStatusJudgmentTurn(
  database: DatabaseOrTransaction,
  input: { sessionId: string; sourceEventId: string; visible: boolean },
): Promise<void> {
  if (
    !(await isDeploymentExperimentEnabled('sessionStatusJudgment', database))
  ) {
    await database
      .update(sessionStatusJudgments)
      .set({
        state: 'ignored',
        errorCode: 'experiment_disabled',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessionStatusJudgments.sessionId, input.sessionId),
          eq(sessionStatusJudgments.sourceEventId, input.sourceEventId),
          eq(sessionStatusJudgments.state, 'awaiting_settlement'),
        ),
      );
    return;
  }

  const nextState: SessionStatusJudgmentState = input.visible
    ? 'pending'
    : 'ignored';
  const [request] = await database
    .update(sessionStatusJudgments)
    .set({
      state: nextState,
      settledAt: new Date(),
      errorCode: input.visible ? null : 'no_visible_reply',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessionStatusJudgments.sessionId, input.sessionId),
        eq(sessionStatusJudgments.sourceEventId, input.sourceEventId),
        eq(sessionStatusJudgments.state, 'awaiting_settlement'),
      ),
    )
    .returning({ id: sessionStatusJudgments.id });

  if (request) return;

  if (!input.visible) return;
  await createSessionStatusJudgmentRequest(database, {
    sessionId: input.sessionId,
    sourceEventId: input.sourceEventId,
    sourceKind: 'fast_turn',
    state: 'pending',
  });
}

export async function claimSessionStatusJudgmentRequests(
  database: DatabaseOrTransaction,
  limit: number,
): Promise<(typeof sessionStatusJudgments.$inferSelect)[]> {
  return runInTransactionIfAvailable(database, async (tx) => {
    const expiredClaim = new Date(Date.now() - CLAIM_LEASE_MS);
    const candidates = await tx
      .select()
      .from(sessionStatusJudgments)
      .where(
        or(
          eq(sessionStatusJudgments.state, 'pending'),
          and(
            eq(sessionStatusJudgments.state, 'processing'),
            lt(sessionStatusJudgments.claimedAt, expiredClaim),
          ),
        ),
      )
      .orderBy(sessionStatusJudgments.createdAt, sessionStatusJudgments.id)
      .limit(limit)
      .for('update', { skipLocked: true });

    const claimed: (typeof sessionStatusJudgments.$inferSelect)[] = [];
    for (const candidate of candidates) {
      const [latest] = await tx
        .select({ generation: max(sessionStatusJudgments.generation) })
        .from(sessionStatusJudgments)
        .where(eq(sessionStatusJudgments.sessionId, candidate.sessionId));
      if (latest?.generation !== candidate.generation) {
        await tx
          .update(sessionStatusJudgments)
          .set({
            state: 'stale',
            claimedAt: null,
            errorCode: 'superseded',
            updatedAt: new Date(),
          })
          .where(eq(sessionStatusJudgments.id, candidate.id));
        continue;
      }

      const [updated] = await tx
        .update(sessionStatusJudgments)
        .set({
          state: 'processing',
          attempts: candidate.attempts + 1,
          claimedAt: new Date(),
          errorCode: null,
          updatedAt: new Date(),
        })
        .where(eq(sessionStatusJudgments.id, candidate.id))
        .returning();
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

export async function completeSessionStatusJudgment(
  database: DatabaseOrTransaction,
  input: {
    id: string;
    sessionId: string;
    generation: number;
    state: 'applied' | 'ignored';
    outcome?: SessionStatusJudgmentOutcome;
    confidence?: number;
    probabilities?: Partial<Record<SessionStatusJudgmentOutcome, number>>;
    model?: string;
    errorCode?: string;
  },
): Promise<'applied' | 'ignored' | 'stale' | 'disabled' | 'missing'> {
  return runInTransactionIfAvailable(database, async (tx) => {
    const [session] = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .for('update');
    if (!session) return 'missing';

    const [latest] = await tx
      .select({ generation: max(sessionStatusJudgments.generation) })
      .from(sessionStatusJudgments)
      .where(eq(sessionStatusJudgments.sessionId, input.sessionId));
    if (latest?.generation !== input.generation) {
      await tx
        .update(sessionStatusJudgments)
        .set({
          state: 'stale',
          claimedAt: null,
          errorCode: 'superseded',
          updatedAt: new Date(),
        })
        .where(eq(sessionStatusJudgments.id, input.id));
      return 'stale';
    }

    if (!(await isDeploymentExperimentEnabled('sessionStatusJudgment', tx))) {
      await tx
        .update(sessionStatusJudgments)
        .set({
          state: 'ignored',
          claimedAt: null,
          errorCode: 'experiment_disabled',
          updatedAt: new Date(),
        })
        .where(eq(sessionStatusJudgments.id, input.id));
      return 'disabled';
    }

    const [updated] = await tx
      .update(sessionStatusJudgments)
      .set({
        state: input.state,
        outcome: input.outcome ?? null,
        confidence: input.confidence ?? null,
        probabilities: input.probabilities ?? null,
        model: input.model ?? null,
        claimedAt: null,
        judgedAt: input.state === 'applied' ? new Date() : null,
        errorCode: input.errorCode ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessionStatusJudgments.id, input.id),
          eq(sessionStatusJudgments.state, 'processing'),
        ),
      )
      .returning({ id: sessionStatusJudgments.id });

    return updated ? input.state : 'missing';
  });
}

export async function retryOrFailSessionStatusJudgment(
  database: DatabaseOrTransaction,
  input: { id: string; attempts: number; errorCode: string },
): Promise<void> {
  const enabled = await isDeploymentExperimentEnabled(
    'sessionStatusJudgment',
    database,
  );
  await database
    .update(sessionStatusJudgments)
    .set({
      state: !enabled
        ? 'ignored'
        : input.attempts >= MAX_SESSION_STATUS_JUDGMENT_ATTEMPTS
          ? 'failed'
          : 'pending',
      claimedAt: null,
      errorCode: enabled ? input.errorCode : 'experiment_disabled',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessionStatusJudgments.id, input.id),
        eq(sessionStatusJudgments.state, 'processing'),
      ),
    );
}

export async function discardPendingSessionStatusJudgments(
  database: DatabaseOrTransaction,
): Promise<void> {
  await database
    .update(sessionStatusJudgments)
    .set({
      state: 'ignored',
      claimedAt: null,
      errorCode: 'experiment_disabled',
      updatedAt: new Date(),
    })
    .where(
      inArray(sessionStatusJudgments.state, [
        'awaiting_settlement',
        'pending',
        'processing',
      ]),
    );
}

export async function pruneSessionStatusJudgmentHistory(
  database: DatabaseOrTransaction,
  limit = 500,
): Promise<number> {
  const deleted = await database.execute<{ id: string }>(sql`
    WITH candidates AS (
      SELECT older.id
      FROM session_status_judgments AS older
      WHERE older.state IN ('applied', 'ignored', 'failed', 'stale')
        AND older.created_at < now() - interval '30 days'
        AND EXISTS (
          SELECT 1
          FROM session_status_judgments AS newer
          WHERE newer.session_id = older.session_id
            AND newer.generation > older.generation
        )
      ORDER BY older.created_at, older.id
      LIMIT ${limit}
    ), deleted AS (
      DELETE FROM session_status_judgments AS judgment
      USING candidates
      WHERE judgment.id = candidates.id
      RETURNING judgment.id
    )
    SELECT id FROM deleted
  `);
  return deleted.length;
}

export async function getLatestSessionStatusJudgments(
  database: DatabaseOrTransaction,
  sessionIds: string[],
) {
  if (sessionIds.length === 0) return [];
  return database
    .selectDistinctOn([sessionStatusJudgments.sessionId])
    .from(sessionStatusJudgments)
    .where(inArray(sessionStatusJudgments.sessionId, sessionIds))
    .orderBy(
      sessionStatusJudgments.sessionId,
      desc(sessionStatusJudgments.generation),
    );
}
