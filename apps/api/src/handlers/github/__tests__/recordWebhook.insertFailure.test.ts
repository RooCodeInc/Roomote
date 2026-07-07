const dbMocks = vi.hoisted(() => ({
  insert: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  webhooks: {
    id: 'id',
  },
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    insert: dbMocks.insert,
    update: dbMocks.update,
  },
  eq: dbMocks.eq,
  webhooks: dbMocks.webhooks,
}));

import { recordWebhook } from '../recordWebhook';

describe('recordWebhook insert failure fallback', () => {
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
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});

    await recordWebhook(
      'delivery-insert-failure',
      'pull_request.opened',
      { test: 'payload' },
      handler,
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(dbMocks.update).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[recordWebhook] Failed to insert placeholder for webhook delivery-insert-failure - proceeding with handler anyway:',
      'insert failed',
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[recordWebhook] Handler executed for webhook delivery-insert-failure but no database record exists (insert failed)',
    );
  });
});
