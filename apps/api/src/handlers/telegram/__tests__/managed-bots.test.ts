import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseTelegramUpdate,
  type TelegramUpdate,
} from '@roomote/communication/telegram-update';

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  begin: vi.fn(),
  disconnect: vi.fn(),
  route: vi.fn(),
  provision: vi.fn(),
  candidate: vi.fn(),
  credentials: vi.fn(),
  runtime: vi.fn(),
  select: vi.fn(),
  owner: vi.fn(),
  find: vi.fn(),
  queue: vi.fn(),
  attachments: vi.fn(),
  fetch: vi.fn(),
  session: vi.fn(),
  lock: vi.fn(),
  release: vi.fn(),
}));
vi.mock('@roomote/cloud-agents/server', () => ({
  fastAgentConversationRepository: { findById: mocks.session },
  acquireFastAgentTurnLock: mocks.lock,
}));
vi.mock('@roomote/db/server', () => ({
  activateTelegramManagedBot: mocks.activate,
  beginTelegramManagedBotPairing: mocks.begin,
  disconnectTelegramManagedBot: mocks.disconnect,
  getTelegramManagedBotRoute: mocks.route,
  provisionTelegramManagedBot: mocks.provision,
  recordTelegramManagedBotCandidate: mocks.candidate,
  resolveTelegramManagedBotCredentials: mocks.credentials,
  resolveTelegramRuntimeCredentials: mocks.runtime,
  selectTelegramManagedBotCandidate: mocks.select,
}));
vi.mock('@roomote/env', () => ({
  Env: {
    R_PUBLIC_URL: 'https://roomote.example',
    R_APP_URL: 'https://roomote.example',
    TELEGRAM_API_BASE_URL: 'https://telegram.invalid',
  },
}));
vi.mock('@roomote/sdk/server', () => ({
  findFastAgentSessionForProviderReply: mocks.find,
  queueFastAgentSurfaceReply: mocks.queue,
}));
vi.mock('../linked-user.js', () => ({
  resolveTelegramSenderUserId: mocks.owner,
}));
vi.mock('../attachments.js', () => ({
  attachTelegramMediaToQueuedMessage: mocks.attachments,
}));

import {
  handleTelegramManagedBotUpdate,
  telegramManagedBots,
} from '../managed-bots.js';

const candidateId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const pairingId = '33333333-3333-4333-8333-333333333333';
const bot = { id: 888, is_bot: true, username: 'edited_session_bot' };
const owner = { id: 123, is_bot: false, first_name: 'Owner' };
const route = {
  id: pairingId,
  botId: '888',
  botToken: '888:child_token',
  webhookSecret: 'child-secret',
  ownerTelegramUserId: '123',
  ownerUserId: 'roomote-owner',
  sessionId,
  state: 'active',
};
const message = (text = 'Continue this Session') => ({
  message_id: 7,
  chat: { id: 123, type: 'private' },
  from: owner,
  text,
});
const update = (text?: string): TelegramUpdate => ({
  update_id: 5,
  message: message(text),
});
const confirmation = (): TelegramUpdate => ({
  update_id: 6,
  callback_query: {
    id: 'callback',
    from: owner,
    message: message(),
    data: `sessionbot:${candidateId}`,
  },
});
const request = (body: unknown, secret: string | null = 'child-secret') =>
  telegramManagedBots.request('/888', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}),
    },
    body: JSON.stringify(body),
  });
