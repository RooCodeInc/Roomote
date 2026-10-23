import { randomInt } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { getRedis } from '@roomote/redis';

const { callback } = vi.hoisted(() => ({ callback: vi.fn() }));
vi.mock('../callback-actions', () => ({
  handleTelegramCallbackQuery: callback,
  handleTelegramSuggestionReaction: vi.fn(),
}));
vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  resolveTelegramRuntimeCredentials: async () => ({
    webhookSecret: 'disposable-webhook-secret',
  }),
}));

import { telegram } from '../index';

describe('Telegram webhook claim ownership with real Redis', () => {
  const keys: string[] = [];
  const app = new Hono().route('/telegram', telegram);
  app.onError(
    () => new Response('Controlled handler failure', { status: 500 }),
  );

  afterEach(async () => {
    if (keys.length) await getRedis().del(...keys.splice(0));
    callback.mockReset();
  });

  function stimulus() {
    const updateId = randomInt(1_000_000_000_000, 2_000_000_000_000);
    const key = `telegram:update:${updateId}`;
    keys.push(key);
    const body = {
      update_id: updateId,
      callback_query: {
        id: `fixture-${updateId}`,
        from: { id: 42, is_bot: false, first_name: 'Fixture' },
        data: 'controlled-callback',
        chat_instance: 'fixture-chat',
      },
    };
    return {
      updateId,
      key,
      send: () =>
        app.request('/telegram', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-telegram-bot-api-secret-token': 'disposable-webhook-secret',
          },
          body: JSON.stringify(body),
        }),
    };
  }

  it('keeps a reacquired claim when its previous handler fails late', async () => {
    const { updateId, key, send } = stimulus();
    let rejectFirst!: (error: Error) => void;
    let finishSecond!: () => void;
    callback
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishSecond = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const first = send();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    // Exercise Redis's actual expiry, accelerated only for the owned key.
    await getRedis().pexpire(key, 1);
    await vi.waitFor(async () => expect(await getRedis().exists(key)).toBe(0));
    const second = send();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2));
    const secondOwner = await getRedis().get(key);
    rejectFirst(new Error('Controlled late failure'));
    expect((await first).status).toBe(500);
    const retry = await send();
    finishSecond();
    expect((await second).status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true, duplicate: true });
    expect(callback).toHaveBeenCalledTimes(2);
    expect(await getRedis().get(key)).toBe(secondOwner);
    const observer = fork(
      fileURLToPath(new URL('./webhook-claim.observer.ts', import.meta.url)),
      [String(updateId)],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    try {
      expect(
        (
          await once(observer, 'message', {
            signal: AbortSignal.timeout(30_000),
          })
        )[0],
      ).toEqual({ claimed: false });
    } finally {
      observer.kill('SIGKILL');
    }
  }, 35_000);

  it('releases the current failed claim so the same delivery can recover once', async () => {
    const { key, send } = stimulus();
    callback
      .mockRejectedValueOnce(new Error('Controlled failure'))
      .mockResolvedValue(undefined);
    expect((await send()).status).toBe(500);
    expect(await getRedis().exists(key)).toBe(0);
    expect(await (await send()).json()).toEqual({
      ok: true,
      callbackHandled: true,
    });
    expect(await (await send()).json()).toEqual({ ok: true, duplicate: true });
    expect(callback).toHaveBeenCalledTimes(2);
    expect(await getRedis().ttl(key)).toBeGreaterThan(290);
  });
});
