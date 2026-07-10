/**
 * Real-database coverage for the webhook retention delete used by the
 * WebhookCleanup scheduled job (apps/bullmq). Runs against the real test
 * database so Postgres parses the batched delete-with-subquery.
 */
import { randomUUID } from 'node:crypto';

import { db, deleteExpiredWebhooks, inArray, webhooks } from '../server';

const DAY_MS = 24 * 60 * 60 * 1000;

const createdWebhookIds: string[] = [];

async function insertWebhookRecordedAt(createdAt: Date): Promise<string> {
  const [row] = await db
    .insert(webhooks)
    .values({
      provider: 'github',
      deliveryId: `retention-${randomUUID()}`,
      event: 'test.event',
      payload: {},
      createdAt,
    })
    .returning({ id: webhooks.id });

  if (!row) {
    throw new Error('Failed to insert webhook fixture');
  }

  createdWebhookIds.push(row.id);
  return row.id;
}

async function remainingIds(ids: string[]): Promise<string[]> {
  const rows = await db
    .select({ id: webhooks.id })
    .from(webhooks)
    .where(inArray(webhooks.id, ids));

  return rows.map((row) => row.id);
}

afterEach(async () => {
  if (createdWebhookIds.length > 0) {
    await db.delete(webhooks).where(inArray(webhooks.id, createdWebhookIds));
    createdWebhookIds.length = 0;
  }
});

describe('deleteExpiredWebhooks', () => {
  it('deletes rows older than the cutoff and keeps newer ones', async () => {
    const now = Date.now();
    const oldIds = await Promise.all([
      insertWebhookRecordedAt(new Date(now - 40 * DAY_MS)),
      insertWebhookRecordedAt(new Date(now - 31 * DAY_MS)),
    ]);
    const recentId = await insertWebhookRecordedAt(new Date(now - 1 * DAY_MS));

    const deleted = await deleteExpiredWebhooks(db, {
      olderThan: new Date(now - 30 * DAY_MS),
    });

    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(await remainingIds(oldIds)).toEqual([]);
    expect(await remainingIds([recentId])).toEqual([recentId]);
  });

  it('drains everything past the cutoff across multiple batches', async () => {
    const now = Date.now();
    const oldIds = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        insertWebhookRecordedAt(new Date(now - (31 + index) * DAY_MS)),
      ),
    );

    const deleted = await deleteExpiredWebhooks(db, {
      olderThan: new Date(now - 30 * DAY_MS),
      batchSize: 2,
    });

    expect(deleted).toBeGreaterThanOrEqual(5);
    expect(await remainingIds(oldIds)).toEqual([]);
  });

  it('rejects a non-positive batch size', async () => {
    await expect(
      deleteExpiredWebhooks(db, { olderThan: new Date(), batchSize: 0 }),
    ).rejects.toThrow('batchSize must be a positive integer');
  });
});
