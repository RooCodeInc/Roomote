import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserAuthSuccess } from '@/types';

const {
  envMock,
  profilePhotoMock,
  redisStore,
  redisMock,
  saveCommsAuthConfigMock,
} = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    envMock: {
      R_TELEGRAM_PAIRING_URL: 'https://pairing.example.com' as
        | string
        | undefined,
      TELEGRAM_API_BASE_URL: 'https://telegram.example.com',
    },
    profilePhotoMock: vi.fn(),
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
    saveCommsAuthConfigMock: vi.fn(async () => ({
      telegramWebhook: { registered: true, error: null },
    })),
  };
});

vi.mock('@/lib/server/env', () => ({ Env: envMock }));
vi.mock('@roomote/redis', () => ({ getRedis: () => redisMock }));
vi.mock('../environment-variables', () => ({
  assertAdmin: (auth: UserAuthSuccess) => {
    if (!auth.isAdmin) {
      throw new Error('Admin required');
    }
  },
}));
vi.mock('./index', () => ({
  isTelegramPairingAvailable: () => Boolean(envMock.R_TELEGRAM_PAIRING_URL),
  saveCommsAuthConfigCommand: saveCommsAuthConfigMock,
}));

vi.mock('./telegram-profile-photo', () => ({
  setTelegramBotProfilePhotoBestEffort: profilePhotoMock,
}));

import {
  checkTelegramPairingCommand,
  startTelegramPairingCommand,
} from './telegram-pairing';

const CHILD_BOT_TOKEN = '7000000003:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PAIRING_ID = '0b7ab291-5faf-4c4e-9f5d-1a2b3c4d5e6f';

function buildMockAuth(
  overrides: Partial<UserAuthSuccess> = {},
): UserAuthSuccess {
  return {
    success: true,
    userType: 'user',
    userId: 'pairing-test-user',
    isAdmin: true,
    ...overrides,
  } as UserAuthSuccess;
}

