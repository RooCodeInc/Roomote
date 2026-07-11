import { db, deleteExpiredWebhooks } from '@roomote/db/server';
import { Env } from '@roomote/env';

const LOG_PREFIX = '[webhookCleanup]';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Daily retention job for the `webhooks` audit table. Recorded webhook
 * payloads are only needed for short-term debugging and idempotency, so rows
 * older than WEBHOOK_RETENTION_DAYS (default 30) are deleted. Payload
 * redaction at write time (apps/api webhook-payload-redaction) covers the
 * window while rows are retained.
 */
export async function webhookCleanupJob(): Promise<void> {
  const retentionDays = Env.WEBHOOK_RETENTION_DAYS;
  const olderThan = new Date(Date.now() - retentionDays * MS_PER_DAY);

  const deleted = await deleteExpiredWebhooks(db, { olderThan });

  console.log(
    `${LOG_PREFIX} deleted ${deleted} webhook rows older than ${retentionDays} days (before ${olderThan.toISOString()})`,
  );
}
