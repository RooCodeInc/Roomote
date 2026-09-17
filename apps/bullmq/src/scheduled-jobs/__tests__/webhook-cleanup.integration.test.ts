import { randomUUID } from 'node:crypto';

import { db, inArray, webhooks } from '@roomote/db/server';
import { Env, rehydrateEnv } from '@roomote/env';

import { webhookCleanupJob } from '../webhook-cleanup';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('webhookCleanupJob integration', () => {
  const originalEnv = { ...process.env };

  beforeAll(() => {
    const validatedEnv = { ...originalEnv };
    delete validatedEnv.SKIP_ENV_VALIDATION;
    delete validatedEnv.WEBHOOK_RETENTION_DAYS;
    rehydrateEnv(validatedEnv);
  });

  afterAll(() => rehydrateEnv(originalEnv));

  it('deletes old rows, keeps recent rows, and handles an empty follow-up run', async () => {
    let assertionsCompleted = false;

    try {
      await db.transaction(async (tx) => {
        const now = Date.now();
        const [oldRow, recentRow] = await tx
          .insert(webhooks)
          .values([
            {
              provider: 'github',
              deliveryId: `cleanup-old-${randomUUID()}`,
              event: 'test.event',
              payload: {},
              createdAt: new Date(now - 4 * DAY_MS),
            },
            {
              provider: 'github',
              deliveryId: `cleanup-recent-${randomUUID()}`,
              event: 'test.event',
              payload: {},
              createdAt: new Date(now - DAY_MS),
            },
          ])
          .returning({ id: webhooks.id });

        expect(Env.WEBHOOK_RETENTION_DAYS).toBe(3);
        await webhookCleanupJob(tx);

        const remaining = await tx
          .select({ id: webhooks.id })
          .from(webhooks)
          .where(inArray(webhooks.id, [oldRow!.id, recentRow!.id]));
        expect(remaining).toEqual([{ id: recentRow!.id }]);

        const log = vi
          .spyOn(console, 'log')
          .mockImplementation(() => undefined);
        try {
          await webhookCleanupJob(tx);
          expect(log).toHaveBeenLastCalledWith(
            expect.stringContaining('deleted 0 webhook rows'),
          );
        } finally {
          log.mockRestore();
        }

        assertionsCompleted = true;
        tx.rollback();
      });
    } catch (error) {
      if (!assertionsCompleted) {
        throw error;
      }
    }
  });
});
