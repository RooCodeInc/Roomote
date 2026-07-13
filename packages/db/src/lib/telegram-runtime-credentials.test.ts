import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveEffectiveDeploymentEnvVarsMock } = vi.hoisted(() => ({
  resolveEffectiveDeploymentEnvVarsMock: vi.fn(),
}));

vi.mock('./model-runtime-config', () => ({
  resolveEffectiveDeploymentEnvVars: resolveEffectiveDeploymentEnvVarsMock,
}));

import {
  invalidateTelegramRuntimeCredentialsCache,
  resolveTelegramRuntimeCredentials,
} from './telegram-runtime-credentials';

describe('resolveTelegramRuntimeCredentials', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    invalidateTelegramRuntimeCredentialsCache();
    process.env.R_TELEGRAM_BOT_TOKEN = '123:token';
    process.env.R_TELEGRAM_WEBHOOK_SECRET = 'secret';
    process.env.TELEGRAM_API_BASE_URL = 'https://telegram.example.test';
    resolveEffectiveDeploymentEnvVarsMock.mockResolvedValue({});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resolves the bot username from getMe using the configured token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: { username: 'RoomoteBot' },
        }),
        { status: 200 },
      ),
    );

    await expect(resolveTelegramRuntimeCredentials()).resolves.toEqual({
      botToken: '123:token',
      webhookSecret: 'secret',
      botUsername: 'RoomoteBot',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://telegram.example.test/bot123:token/getMe',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps credentials usable when Telegram cannot resolve the username', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    await expect(resolveTelegramRuntimeCredentials()).resolves.toEqual({
      botToken: '123:token',
      webhookSecret: 'secret',
      botUsername: null,
    });
  });

  it('retains the last-known username across a transient getMe failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T12:00:00Z'));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: { username: 'RoomoteBot' },
          }),
          { status: 200 },
        ),
      )
      .mockRejectedValueOnce(new Error('temporary outage'));

    await expect(resolveTelegramRuntimeCredentials()).resolves.toMatchObject({
      botUsername: 'RoomoteBot',
    });

    vi.advanceTimersByTime(31_000);

    await expect(resolveTelegramRuntimeCredentials()).resolves.toMatchObject({
      botUsername: 'RoomoteBot',
    });
  });
});
