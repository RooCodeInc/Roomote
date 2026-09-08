import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { encrypt } from '@roomote/db/encryption';

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  accept: vi.fn(),
  rateCount: vi.fn(),
}));
vi.mock('@roomote/db/server', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: mocks.lookup }) }),
    }),
  },
  automationWebhookTriggers: { id: 'id' },
  eq: vi.fn(),
  acceptAutomationWebhookDelivery: mocks.accept,
}));
vi.mock('../../handlers', () =>
  Object.fromEntries(
    [
      'apiHealth',
      'apiLiveness',
      'controllerHealth',
      'github',
      'gitlab',
      'gitea',
      'bitbucket',
      'ado',
      'slack',
      'linear',
      'teams',
      'telegram',
      'discord',
      'cloudDeploymentAccess',
      'brainInference',
      'inference',
      'tts',
      'mcp',
      'mcpRouting',
      'mcpOAuthMetadata',
      'publicRoomoteMcp',
      'taskRunsRouter',
      'artifactsRouter',
      'taskArtifactsRouter',
      'oidcRouter',
      'trpc',
    ].map((name) => [name, new Hono()]),
  ),
);
vi.mock('@roomote/redis', () => ({
  getRedis: () => ({ eval: mocks.rateCount }),
}));
vi.mock('../../middleware', async () => ({
  requestObservabilityMiddleware: async (
    _c: unknown,
    next: () => Promise<void>,
  ) => next(),
  ...(await import('../../middleware/tokenAuthMiddleware')),
  ...(await import('../../middleware/routePolicyMiddleware')),
}));
vi.mock('../../monitoring/sentry', () => ({
  captureApiException: vi.fn(),
  flushApiSentry: vi.fn(),
}));

import { automationWebhooks } from './index';
import { createApiApp } from '../../server';

const triggerId = '4fc1c541-c79e-435b-b120-572532ff8157';
const key = Buffer.from('a-test-signing-key-not-a-production-secret');
const secret = `whsec_${key.toString('base64')}`;
const now = 1_788_900_000;
const event = {
  event_id: 'evt_123',
  event_type: 'note.generated',
  note_id: 'not_1234567890AbCd',
  occurred_at: '2026-09-08T12:00:00Z',
};
const trigger = {
  id: triggerId,
  provider: 'granola',
  status: 'active',
  enabled: true,
  encryptedSigningSecret: encrypt(secret),
};
function signature(body: string, timestamp = String(now), id = event.event_id) {
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}
function request(
  body = JSON.stringify(event),
  headers: Record<string, string> = {},
) {
  return new Request(`http://localhost/api/webhooks/automations/${triggerId}`, {
    method: 'POST',
    body,
    headers: {
      'webhook-id': event.event_id,
      'webhook-timestamp': String(now),
      'webhook-signature': signature(body),
      ...headers,
    },
  });
}
const app = new Hono().route('/api/webhooks/automations', automationWebhooks);

