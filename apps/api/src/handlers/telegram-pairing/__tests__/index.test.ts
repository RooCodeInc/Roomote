import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { envMock, redisStore, redisMock } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    envMock: {
      R_APP_URL: 'https://roomote.example.com',
      R_TELEGRAM_MANAGER_BOT_TOKEN: '7000000002:manager-token' as
        | string
        | undefined,
      R_TELEGRAM_MANAGER_BOT_USERNAME: 'RoomoteSetupBot' as string | undefined,
      R_TELEGRAM_MANAGER_WEBHOOK_SECRET: 'manager-secret' as string | undefined,
    },
    redisStore: store,
    redisMock: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string, ..._args: unknown[]) => {
        store.set(key, value);
        return 'OK';
      }),
      del: vi.fn(async (key: string) => {
        store.delete(key);
        return 1;
      }),
    },
  };
});

vi.mock('@roomote/env', () => ({ Env: envMock }));
vi.mock('@roomote/redis', () => ({ getRedis: () => redisMock }));
vi.mock('../../../logging.js', () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn() },
}));

import { telegramManagerWebhook, telegramPairing } from '../index.js';

const CHILD_BOT_TOKEN = '7000000003:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function mockTelegramApi() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ url, body });

      if (url.includes('/getManagedBotToken')) {
        return Response.json({ ok: true, result: { token: CHILD_BOT_TOKEN } });
      }
      return Response.json({ ok: true, result: true });
    }),
  );
  return calls;
}

async function createPairing(): Promise<{
  pairingId: string;
  pollToken: string;
  suggestedUsername: string;
  deepLink: string;
}> {
  const response = await telegramPairing.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botName: 'Roomote' }),
  });
  expect(response.status).toBe(201);
  return response.json();
}

function managedBotUpdate(botUsername: string) {
  return {
    update_id: 5,
    managed_bot: {
      user: { id: 111000111, username: 'grace_mock' },
      bot: { id: 7000000003, is_bot: true, username: botUsername },
    },
  };
}

async function deliverManagerWebhook(
  update: unknown,
  secret = 'manager-secret',
) {
  return telegramManagerWebhook.request('/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify(update),
  });
}

describe('telegram-pairing service', () => {
  beforeEach(() => {
    redisStore.clear();
    envMock.R_TELEGRAM_MANAGER_BOT_TOKEN = '7000000002:manager-token';
    envMock.R_TELEGRAM_MANAGER_BOT_USERNAME = 'RoomoteSetupBot';
    envMock.R_TELEGRAM_MANAGER_WEBHOOK_SECRET = 'manager-secret';
    mockTelegramApi();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('returns 404 everywhere when no manager bot is configured', async () => {
    envMock.R_TELEGRAM_MANAGER_BOT_TOKEN = undefined;

    const create = await telegramPairing.request('/', { method: 'POST' });
    expect(create.status).toBe(404);

    const poll = await telegramPairing.request('/some-id');
    expect(poll.status).toBe(404);

    const webhook = await deliverManagerWebhook(managedBotUpdate('x_bot'));
    expect(webhook.status).toBe(404);
  });

  it('creates a pairing with a deep link and registers the manager webhook', async () => {
    const calls = mockTelegramApi();
    const pairing = await createPairing();

    expect(pairing.suggestedUsername).toMatch(/^roomote_[a-z2-7]{16}_bot$/);
    expect(pairing.deepLink).toBe(
      `https://t.me/newbot/RoomoteSetupBot/${pairing.suggestedUsername}?name=Roomote`,
    );

    const webhookCall = calls.find((call) => call.url.includes('/setWebhook'));
    expect(webhookCall?.body).toMatchObject({
      url: 'https://roomote.example.com/api/webhooks/telegram-manager',
      secret_token: 'manager-secret',
      allowed_updates: ['managed_bot'],
    });
  });

  it('completes the full pairing flow and hands the token out exactly once', async () => {
    const pairing = await createPairing();

    // Pending before the managed_bot update arrives.
    const pending = await telegramPairing.request(`/${pairing.pairingId}`, {
      headers: { Authorization: `Bearer ${pairing.pollToken}` },
    });
    expect(await pending.json()).toEqual({ status: 'pending' });

    const webhook = await deliverManagerWebhook(
      managedBotUpdate(pairing.suggestedUsername),
    );
    expect(webhook.status).toBe(200);

    const ready = await telegramPairing.request(`/${pairing.pairingId}`, {
      headers: { Authorization: `Bearer ${pairing.pollToken}` },
    });
    expect(await ready.json()).toEqual({
      status: 'ready',
      token: CHILD_BOT_TOKEN,
      botUsername: pairing.suggestedUsername,
      ownerTelegramUserId: '111000111',
      ownerTelegramUsername: 'grace_mock',
    });

    // One-shot: the second poll finds nothing.
    const gone = await telegramPairing.request(`/${pairing.pairingId}`, {
      headers: { Authorization: `Bearer ${pairing.pollToken}` },
    });
    expect(gone.status).toBe(404);
  });

  it('rejects polls with a wrong or missing poll token', async () => {
    const pairing = await createPairing();

    const missing = await telegramPairing.request(`/${pairing.pairingId}`);
    expect(missing.status).toBe(404);

    const wrong = await telegramPairing.request(`/${pairing.pairingId}`, {
      headers: { Authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(404);
  });

  it('rejects manager webhook deliveries with a bad secret', async () => {
    const response = await deliverManagerWebhook(
      managedBotUpdate('roomote_x_bot'),
      'wrong-secret',
    );
    expect(response.status).toBe(401);
  });

  it('acknowledges managed_bot updates without a matching pairing', async () => {
    const response = await deliverManagerWebhook(
      managedBotUpdate('roomote_unknown_bot'),
    );
    expect(response.status).toBe(200);
  });

  it('returns 500 so Telegram retries when the token fetch fails', async () => {
    const pairing = await createPairing();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/getManagedBotToken')) {
          return Response.json(
            { ok: false, description: 'flaky' },
            { status: 500 },
          );
        }
        return Response.json({ ok: true, result: true });
      }),
    );

    const webhook = await deliverManagerWebhook(
      managedBotUpdate(pairing.suggestedUsername),
    );
    expect(webhook.status).toBe(500);

    const stillPending = await telegramPairing.request(
      `/${pairing.pairingId}`,
      { headers: { Authorization: `Bearer ${pairing.pollToken}` } },
    );
    expect(await stillPending.json()).toEqual({ status: 'pending' });
  });
});