const calls = () =>
  mocks.fetch.mock.calls.map(([url, init]) => ({
    url: String(url),
    body: JSON.parse(init.body),
  }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubEnv('TELEGRAM_API_BASE_URL', 'https://telegram.invalid');
  mocks.fetch.mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify({
          ok: true,
          result: url.endsWith('/getManagedBotToken')
            ? '888:child_token'
            : url.endsWith('/getMe')
              ? bot
              : true,
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  mocks.runtime.mockResolvedValue({ botToken: '999:main_token' });
  mocks.owner.mockResolvedValue('roomote-owner');
  mocks.find.mockResolvedValue({
    id: sessionId,
    userId: 'roomote-owner',
    conversation: { surface: 'telegram' },
  });
  mocks.begin.mockResolvedValue({
    pairing: { id: pairingId, sessionId },
    existing: false,
  });
  mocks.candidate.mockResolvedValue({
    pairing: { id: pairingId, sessionId },
    candidate: { id: candidateId, botUsername: 'edited_session_bot' },
  });
  mocks.select.mockResolvedValue({ id: pairingId });
  mocks.provision.mockImplementation(async (_id, _owner, provision) => {
    const result = await provision({
      botId: '888',
      webhookSecret: 'child-secret',
    });
    return { botUsername: result.botUsername, ticket: 'a'.repeat(43) };
  });
  mocks.route.mockImplementation(async () => ({ ...route }));
  mocks.credentials.mockResolvedValue({
    botToken: route.botToken,
    botId: '888',
    ownerTelegramUserId: '123',
    sessionId,
  });
  mocks.activate.mockResolvedValue(sessionId);
  mocks.disconnect.mockResolvedValue(true);
  mocks.queue.mockResolvedValue(true);
  mocks.session.mockResolvedValue({
    id: sessionId,
    userId: 'roomote-owner',
    conversation: {
      surface: 'telegram',
      workspaceId: '123',
      conversationId: 'old-conversation',
      replyTarget: { channelId: '123' },
    },
  });
  mocks.lock.mockResolvedValue(mocks.release);
  mocks.attachments.mockImplementation(
    async ({ queuedMessage }) => queuedMessage,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('main bot managed-session intake', () => {
  it('uses the read-only exact DM identity fallback when the reply lookup has no anchor', async () => {
    mocks.find.mockResolvedValue(null);
    await handleTelegramManagedBotUpdate(update('/sessionbot'));
    expect(mocks.begin).toHaveBeenCalledWith({
      ownerUserId: 'roomote-owner',
      ownerTelegramUserId: '123',
    });
    expect(
      calls()[0]!.body.reply_markup.keyboard[0][0].request_managed_bot,
    ).toBeDefined();
  });
  it('keeps an explicitly replied-to Session authoritative instead of falling back to another DM Session', async () => {
    mocks.find.mockResolvedValue(null);
    const body = update('/sessionbot');
    body.message!.reply_to_message = { message_id: 99 };
    await handleTelegramManagedBotUpdate(body);
    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: '99' }),
    );
    expect(mocks.begin).not.toHaveBeenCalled();
  });
  it('can select an existing private topic Session while keeping child delivery topic-free', async () => {
    const body = update('/sessionbot');
    body.message!.message_thread_id = 42;
    await handleTelegramManagedBotUpdate(body);
    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: '42' }),
    );
    expect(mocks.begin).toHaveBeenCalledWith({
      ownerUserId: 'roomote-owner',
      ownerTelegramUserId: '123',
      sessionId,
    });
    const callback = confirmation();
    callback.callback_query!.message!.message_thread_id = 42;
    await handleTelegramManagedBotUpdate(callback);
    expect(mocks.select).toHaveBeenCalledWith(candidateId, '123');
  });
  it('offers native creation only for an existing owner Session and explains the operator prerequisite', async () => {
    expect(await handleTelegramManagedBotUpdate(update('/sessionbot'))).toBe(
      true,
    );
    expect(mocks.find).toHaveBeenCalledWith({
      provider: 'telegram',
      workspaceId: '123',
      channelId: '123',
      userId: 'roomote-owner',
    });
    expect(mocks.begin).toHaveBeenCalledWith({
      sessionId,
      ownerUserId: 'roomote-owner',
      ownerTelegramUserId: '123',
    });
    const body = calls()[0]!.body;
    expect(body.text).toContain('Bot Management Mode');
    expect(body.reply_markup.keyboard[0][0]).toMatchObject({
      text: 'Yes, create bot',
      request_managed_bot: {
        request_id: 1,
        suggested_name: expect.any(String),
        suggested_username: expect.stringMatching(/_bot$/),
      },
    });
    expect(mocks.provision).not.toHaveBeenCalled();
  });
  it('does not create a new Session when no existing Session exists', async () => {
    mocks.find.mockResolvedValue(null);
    mocks.begin.mockResolvedValue(null);
    await handleTelegramManagedBotUpdate(update('/sessionbot'));
    expect(mocks.begin).toHaveBeenCalledWith({
      ownerUserId: 'roomote-owner',
      ownerTelegramUserId: '123',
    });
    expect(calls()[0]!.body.text).toContain(
      'No eligible existing private Fast Session',
    );
  });
  it('explicitly acknowledges an existing pending request instead of retargeting it', async () => {
    mocks.begin.mockResolvedValue({
      pairing: { id: pairingId, sessionId: 'prior-session' },
      existing: true,
    });
    await handleTelegramManagedBotUpdate(update('/sessionbot'));
    expect(calls()[0]!.body.text).toContain(
      'already pending for Session prior-session',
    );
  });
  it.each(['managed_bot', 'managed_bot_created'])(
    'accepts native %s without a request_id echo but only offers an explicit candidate confirmation',
    async (kind) => {
      const raw =
        kind === 'managed_bot'
          ? { update_id: 1, managed_bot: { user: owner, bot } }
          : {
              update_id: 1,
              message: { ...message(), managed_bot_created: { bot } },
            };
      const parsed = parseTelegramUpdate(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      await handleTelegramManagedBotUpdate(parsed.data);
      expect(mocks.candidate).toHaveBeenCalledWith({
        ownerTelegramUserId: '123',
        botId: '888',
        botUsername: 'edited_session_bot',
        ...(kind === 'managed_bot' ? { managementUpdateId: 1 } : {}),
      });
      expect(calls()[0]!.body.reply_markup.inline_keyboard[0][0]).toEqual({
        text: `Use @edited_session_bot for Session ${sessionId}`,
        callback_data: `sessionbot:${candidateId}`,
      });
      expect(mocks.select).not.toHaveBeenCalled();
      expect(mocks.provision).not.toHaveBeenCalled();
    },
  );
  it('does not infer a pairing from an unrequested managed-bot event', async () => {
    mocks.candidate.mockResolvedValue(null);
    await handleTelegramManagedBotUpdate({
      update_id: 1,
      managed_bot: { user: owner, bot },
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('gets the CHILD id token, verifies child identity, provisions its secret route, then sends its one-use deep link', async () => {
    await handleTelegramManagedBotUpdate(confirmation());
    expect(mocks.select).toHaveBeenCalledWith(candidateId, '123');
    expect(calls()).toEqual([
      {
        url: 'https://telegram.invalid/bot999:main_token/answerCallbackQuery',
        body: { callback_query_id: 'callback' },
      },
      {
        url: 'https://telegram.invalid/bot999:main_token/getManagedBotToken',
        body: { user_id: 888 },
      },
      { url: 'https://telegram.invalid/bot888:child_token/getMe', body: {} },
      {
        url: 'https://telegram.invalid/bot888:child_token/setWebhook',
        body: {
          url: 'https://roomote.example/api/webhooks/telegram/managed/888',
          secret_token: 'child-secret',
          allowed_updates: ['message', 'callback_query'],
        },
      },
      {
        url: 'https://telegram.invalid/bot999:main_token/sendMessage',
        body: expect.objectContaining({
          chat_id: '123',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: 'Open session bot',
                  url: `https://t.me/edited_session_bot?start=${'a'.repeat(43)}`,
                },
              ],
            ],
          },
        }),
      },
    ]);
  });
  it.each([undefined, 'wrong-owner', 'group'])(
    'rejects confirmation outside the owner private chat (%s)',
    async (kind) => {
      const body = confirmation();
      if (kind === undefined) body.callback_query!.message = undefined;
      if (kind === 'wrong-owner') body.callback_query!.from = { id: 777 };
      if (kind === 'group') body.callback_query!.message!.chat.type = 'group';
      await handleTelegramManagedBotUpdate(body);
      expect(mocks.select).not.toHaveBeenCalled();
      expect(mocks.provision).not.toHaveBeenCalled();
    },
  );
  it('does not provision expired/conflicting selections', async () => {
    mocks.select.mockResolvedValue(null);
    await handleTelegramManagedBotUpdate(confirmation());
    expect(mocks.provision).not.toHaveBeenCalled();
    expect(
      calls().some((call) => call.url.endsWith('getManagedBotToken')),
    ).toBe(false);
  });
  it('fails closed on getMe identity mismatch and remains retryable after token failure', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: true })),
    );
    mocks.fetch.mockRejectedValueOnce(
      new Error('secret token URL must never escape'),
    );
    await expect(
      handleTelegramManagedBotUpdate(confirmation()),
    ).rejects.toThrow('Managed Telegram getManagedBotToken failed');
    mocks.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify({
            ok: true,
            result: url.endsWith('getManagedBotToken')
              ? '888:child_token'
              : { ...bot, id: 777 },
          }),
        ),
    );
    await expect(
      handleTelegramManagedBotUpdate(confirmation()),
    ).rejects.toThrow('identity mismatch');
    expect(calls().some((call) => call.url.endsWith('setWebhook'))).toBe(false);
  });
  it.each(['transport', 'telegram'])(
    'does not let a failed main callback acknowledgement interrupt selection or provisioning (%s)',
    async (failure) => {
      if (failure === 'transport')
        mocks.fetch.mockRejectedValueOnce(
          new Error(
            'https://telegram.invalid/bot999:main_token/answerCallbackQuery',
          ),
        );
      else
        mocks.fetch.mockResolvedValueOnce(
          new Response(
            JSON.stringify({ ok: false, description: 'query is too old' }),
            { status: 400 },
          ),
        );
      await expect(
        handleTelegramManagedBotUpdate(confirmation()),
      ).resolves.toBe(true);
      expect(mocks.select).toHaveBeenCalledWith(candidateId, '123');
      expect(mocks.provision).toHaveBeenCalledOnce();
      expect(calls().at(-1)!.body.reply_markup.inline_keyboard[0][0].text).toBe(
        'Open session bot',
      );
    },
  );
});

