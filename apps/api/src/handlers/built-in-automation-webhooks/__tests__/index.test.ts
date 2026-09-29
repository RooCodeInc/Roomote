import { Hono } from 'hono';

import { builtInAutomationWebhooks } from '..';

const mocks = vi.hoisted(() => ({
  getWebhookState: vi.fn(),
  enqueueWebhook: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((...args: unknown[]) => args),
  isNull: vi.fn((value: unknown) => value),
  users: { id: 'users.id', deletedAt: 'users.deletedAt' },
  db: { query: { users: { findFirst: vi.fn() } } },
  getBackgroundAutomationWebhookState: mocks.getWebhookState,
  getCustomAutomationWebhookState: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  enqueueBuiltInAutomationWebhook: mocks.enqueueWebhook,
  runCustomAutomationNow: vi.fn(),
}));

const TOKEN = 'A'.repeat(43);

function createApp() {
  const app = new Hono();
  app.route('/api/webhooks/built-in-automations', builtInAutomationWebhooks);
  return app;
}

function webhookUrl(automationKey = 'suggester', token = TOKEN): string {
  return `http://localhost/api/webhooks/built-in-automations/${automationKey}/${token}`;
}

describe('built-in automation webhook trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWebhookState.mockResolvedValue({ enabled: true, token: TOKEN });
    mocks.enqueueWebhook.mockResolvedValue(undefined);
  });

  it('runs a catalog-eligible automation and forwards bounded input', async () => {
    const response = await createApp().request(webhookUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ issue: 'Review the failing workflow.' }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(mocks.enqueueWebhook).toHaveBeenCalledWith({
      automationKey: 'suggester',
      webhookInputJson: JSON.stringify({
        issue: 'Review the failing workflow.',
      }),
    });
  });

  it('keeps webhook-disabled and event-driven catalog entries unavailable', async () => {
    expect(
      (await createApp().request(webhookUrl('review_code'), { method: 'POST' }))
        .status,
    ).toBe(404);
    mocks.getWebhookState.mockResolvedValueOnce({
      enabled: false,
      token: TOKEN,
    });
    expect(
      (await createApp().request(webhookUrl(), { method: 'POST' })).status,
    ).toBe(404);
    expect(mocks.enqueueWebhook).not.toHaveBeenCalled();
  });

  it('returns a retryable error when webhook admission fails', async () => {
    mocks.enqueueWebhook.mockRejectedValue(new Error('Redis unavailable'));

    const response = await createApp().request(webhookUrl(), {
      method: 'POST',
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'trigger_failed' });
  });

  it('is POST-only and enforces the shared body limits', async () => {
    const app = createApp();
    expect((await app.request(webhookUrl(), { method: 'GET' })).status).toBe(
      405,
    );
    expect(
      (
        await app.request(webhookUrl(), {
          method: 'POST',
          headers: { 'content-length': String(64 * 1024 + 1) },
          body: 'oversized',
        })
      ).status,
    ).toBe(413);
  });
});
