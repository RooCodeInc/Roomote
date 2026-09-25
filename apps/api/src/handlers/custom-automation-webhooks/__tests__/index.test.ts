import { Hono } from 'hono';
import { customAutomationWebhooks } from '..';

const mocks = vi.hoisted(() => ({
  getWebhookState: vi.fn(),
  findOwner: vi.fn(),
  runAutomation: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((...args: unknown[]) => args),
  isNull: vi.fn((value: unknown) => value),
  users: { id: 'users.id', deletedAt: 'users.deletedAt' },
  db: { query: { users: { findFirst: mocks.findOwner } } },
  getCustomAutomationWebhookState: mocks.getWebhookState,
}));

vi.mock('@roomote/sdk/server', () => ({
  runCustomAutomationNow: mocks.runAutomation,
}));

const AUTOMATION_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'A'.repeat(43);

function createApp() {
  const app = new Hono();
  app.route('/api/webhooks/custom-automations', customAutomationWebhooks);
  return app;
}

function webhookUrl(token = TOKEN) {
  return `http://localhost/api/webhooks/custom-automations/${AUTOMATION_ID}/${token}`;
}

describe('custom automation webhook trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWebhookState.mockResolvedValue({
      enabled: true,
      createdByUserId: 'owner-1',
      token: TOKEN,
    });
    mocks.findOwner.mockResolvedValue({ id: 'owner-1' });
    mocks.runAutomation.mockResolvedValue({ outcome: 'queued' });
  });

  it('forwards bounded JSON as per-run webhook input', async () => {
    const body = { issue: 'Review the failing workflow.' };
    const response = await createApp().request(webhookUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(response.headers.get('cache-control')).toBe('no-store, private');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(mocks.runAutomation).toHaveBeenCalledWith(
      AUTOMATION_ID,
      'webhook',
      JSON.stringify(body),
    );
  });

  it('keeps an empty POST body as a trigger-only run', async () => {
    const response = await createApp().request(webhookUrl(), {
      method: 'POST',
    });

    expect(response.status).toBe(202);
    expect(mocks.runAutomation).toHaveBeenCalledWith(AUTOMATION_ID, 'webhook');
  });

  it('accepts text/plain bodies as a one-run instruction', async () => {
    const response = await createApp().request(webhookUrl(), {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'Review issue #42 and summarize the failure.',
    });

    expect(response.status).toBe(202);
    expect(mocks.runAutomation).toHaveBeenCalledWith(
      AUTOMATION_ID,
      'webhook',
      JSON.stringify('Review issue #42 and summarize the failure.'),
    );
  });

  it.each([
    {
      contentType: 'application/json',
      body: '{invalid json',
      status: 400,
      error: 'invalid_json',
    },
    {
      contentType: 'text/html',
      body: '<p>Not accepted</p>',
      status: 415,
      error: 'unsupported_media_type',
    },
    {
      contentType: 'application/json',
      contentEncoding: 'gzip',
      body: '{"issue":"compressed"}',
      status: 415,
      error: 'unsupported_media_type',
    },
  ])(
    'rejects invalid or unsupported bodies without starting a run',
    async ({ contentType, contentEncoding, body, status, error }) => {
      const response = await createApp().request(webhookUrl(), {
        method: 'POST',
        headers: {
          'content-type': contentType,
          ...(contentEncoding ? { 'content-encoding': contentEncoding } : {}),
        },
        body,
      });

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
      expect(mocks.runAutomation).not.toHaveBeenCalled();
    },
  );

  it('rejects an incorrect token without attempting a run', async () => {
    const response = await createApp().request(webhookUrl('B'.repeat(43)), {
      method: 'POST',
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(mocks.runAutomation).not.toHaveBeenCalled();
  });

  it('rejects disabled automations and owners that are no longer active', async () => {
    mocks.getWebhookState.mockResolvedValueOnce({
      enabled: false,
      createdByUserId: 'owner-1',
      token: TOKEN,
    });
    expect(
      (await createApp().request(webhookUrl(), { method: 'POST' })).status,
    ).toBe(404);

    mocks.findOwner.mockResolvedValueOnce(null);
    expect(
      (await createApp().request(webhookUrl(), { method: 'POST' })).status,
    ).toBe(404);
    expect(mocks.runAutomation).not.toHaveBeenCalled();
  });

  it('is POST-only and rejects oversized bodies', async () => {
    const app = createApp();
    const getResponse = await app.request(webhookUrl(), { method: 'GET' });
    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.get('allow')).toBe('POST');
    const response = await app.request(webhookUrl(), {
      method: 'POST',
      headers: { 'content-length': String(64 * 1024 + 1) },
      body: 'oversized',
    });
    expect(response.status).toBe(413);

    const chunkedResponse = await app.request(webhookUrl(), {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(64 * 1024 + 1),
    });
    expect(chunkedResponse.status).toBe(413);
    expect(mocks.runAutomation).not.toHaveBeenCalled();
  });
});
