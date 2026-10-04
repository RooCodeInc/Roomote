import { createHmac, randomUUID } from 'node:crypto';

import {
  and,
  db,
  deploymentSettings,
  eq,
  isNull,
  lt,
  lte,
  or,
  sessionDoneWebhookDeliveries,
  sessionStatusJudgments,
  sessionTasks,
  sessions,
  sql,
  tasks,
} from '@roomote/db/server';
import { decrypt } from '@roomote/db/encryption';
import { Env } from '@roomote/env';

import { safeFetch, SafeFetchViolationError } from './safe-fetch';

const DELIVERY_LEASE_MS = 2 * 60 * 1_000;
const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_DELIVERY_ATTEMPTS = 5;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;
const MAX_DELIVERIES_PER_RUN = 100;

function retryDelayMs(attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 60_000 * 2 ** (attempts - 1));
}

async function claimDueDelivery(now: Date) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('session-done-webhook-claim', 0))`,
    );
    const row = await tx.query.sessionDoneWebhookDeliveries.findFirst({
      where: and(
        eq(sessionDoneWebhookDeliveries.status, 'pending'),
        lte(sessionDoneWebhookDeliveries.nextAttemptAt, now),
        or(
          isNull(sessionDoneWebhookDeliveries.leaseExpiresAt),
          lt(sessionDoneWebhookDeliveries.leaseExpiresAt, now),
        ),
      ),
      orderBy: sessionDoneWebhookDeliveries.nextAttemptAt,
    });
    if (!row) return null;

    const leaseToken = randomUUID();
    const [claimed] = await tx
      .update(sessionDoneWebhookDeliveries)
      .set({
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + DELIVERY_LEASE_MS),
        updatedAt: now,
      })
      .where(eq(sessionDoneWebhookDeliveries.id, row.id))
      .returning();
    return claimed ? { row: claimed, leaseToken } : null;
  });
}

async function finishDelivery(
  id: string,
  leaseToken: string,
  values: Partial<typeof sessionDoneWebhookDeliveries.$inferInsert>,
) {
  await db
    .update(sessionDoneWebhookDeliveries)
    .set({
      ...values,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessionDoneWebhookDeliveries.id, id),
        eq(sessionDoneWebhookDeliveries.leaseToken, leaseToken),
      ),
    );
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function drainSessionDoneWebhookDeliveries(
  options: {
    fetch?: typeof safeFetch;
    now?: () => Date;
    allowedPrivateCidrs?: string;
  } = {},
): Promise<{ delivered: number; failed: number; skipped: number }> {
  const fetch = options.fetch ?? safeFetch;
  const now = options.now ?? (() => new Date());
  let delivered = 0;
  let failed = 0;
  let skipped = 0;

  for (let processed = 0; processed < MAX_DELIVERIES_PER_RUN; processed += 1) {
    const claim = await claimDueDelivery(now());
    if (!claim) break;

    const settings = await db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
      columns: {
        sessionDoneWebhookEnabled: true,
        sessionDoneWebhookUrl: true,
        sessionDoneWebhookSecret: true,
      },
    });
    if (
      !settings?.sessionDoneWebhookEnabled ||
      !settings.sessionDoneWebhookUrl ||
      !settings.sessionDoneWebhookSecret
    ) {
      await finishDelivery(claim.row.id, claim.leaseToken, {
        status: 'skipped',
        lastError: 'Completion webhook is disabled or incomplete.',
      });
      skipped += 1;
      continue;
    }

    try {
      const [event] = await db
        .select({
          judgmentId: sessionStatusJudgments.id,
          generation: sessionStatusJudgments.generation,
          sourceKind: sessionStatusJudgments.sourceKind,
          sourceEventId: sessionStatusJudgments.sourceEventId,
          judgedAt: sessionStatusJudgments.judgedAt,
          sessionId: sessions.id,
        })
        .from(sessionDoneWebhookDeliveries)
        .innerJoin(
          sessionStatusJudgments,
          eq(
            sessionDoneWebhookDeliveries.judgmentId,
            sessionStatusJudgments.id,
          ),
        )
        .innerJoin(
          sessions,
          eq(sessionDoneWebhookDeliveries.sessionId, sessions.id),
        )
        .where(eq(sessionDoneWebhookDeliveries.id, claim.row.id));
      if (!event) {
        await finishDelivery(claim.row.id, claim.leaseToken, {
          status: 'skipped',
          lastError: 'Completion event no longer exists.',
        });
        skipped += 1;
        continue;
      }

      const linkedTasks = await db
        .select({ id: tasks.id, state: tasks.state })
        .from(sessionTasks)
        .innerJoin(tasks, eq(sessionTasks.taskId, tasks.id))
        .where(eq(sessionTasks.sessionId, event.sessionId));
      const occurredAt = event.judgedAt ?? claim.row.createdAt;
      const payload = {
        id: claim.row.id,
        type: 'session.done',
        version: 1,
        occurredAt: occurredAt.toISOString(),
        session: {
          id: event.sessionId,
          url: new URL(
            `/sessions/${event.sessionId}`,
            Env.R_PUBLIC_URL ?? Env.R_APP_URL,
          ).toString(),
        },
        status: {
          value: 'done',
          source: 'decision_model',
          judgmentId: event.judgmentId,
          generation: event.generation,
          sourceKind: event.sourceKind,
          sourceEventId: event.sourceEventId,
        },
        tasks: linkedTasks,
      } as const;
      const body = JSON.stringify(payload);
      const timestamp = Math.floor(now().getTime() / 1_000).toString();
      const signature = createHmac(
        'sha256',
        decrypt(settings.sessionDoneWebhookSecret),
      )
        .update(`${timestamp}.${body}`)
        .digest('hex');
      const response = await fetch(settings.sessionDoneWebhookUrl, {
        allowedPrivateCidrs:
          options.allowedPrivateCidrs ??
          Env.R_SESSION_DONE_WEBHOOK_ALLOWED_PRIVATE_CIDRS,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Roomote-Webhook/1.0',
          'x-roomote-delivery': claim.row.id,
          'x-roomote-event': 'session.done',
          'x-roomote-timestamp': timestamp,
          'x-roomote-signature-256': `sha256=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      await response.body?.cancel();

      const attempts = claim.row.attempts + 1;
      if (response.status >= 200 && response.status < 300) {
        await finishDelivery(claim.row.id, claim.leaseToken, {
          status: 'delivered',
          attempts,
          deliveredAt: now(),
          lastError: null,
        });
        delivered += 1;
        continue;
      }

      const message = `Webhook endpoint returned HTTP ${response.status}.`;
      const retry =
        shouldRetryStatus(response.status) && attempts < MAX_DELIVERY_ATTEMPTS;
      await finishDelivery(claim.row.id, claim.leaseToken, {
        status: retry ? 'pending' : 'failed',
        attempts,
        nextAttemptAt: retry
          ? new Date(now().getTime() + retryDelayMs(attempts))
          : claim.row.nextAttemptAt,
        lastError: message,
      });
      failed += 1;
    } catch (error) {
      const attempts = claim.row.attempts + 1;
      const retry =
        !(error instanceof SafeFetchViolationError) &&
        attempts < MAX_DELIVERY_ATTEMPTS;
      await finishDelivery(claim.row.id, claim.leaseToken, {
        status: retry ? 'pending' : 'failed',
        attempts,
        nextAttemptAt: retry
          ? new Date(now().getTime() + retryDelayMs(attempts))
          : claim.row.nextAttemptAt,
        lastError: (error instanceof SafeFetchViolationError
          ? 'Webhook URL was rejected by outbound request policy.'
          : error instanceof Error
            ? error.message
            : String(error)
        ).slice(0, 2_000),
      });
      failed += 1;
    }
  }

  return { delivered, failed, skipped };
}
