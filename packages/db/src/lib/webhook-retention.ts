import { inArray, lt } from 'drizzle-orm';

import type { DatabaseOrTransaction } from '../db';
import { webhooks } from '../schema';

const DEFAULT_DELETE_BATCH_SIZE = 5_000;

export interface DeleteExpiredWebhooksOptions {
  /** Rows recorded strictly before this instant are deleted. */
  olderThan: Date;
  /**
   * Rows deleted per DELETE statement. The first cleanup run on a
   * long-lived deployment can face months of accumulated rows, so the
   * delete is chunked to keep individual statements (and their locks)
   * bounded.
   */
  batchSize?: number;
}

/**
 * Deletes recorded webhook rows older than the cutoff, in batches, and
 * returns the number of rows removed. Used by the WebhookCleanup scheduled
 * job (apps/bullmq) with a cutoff derived from WEBHOOK_RETENTION_DAYS.
 */
export async function deleteExpiredWebhooks(
  database: DatabaseOrTransaction,
  {
    olderThan,
    batchSize = DEFAULT_DELETE_BATCH_SIZE,
  }: DeleteExpiredWebhooksOptions,
): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`batchSize must be a positive integer, got ${batchSize}`);
  }

  let totalDeleted = 0;

  while (true) {
    const expiredBatch = database
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(lt(webhooks.createdAt, olderThan))
      .limit(batchSize);

    const deleted = await database
      .delete(webhooks)
      .where(inArray(webhooks.id, expiredBatch))
      .returning({ id: webhooks.id });

    totalDeleted += deleted.length;

    if (deleted.length < batchSize) {
      return totalDeleted;
    }
  }
}
