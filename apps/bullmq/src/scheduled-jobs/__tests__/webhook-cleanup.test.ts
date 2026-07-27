const { mockDeleteExpiredWebhooks, mockDb } = vi.hoisted(() => ({
  mockDeleteExpiredWebhooks: vi.fn(),
  mockDb: { __brand: 'db' },
}));

vi.mock('@roomote/db/server', () => ({
  db: mockDb,
  deleteExpiredWebhooks: mockDeleteExpiredWebhooks,
}));

vi.mock('@roomote/env', () => ({
  Env: { WEBHOOK_RETENTION_DAYS: 3 },
}));

import { webhookCleanupJob } from '../webhook-cleanup';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('webhookCleanupJob', () => {
  beforeEach(() => {
    mockDeleteExpiredWebhooks.mockReset();
    mockDeleteExpiredWebhooks.mockResolvedValue(0);
  });

  it('deletes rows older than WEBHOOK_RETENTION_DAYS', async () => {
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