function stubFetchJson(status: number, payload: unknown) {
  const fetchMock = vi.fn(async () =>
    Response.json(payload as Record<string, unknown>, { status }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('telegram pairing commands', () => {
  beforeEach(() => {
    redisStore.clear();
    envMock.R_TELEGRAM_PAIRING_URL = 'https://pairing.example.com';
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    profilePhotoMock.mockResolvedValue({
      updated: true,
      error: null,
    });
  });

  describe('startTelegramPairingCommand', () => {
    it('rejects non-admin users', async () => {
      await expect(
        startTelegramPairingCommand(buildMockAuth({ isAdmin: false })),
      ).rejects.toThrow('Admin required');
    });

    it('throws a friendly error when pairing is not configured', async () => {
      envMock.R_TELEGRAM_PAIRING_URL = undefined;

      await expect(
        startTelegramPairingCommand(buildMockAuth()),
      ).rejects.toThrow(/not configured/);
    });

    it('creates a pairing and stores the poll token server-side', async () => {
      const fetchMock = stubFetchJson(201, {
        pairingId: PAIRING_ID,
        pollToken: 'secret-poll-token',
        suggestedUsername: 'roomote_abc_bot',
        deepLink: 'https://t.me/newbot/RoomoteSetupBot/roomote_abc_bot',
        expiresInSeconds: 900,
      });

      const result = await startTelegramPairingCommand(buildMockAuth());

      expect(fetchMock).toHaveBeenCalledWith(
        'https://pairing.example.com/api/webhooks/telegram-pairing',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(result).toEqual({
        pairingId: PAIRING_ID,
        deepLink: 'https://t.me/newbot/RoomoteSetupBot/roomote_abc_bot',
        suggestedUsername: 'roomote_abc_bot',
        expiresInSeconds: 900,
      });
      // The poll token stays server-side and is never returned.
      expect(redisStore.get(`telegram-pairing-client:${PAIRING_ID}`)).toBe(
        'secret-poll-token',
      );
    });

    it('surfaces a friendly error when the service is unreachable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('network down');
        }),
      );

      await expect(
        startTelegramPairingCommand(buildMockAuth()),
      ).rejects.toThrow(/Could not reach the Telegram setup service/);
    });
  });

  describe('checkTelegramPairingCommand', () => {
    it('reports expired when no poll token is stored', async () => {
      await expect(
        checkTelegramPairingCommand(buildMockAuth(), {
          pairingId: PAIRING_ID,
        }),
      ).resolves.toEqual({ status: 'expired' });
    });

    it('reports pending while the pairing is not ready', async () => {
      redisStore.set(`telegram-pairing-client:${PAIRING_ID}`, 'token');
      stubFetchJson(200, { status: 'pending' });

      await expect(
        checkTelegramPairingCommand(buildMockAuth(), {
          pairingId: PAIRING_ID,
        }),
      ).resolves.toEqual({ status: 'pending' });
      expect(saveCommsAuthConfigMock).not.toHaveBeenCalled();
    });

    it('saves the bot token through the shared save path when ready', async () => {
      redisStore.set(`telegram-pairing-client:${PAIRING_ID}`, 'token');
      stubFetchJson(200, {
        status: 'ready',
        token: CHILD_BOT_TOKEN,
        botUsername: 'roomote_abc_bot',
      });

      const auth = buildMockAuth();
      const result = await checkTelegramPairingCommand(auth, {
        pairingId: PAIRING_ID,
      });

      expect(saveCommsAuthConfigMock).toHaveBeenCalledWith(auth, {
        provider: 'telegram',
        values: { R_TELEGRAM_BOT_TOKEN: CHILD_BOT_TOKEN },
      });
      expect(profilePhotoMock).toHaveBeenCalledWith({
        botToken: CHILD_BOT_TOKEN,
      });
      expect(result).toEqual({
        status: 'ready',
        botUsername: 'roomote_abc_bot',
        telegramWebhook: { registered: true, error: null },
        telegramProfilePhoto: { updated: true, error: null },
      });
      expect(redisStore.has(`telegram-pairing-client:${PAIRING_ID}`)).toBe(
        false,
      );
    });

    it('recovers the one-shot token from the stash when persistence fails', async () => {
      redisStore.set(`telegram-pairing-client:${PAIRING_ID}`, 'token');
      stubFetchJson(200, {
        status: 'ready',
        token: CHILD_BOT_TOKEN,
        botUsername: 'roomote_abc_bot',
      });
      saveCommsAuthConfigMock.mockRejectedValueOnce(new Error('db down'));

      await expect(
        checkTelegramPairingCommand(buildMockAuth(), {
          pairingId: PAIRING_ID,
        }),
      ).rejects.toThrow('db down');
      expect(redisStore.has(`telegram-pairing-result:${PAIRING_ID}`)).toBe(
        true,
      );

      // The service has already consumed the pairing; the retry must succeed
      // from the stash without reaching the service again.
      const fetchMock = stubFetchJson(404, { error: 'Unknown pairing.' });
      const result = await checkTelegramPairingCommand(buildMockAuth(), {
        pairingId: PAIRING_ID,
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        status: 'ready',
        botUsername: 'roomote_abc_bot',
        telegramWebhook: { registered: true, error: null },
        telegramProfilePhoto: { updated: true, error: null },
      });
      expect(redisStore.has(`telegram-pairing-result:${PAIRING_ID}`)).toBe(
        false,
      );
      expect(redisStore.has(`telegram-pairing-client:${PAIRING_ID}`)).toBe(
        false,
      );
    });

    it('keeps pairing successful when the profile photo cannot be set', async () => {
      redisStore.set(`telegram-pairing-client:${PAIRING_ID}`, 'token');
      stubFetchJson(200, {
        status: 'ready',
        token: CHILD_BOT_TOKEN,
        botUsername: 'roomote_abc_bot',
      });
      profilePhotoMock.mockResolvedValue({
        updated: false,
        error: 'Photo dimensions are invalid',
      });

      await expect(
        checkTelegramPairingCommand(buildMockAuth(), {
          pairingId: PAIRING_ID,
        }),
      ).resolves.toEqual({
        status: 'ready',
        botUsername: 'roomote_abc_bot',
        telegramWebhook: { registered: true, error: null },
        telegramProfilePhoto: {
          updated: false,
          error: 'Photo dimensions are invalid',
        },
      });
    });

    it('treats a 404 from the service as an expired pairing', async () => {
      redisStore.set(`telegram-pairing-client:${PAIRING_ID}`, 'token');
      stubFetchJson(404, { error: 'Unknown pairing.' });

      await expect(
        checkTelegramPairingCommand(buildMockAuth(), {
          pairingId: PAIRING_ID,
        }),
      ).resolves.toEqual({ status: 'expired' });
      expect(redisStore.has(`telegram-pairing-client:${PAIRING_ID}`)).toBe(
        false,
      );
    });

    it('rejects a malformed token without saving it', async () => {
      redisStore.set(`telegram-pairing-client:${PAIRING_ID}`, 'token');
      stubFetchJson(200, { status: 'ready', token: 'not-a-bot-token' });

      await expect(
        checkTelegramPairingCommand(buildMockAuth(), {
          pairingId: PAIRING_ID,
        }),
      ).rejects.toThrow(/invalid bot token/);
      expect(saveCommsAuthConfigMock).not.toHaveBeenCalled();
    });
  });
});