describe('Granola automation webhook ingress', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    mocks.lookup.mockResolvedValue([trigger]);
    mocks.accept.mockResolvedValue('accepted');
    mocks.rateCount.mockResolvedValue(1);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['note.generated', 'note.access_granted', 'note.edited'])(
    'durably accepts %s and forwards only identity',
    async (eventType) => {
      const payload = {
        ...event,
        event_type: eventType,
        workspace_id: 'workspace',
        data: { changed_fields: ['summary'], metadata: { origin: 'test' } },
      };
      expect((await app.request(request(JSON.stringify(payload)))).status).toBe(
        200,
      );
      expect(mocks.accept).toHaveBeenCalledExactlyOnceWith({
        triggerId,
        eventId: event.event_id,
        eventType,
        noteId: event.note_id,
        occurredAt: new Date(event.occurred_at),
      });
    },
  );

  it('awaits the durable acknowledgement', async () => {
    let resolve!: (value: string) => void;
    mocks.accept.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    let settled = false;
    const pending = Promise.resolve(app.request(request())).then((response) => {
      settled = true;
      return response;
    });
    await vi.waitFor(() => expect(mocks.accept).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    resolve('accepted');
    expect((await pending).status).toBe(200);
  });

  it.each(['accepted', 'duplicate', 'ignored', 'capacity'])(
    'maps durable %s result',
    async (result) => {
      mocks.accept.mockResolvedValue(result);
      expect((await app.request(request())).status).toBe(
        result === 'capacity' ? 429 : 200,
      );
    },
  );

  it.each(['pending', 'error', 'deleting', 'active'])(
    'leaves %s/enabled gating after durable dedup',
    async (status) => {
      mocks.lookup.mockResolvedValue([{ ...trigger, status, enabled: false }]);
      mocks.accept
        .mockResolvedValueOnce('duplicate')
        .mockResolvedValueOnce(status === 'active' ? 'ignored' : 'capacity');
      expect((await app.request(request())).status).toBe(200);
      expect((await app.request(request())).status).toBe(
        status === 'active' ? 200 : 429,
      );
    },
  );

  it.each([-301, 301])('rejects timestamp offset %s', async (offset) => {
    const timestamp = String(now + offset);
    expect(
      (
        await app.request(
          request(undefined, {
            'webhook-timestamp': timestamp,
            'webhook-signature': signature(JSON.stringify(event), timestamp),
          }),
        )
      ).status,
    ).toBe(401);
    expect(mocks.accept).not.toHaveBeenCalled();
  });
  it.each([-300, 300])('accepts timestamp boundary %s', async (offset) => {
    const timestamp = String(now + offset);
    expect(
      (
        await app.request(
          request(undefined, {
            'webhook-timestamp': timestamp,
            'webhook-signature': signature(JSON.stringify(event), timestamp),
          }),
        )
      ).status,
    ).toBe(200);
  });
  it.each(['webhook-id', 'webhook-timestamp', 'webhook-signature'])(
    'rejects missing %s',
    async (header) => {
      const req = request();
      req.headers.delete(header);
      expect((await app.request(req)).status).toBe(401);
      expect(mocks.accept).not.toHaveBeenCalled();
    },
  );
  it('rejects tampering with raw whitespace before JSON parsing', async () => {
    expect(
      (
        await app.request(
          request(` ${JSON.stringify(event)}`, {
            'webhook-signature': signature(JSON.stringify(event)),
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (await app.request(request('{', { 'webhook-signature': 'v1,invalid' })))
        .status,
    ).toBe(401);
    expect(mocks.accept).not.toHaveBeenCalled();
  });
  it('accepts any matching space-delimited v1 signature', async () => {
    expect(
      (
        await app.request(
          request(undefined, {
            'webhook-signature': `v2,unsupported v1,${Buffer.alloc(32).toString('base64')} ${signature(JSON.stringify(event))}`,
          }),
        )
      ).status,
    ).toBe(200);
  });
  it('rejects a valid signature with mismatched event identity', async () => {
    expect(
      (
        await app.request(
          request(JSON.stringify({ ...event, event_id: 'other' })),
        )
      ).status,
    ).toBe(400);
    expect(mocks.accept).not.toHaveBeenCalled();
  });
  it.each([
    '{',
    'null',
    '[]',
    JSON.stringify({ ...event, event_type: 'note.deleted' }),
    JSON.stringify({ ...event, note_id: 'not_short' }),
    JSON.stringify({ ...event, occurred_at: 'yesterday' }),
    JSON.stringify({ ...event, event_type: 'note.edited' }),
    JSON.stringify({
      ...event,
      event_type: 'note.edited',
      data: { changed_fields: ['transcript'] },
    }),
  ])('rejects malformed signed payload %#', async (body) => {
    expect((await app.request(request(body))).status).toBe(400);
    expect(mocks.accept).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'rejects bodies above 16KiB (content-length %s)',
    async (withLength) => {
      const body = 'x'.repeat(16 * 1024 + 1);
      expect(
        (
          await app.request(
            request(
              body,
              withLength ? { 'content-length': String(body.length) } : {},
            ),
          )
        ).status,
      ).toBe(413);
      expect(mocks.lookup).not.toHaveBeenCalled();
      expect(mocks.accept).not.toHaveBeenCalled();
    },
  );
  it.each(['lookup', 'accept'] as const)(
    'returns 503 without logging %s failures',
    async (boundary) => {
      const log = vi.spyOn(console, 'error');
      mocks[boundary].mockRejectedValue(new Error(`private SQL ${secret}`));
      const response = await app.request(request());
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(secret);
      expect(log).not.toHaveBeenCalled();
    },
  );
  it('fails closed without logging when stored ciphertext cannot be decrypted', async () => {
    const ciphertext = Buffer.from(trigger.encryptedSigningSecret, 'base64');
    ciphertext[ciphertext.length - 1] = ciphertext[ciphertext.length - 1]! ^ 1;
    mocks.lookup.mockResolvedValue([
      { ...trigger, encryptedSigningSecret: ciphertext.toString('base64') },
    ]);
    const error = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn');
    const response = await app.request(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'unavailable' });
    expect(mocks.accept).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
  it.each([
    { rows: [] },
    { rows: [{ ...trigger, provider: 'other' }] },
    { rows: [{ ...trigger, encryptedSigningSecret: null }] },
  ])('rejects unavailable trigger %#', async ({ rows }) => {
    mocks.lookup.mockResolvedValue(rows);
    expect((await app.request(request())).status).toBe(401);
    expect(mocks.accept).not.toHaveBeenCalled();
  });
  it('allows signed callbacks without bearer auth through the real policy stack', async () => {
    const server = createApiApp();
    expect((await server.request(request())).status).toBe(200);
    expect(mocks.rateCount).toHaveBeenCalledOnce();
    expect(
      (await server.request('/api/tasks', { method: 'POST' })).status,
    ).toBe(401);
    for (const path of [
      `/api/webhooks/automations/${triggerId}/extra`,
      '/api/webhooks/automations',
      `/webhooks/automations/${triggerId}`,
      `/api/webhooks/automations-other/${triggerId}`,
    ]) {
      expect((await server.request(path, { method: 'POST' })).status).toBe(404);
    }
    expect(
      (await server.request(`/api/webhooks/automations/${triggerId}`)).status,
    ).toBe(404);
  });
  it('still requires a signature on the public callback', async () => {
    const req = request();
    req.headers.delete('webhook-signature');
    expect((await createApiApp().request(req)).status).toBe(401);
    expect(mocks.accept).not.toHaveBeenCalled();
  });
  it('uses the existing bounded Redis webhook limiter before database access', async () => {
    mocks.rateCount.mockResolvedValue(1201);
    expect((await createApiApp().request(request())).status).toBe(429);
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.accept).not.toHaveBeenCalled();
    expect(mocks.rateCount).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringContaining('webhook-automations:client:'),
      '60',
    );
  });
});