describe('child bot isolated ingress', () => {
  it('does not migrate the Session while an existing turn owns the old route lock', async () => {
    mocks.lock.mockResolvedValue(null);
    expect(
      await (await request(update(`/start ${'a'.repeat(43)}`))).json(),
    ).toEqual({ ok: true, activated: false });
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(calls()[0]!.body.text).toContain('still responding');
  });
  it.each([null, 'main-secret', 'child-secreu'])(
    'requires the per-child secret (%s)',
    async (secret) => {
      expect((await request(update(), secret)).status).toBe(401);
      expect(mocks.owner).not.toHaveBeenCalled();
      expect(mocks.queue).not.toHaveBeenCalled();
    },
  );
  it.each(['foreign-user', 'group', 'topic', 'mapping', 'sender-chat'])(
    'rejects unauthorized child ingress (%s)',
    async (kind) => {
      const body = update();
      if (kind === 'foreign-user') body.message!.from = { id: 777 };
      if (kind === 'group') body.message!.chat.type = 'group';
      if (kind === 'topic') body.message!.message_thread_id = 55;
      if (kind === 'mapping') mocks.owner.mockResolvedValue('different-owner');
      if (kind === 'sender-chat') body.message!.sender_chat = { id: 123 };
      expect((await request(body)).status).toBe(200);
      expect(mocks.queue).not.toHaveBeenCalled();
      expect(mocks.attachments).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );
  it('finishes the command/candidate/confirm/start journey on the stored Session, not a newly looked-up Session', async () => {
    await handleTelegramManagedBotUpdate(update('/sessionbot'));
    await handleTelegramManagedBotUpdate({
      update_id: 2,
      managed_bot: { user: owner, bot },
    });
    await handleTelegramManagedBotUpdate(confirmation());
    mocks.find.mockClear();
    mocks.fetch.mockClear();
    mocks.route.mockResolvedValueOnce({ ...route, state: 'ready' });
    expect(
      await (await request(update(`/start ${'a'.repeat(43)}`))).json(),
    ).toEqual({ ok: true, activated: true });
    expect(mocks.activate).toHaveBeenCalledWith('888', '123', 'a'.repeat(43));
    expect(await (await request(update())).json()).toEqual({
      ok: true,
      queued: true,
    });
    expect(mocks.queue).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        userId: 'roomote-owner',
        question: 'Continue this Session',
        currentMessageId: 'telegram-bot:888:5',
        replyToMessageId: '7',
      }),
    );
    expect(mocks.find).not.toHaveBeenCalled();
    expect(
      calls().every((call) => call.url.includes('/bot888:child_token/')),
    ).toBe(true);
  });
  it('downloads attachments with child credentials and queues them to the same Session', async () => {
    const body = update();
    body.message!.photo = [
      {
        file_id: 'child-photo',
        file_unique_id: 'photo',
        width: 20,
        height: 20,
      },
    ];
    mocks.attachments.mockImplementation(async ({ queuedMessage }) => ({
      ...queuedMessage,
      images: ['data:image/png;base64,test'],
      text: 'Extracted child attachment',
    }));
    expect((await request(body)).status).toBe(200);
    expect(mocks.attachments).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: '888:child_token' }),
    );
    expect(mocks.queue).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        question: 'Extracted child attachment',
        images: ['data:image/png;base64,test'],
      }),
    );
    expect(mocks.runtime).not.toHaveBeenCalled();
  });
  it('does not acknowledge failed durable admission and uses the same event identity on retry', async () => {
    mocks.queue.mockResolvedValueOnce(false);
    expect((await request(update())).status).toBe(503);
    expect((await request(update())).status).toBe(200);
    expect(mocks.queue.mock.calls[0]![0].currentMessageId).toBe(
      mocks.queue.mock.calls[1]![0].currentMessageId,
    );
  });
  it('checks revocation again after attachment work', async () => {
    mocks.credentials.mockResolvedValue(null);
    expect(await (await request(update())).json()).toEqual({
      ok: true,
      ignored: 'revoked',
    });
    expect(mocks.queue).not.toHaveBeenCalled();
  });
  it('rejects all global callback actions instead of handing off to main handlers', async () => {
    const body = confirmation();
    body.callback_query!.data = 'cancel_task:some-task';
    expect(await (await request(body)).json()).toEqual({
      ok: true,
      ignored: 'unsupported_action',
    });
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(calls()[0]!.url).toBe(
      'https://telegram.invalid/bot888:child_token/answerCallbackQuery',
    );
  });
  it('does not activate expired or replayed tickets, and never treats them as prompts', async () => {
    mocks.activate.mockResolvedValue(null);
    expect(
      await (await request(update(`/start ${'a'.repeat(43)}`))).json(),
    ).toEqual({ ok: true, activated: false });
    expect(mocks.queue).not.toHaveBeenCalled();
  });
  it('explains /new without changing sessions and disconnects without main-token sends', async () => {
    await request(update('/new another session'));
    expect(calls()[0]!.body.text).toContain(
      '/new does not create another Session',
    );
    mocks.fetch.mockClear();
    expect(await (await request(update('/disconnect'))).json()).toEqual({
      ok: true,
      disconnected: true,
    });
    expect(mocks.disconnect).toHaveBeenCalledWith('888', '123');
    expect(calls()).toEqual([
      {
        url: 'https://telegram.invalid/bot888:child_token/sendMessage',
        body: {
          chat_id: '123',
          text: 'Disconnected. This bot will no longer continue your Session. Your Session has not been deleted.',
        },
      },
    ]);
    expect(mocks.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.fetch.mock.invocationCallOrder[0]!,
    );
    mocks.route.mockResolvedValue(null);
    expect((await request(update())).status).toBe(401);
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(mocks.runtime).not.toHaveBeenCalled();
  });
  it.each(['transport', 'telegram'])(
    'keeps revocation successful and retries inert when its terminal receipt fails (%s)',
    async (failure) => {
      mocks.disconnect.mockImplementation(async () => {
        mocks.route.mockResolvedValue(null);
        return true;
      });
      if (failure === 'transport')
        mocks.fetch.mockRejectedValueOnce(
          new Error('https://telegram.invalid/bot888:child_token/sendMessage'),
        );
      else
        mocks.fetch.mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: false,
              description: 'bot888:child_token forbidden',
            }),
            { status: 403 },
          ),
        );
      const response = await request(update('/disconnect'));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, disconnected: true });
      expect((await request(update('/disconnect'))).status).toBe(401);
      expect((await request(update(`/start ${'a'.repeat(43)}`))).status).toBe(
        401,
      );
      expect(mocks.disconnect).toHaveBeenCalledOnce();
      expect(mocks.fetch).toHaveBeenCalledOnce();
      expect(mocks.activate).not.toHaveBeenCalled();
      expect(mocks.queue).not.toHaveBeenCalled();
      expect(mocks.runtime).not.toHaveBeenCalled();
      expect(calls()[0]!.body.text).not.toContain(sessionId);
    },
  );
  it('does not send a receipt when revocation did not succeed', async () => {
    mocks.disconnect.mockResolvedValue(false);
    expect(await (await request(update('/disconnect'))).json()).toEqual({
      ok: true,
      disconnected: false,
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('still rejects general actions when their callback acknowledgement fails', async () => {
    mocks.fetch.mockRejectedValueOnce(
      new Error(
        'https://telegram.invalid/bot888:child_token/answerCallbackQuery',
      ),
    );
    const body = confirmation();
    body.callback_query!.data = 'cancel_task:some-task';
    expect(await (await request(body)).json()).toEqual({
      ok: true,
      ignored: 'unsupported_action',
    });
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });
});
