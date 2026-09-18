const { mockDeleteExpiredWebhooks, mockDb } = vi.hoisted(() => ({
  mockDeleteExpiredWebhooks: vi.fn(),
  mockDb: { __brand: 'db' },
}));

vi.mock('@roomote/db/server', () => ({
  db: mockDb,
  deleteExpiredWebhooks: mockDeleteExpiredWebhooks,
}));

import { rehydrateEnv } from '@roomote/env';
import { webhookCleanupJob } from '../webhook-cleanup';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('webhookCleanupJob', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockDeleteExpiredWebhooks.mockReset();
    mockDeleteExpiredWebhooks.mockResolvedValue(0);

    const skippedEnv: NodeJS.ProcessEnv = {
      ...originalEnv,
      SKIP_ENV_VALIDATION: '1',
    };
    delete skippedEnv.WEBHOOK_RETENTION_DAYS;
    rehydrateEnv(skippedEnv);
  });

  afterAll(() => rehydrateEnv(originalEnv));

  it('uses the default retention when env validation is skipped', async () => {
    const before = Date.now();
    await webhookCleanupJob();
    const after = Date.now();

    expect(mockDeleteExpiredWebhooks).toHaveBeenCalledTimes(1);
    const [database, options] = mockDeleteExpiredWebhooks.mock.calls[0]!;

    expect(database).toBe(mockDb);
    const cutoffMs = (options as { olderThan: Date }).olderThan.getTime();
    expect(cutoffMs).toBeGreaterThanOrEqual(before - 3 * DAY_MS);
    expect(cutoffMs).toBeLessThanOrEqual(after - 3 * DAY_MS);
  });

  it('propagates delete failures so BullMQ retries', async () => {
    mockDeleteExpiredWebhooks.mockRejectedValue(new Error('db down'));

    await expect(webhookCleanupJob()).rejects.toThrow('db down');
  });
});
