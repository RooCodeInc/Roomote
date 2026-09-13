const dbMocks = vi.hoisted(() => ({
  insert: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  webhooks: {
    id: 'id',
  },
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  db: {
    insert: dbMocks.insert,
    update: dbMocks.update,
  },
  eq: dbMocks.eq,
  isNull: vi.fn(),
  webhooks: dbMocks.webhooks,
}));

import { recordLinearWebhook } from '../recordWebhook';

describe('recordLinearWebhook insert failure fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.insert.mockReturnValue({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            throw new Error('insert failed');
          },
        }),
      }),
    });
  });

  it('continues handler execution when the placeholder insert throws', async () => {
    const handler = vi.fn(async () => ({ status: 'ok' as const }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});

    await recordLinearWebhook(
      'linear-insert-failure',
      'Issue',
      { test: 'payload' },
      handler,
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(dbMocks.update).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[recordLinearWebhook] Failed to insert placeholder for webhook linear-insert-failure - proceeding with handler anyway:',
      'insert failed',
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[recordLinearWebhook] Handler executed for webhook linear-insert-failure but no database record exists (insert failed)',
    );
  });
});
