import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MockTelegramServer,
  TELEGRAM_MESSAGE_TEXT_LIMIT,
  computeTelegramEntities,
  type MockTelegramState,
} from '../mock-telegram-server';
import { TelegramCommunicationProvider } from '../telegram-provider';

const BOT_TOKEN = '7000000001:mock-telegram-token';

function baseState(): MockTelegramState {
  return {
    bot: {
      id: 7_000_000_001,
      username: 'roomote_mock_bot',
      first_name: 'Roomote',
    },
    chats: [
      { id: 111000111, type: 'private', first_name: 'Dan' },
      { id: -100222000222, type: 'supergroup', title: 'roomote-dev' },
    ],
    users: [{ id: 111000111, first_name: 'Dan', username: 'dan_mock' }],
    messages: [
      {
        message_id: 1000,
        chat_id: '111000111',
        date: 1_750_000_000,
        from: { id: 111000111, first_name: 'Dan', username: 'dan_mock' },
        text: 'please look into the flaky login test',
        reactions: [],
      },
    ],
  };
}

async function startServer(
  state: MockTelegramState = baseState(),
  roomoteTarget?: { webhookUrl: string; secretToken: string },
) {
  const server = new MockTelegramServer({
    state,
    ...(roomoteTarget ? { roomoteTarget } : {}),
  });
  const baseUrl = await server.start();
  return { server, baseUrl };
}

function providerFor(baseUrl: string, botToken = BOT_TOKEN) {
  return new TelegramCommunicationProvider({
    botToken,
    apiBaseUrl: baseUrl,
  });
}

describe('MockTelegramServer', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  function onCleanup(fn: () => Promise<void>) {
    cleanups.push(fn);
  }

  it('stores a bot message posted through the real provider and anchors the reply', async () => {
    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    const provider = providerFor(baseUrl);
    const result = await provider.postMessage({
      channelId: '111000111',
      text: 'On it — taking a look now.',
      replyToMessageId: '1000',
    });

    expect(result.channelId).toBe('111000111');

    const messages = server.getState().messages ?? [];
    const botMessage = messages.find((m) => m.from.is_bot);
    expect(botMessage).toBeDefined();
    expect(botMessage?.text).toBe('On it — taking a look now.');
    expect(botMessage?.reply_to_message_id).toBe(1000);
    expect(result.messageId).toBe(String(botMessage?.message_id));
  });

  it('splits long markdown into multiple messages under the 4096 limit with reply on first and buttons on last', async () => {
    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    const provider = providerFor(baseUrl);
    const line = 'x'.repeat(100);
    const longText = Array.from({ length: 120 }, () => line).join('\n');

    await provider.postMessage({
      channelId: '111000111',
      text: longText,
      textFormat: 'markdown',
      replyToMessageId: '1000',
      buttons: [[{ text: 'Cancel task', callbackData: 'cancel_task:job-1' }]],
    });

    const botMessages = (server.getState().messages ?? []).filter(
      (m) => m.from.is_bot,
    );
    expect(botMessages.length).toBeGreaterThan(1);

    for (const message of botMessages) {
      expect((message.text ?? '').length).toBeLessThanOrEqual(
        TELEGRAM_MESSAGE_TEXT_LIMIT,
      );
    }

    expect(botMessages[0]?.reply_to_message_id).toBe(1000);
    expect(
      botMessages.slice(1).every((m) => m.reply_to_message_id === undefined),
    ).toBe(true);

    const withButtons = botMessages.filter((m) => m.reply_markup !== undefined);
    expect(withButtons).toHaveLength(1);
    expect(withButtons[0]?.message_id).toBe(
      botMessages[botMessages.length - 1]?.message_id,
    );
  });

  it('rejects sendMessage text over the Telegram limit', async () => {
    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    const response = await fetch(`${baseUrl}/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: 111000111,
        text: 'y'.repeat(TELEGRAM_MESSAGE_TEXT_LIMIT + 1),
      }),
    });

    expect(response.status).toBe(400);
    const parsed = (await response.json()) as {
      ok: boolean;
      description: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.description).toContain('message is too long');
  });

  it('falls back to plain text when HTML parse mode is rejected', async () => {
    const state = baseState();
    state.behavior = { rejectHtmlParseMode: true };
    const { server, baseUrl } = await startServer(state);
    onCleanup(() => server.stop());

    const provider = providerFor(baseUrl);
    await provider.postMessage({
      channelId: '111000111',
      text: 'Some **bold** update',
      textFormat: 'markdown',
    });

    const botMessage = (server.getState().messages ?? []).find(
      (m) => m.from.is_bot,
    );
    expect(botMessage?.text).toBe('Some **bold** update');
    expect(botMessage?.parse_mode).toBeUndefined();
  });

  it('falls back to a caption + link text message when the photo is rejected', async () => {
    const state = baseState();
    state.behavior = { rejectPhotos: true };
    const { server, baseUrl } = await startServer(state);
    onCleanup(() => server.stop());

    const provider = providerFor(baseUrl);
    await provider.postMessage({
      channelId: '111000111',
      images: [
        {
          url: 'https://artifacts.example.test/shot.png',
          altText: 'Screenshot',
        },
      ],
    });

    const botMessage = (server.getState().messages ?? []).find(
      (m) => m.from.is_bot,
    );
    expect(botMessage?.photo_url).toBeUndefined();
    expect(botMessage?.text).toBe(
      'Screenshot: https://artifacts.example.test/shot.png',
    );
  });

  it('maps reaction names onto the Telegram emoji set via setMessageReaction', async () => {
    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    const provider = providerFor(baseUrl);
    await provider.addReaction({
      channelId: '111000111',
      messageId: '1000',
      name: 'eyes',
    });

    const message = (server.getState().messages ?? []).find(
      (m) => m.message_id === 1000,
    );
    expect(message?.reactions).toEqual(['👀']);
  });

  it('deletes bot messages and errors on a second delete', async () => {
    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    const provider = providerFor(baseUrl);
    const posted = await provider.postMessage({
      channelId: '111000111',
      text: 'Follow along: https://roomote.example.test/tasks/1',
    });

    await provider.deleteMessage({
      channelId: '111000111',
      messageId: posted.messageId,
    });

    const remaining = (server.getState().messages ?? []).filter(
      (m) => String(m.message_id) === posted.messageId,
    );
    expect(remaining).toHaveLength(0);

    await expect(
      provider.deleteMessage({
        channelId: '111000111',
        messageId: posted.messageId,
      }),
    ).rejects.toThrow('message to delete not found');
  });

  it('replaces text and keyboard in place through editMessageText', async () => {
    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    const provider = providerFor(baseUrl);
    const posted = await provider.postMessage({
      channelId: '111000111',
      text: 'Planning to run this in **web-app** — starting in ~5s.',
      textFormat: 'markdown',
      buttons: [[{ text: '✅ Yes', callbackData: 'route_ok:abc123XYZ789' }]],
    });

    await provider.editMessageText({
      channelId: '111000111',
      messageId: posted.messageId,
      text: 'Okay — where should I run this?',
      buttons: [
        [{ text: 'web-app', callbackData: 'route_pick:def456UVW012:0' }],
        [{ text: '✖️ Nevermind', callbackData: 'route_no:def456UVW012' }],
      ],
    });

    const message = (server.getState().messages ?? []).find(
      (m) => String(m.message_id) === posted.messageId,
    );
    expect(message?.text).toBe('Okay — where should I run this?');
    expect(message?.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: 'web-app', callback_data: 'route_pick:def456UVW012:0' }],
        [{ text: '✖️ Nevermind', callback_data: 'route_no:def456UVW012' }],
      ],
    });

    await expect(
      provider.editMessageText({
        channelId: '111000111',
        messageId: '424242',
        text: 'nothing here',
      }),
    ).rejects.toThrow('message to edit not found');
  });

  it('records typing chat actions through sendChatAction', async () => {
    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    const provider = providerFor(baseUrl);
    await provider.sendChatAction({ channelId: '111000111' });
    await provider.sendChatAction({
      channelId: '-100222000222',
      action: 'upload_photo',
      threadId: '7',
    });

    expect(server.getState().chatActions).toEqual([
      { chat_id: '111000111', action: 'typing' },
      {
        chat_id: '-100222000222',
        action: 'upload_photo',
        message_thread_id: 7,
      },
    ]);
  });

  it('rejects a chat action to an unknown chat', async () => {
    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    const provider = providerFor(baseUrl);
    await expect(
      provider.sendChatAction({ channelId: '999999999' }),
    ).rejects.toThrow('chat not found');
  });

  it('replaces the inline keyboard through editMessageReplyMarkup', async () => {
    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    const provider = providerFor(baseUrl);
    const posted = await provider.postMessage({
      channelId: '111000111',
      text: 'Task started.',
      buttons: [[{ text: 'Cancel task', callbackData: 'cancel_task:job-1' }]],
    });

    await provider.editMessageReplyMarkup({
      channelId: '111000111',
      messageId: posted.messageId,
    });

    const message = (server.getState().messages ?? []).find(
      (m) => String(m.message_id) === posted.messageId,
    );
    expect(message?.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it('rejects requests carrying a bot token outside acceptedBotTokens', async () => {
    const state = baseState();
    state.acceptedBotTokens = [BOT_TOKEN];
    const { server, baseUrl } = await startServer(state);
    onCleanup(() => server.stop());

    const provider = providerFor(baseUrl, 'wrong-token');
    await expect(
      provider.postMessage({
        channelId: '111000111',
        text: 'should never land',
      }),
    ).rejects.toThrow('Unauthorized');

    expect(
      (server.getState().messages ?? []).filter((m) => m.from.is_bot),
    ).toHaveLength(0);
  });

  it('rejects sends to unknown chats like real Telegram', async () => {
    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    const provider = providerFor(baseUrl);
    await expect(
      provider.postMessage({
        channelId: '999999999',
        text: 'nobody lives here',
      }),
    ).rejects.toThrow('chat not found');
  });

  it('round-trips webhook registration through the real provider', async () => {
    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    const provider = providerFor(baseUrl);
    await provider.registerWebhook({
      url: 'https://roomote.example.test/api/webhooks/telegram',
      secretToken: 'webhook-secret',
    });

    const info = await provider.getWebhookInfo();
    expect(info.url).toBe('https://roomote.example.test/api/webhooks/telegram');
    expect(info.allowedUpdates).toEqual(['message', 'callback_query']);
    expect(server.getState().webhook?.secretToken).toBe('webhook-secret');
  });

  it('dispatches updates to the Roomote webhook with the secret token header', async () => {
    const received: Array<{
      headers: IncomingMessage['headers'];
      body: string;
    }> = [];
    const webhook = await startStubWebhook(received);
    onCleanup(() => webhook.stop());

    const { server } = await startServer(baseState(), {
      webhookUrl: webhook.url,
      secretToken: 'telegram-webhook-secret',
    });
    onCleanup(() => server.stop());

    const first = await server.dispatch({
      kind: 'message',
      message: {
        chat: { id: 111000111, type: 'private', first_name: 'Dan' },
        from: { id: 111000111, first_name: 'Dan', username: 'dan_mock' },
        text: '/new fix the flaky login test',
      },
    });

    expect(first.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.headers['x-telegram-bot-api-secret-token']).toBe(
      'telegram-webhook-secret',
    );

    const update = JSON.parse(received[0]!.body) as {
      update_id: number;
      message: {
        message_id: number;
        text: string;
        entities?: Array<{ type: string; offset: number; length: number }>;
      };
    };
    expect(update.update_id).toBeGreaterThan(0);
    expect(update.message.text).toBe('/new fix the flaky login test');
    // Entities are computed the way real Telegram stamps them, so the
    // handler's bot_command detection works against injected updates.
    expect(update.message.entities).toEqual([
      { type: 'bot_command', offset: 0, length: 4 },
    ]);

    const second = await server.dispatch({
      kind: 'message',
      message: {
        chat: { id: 111000111, type: 'private', first_name: 'Dan' },
        from: { id: 111000111, first_name: 'Dan' },
        text: 'thanks!',
      },
    });
    expect(second.status).toBe(200);

    const secondUpdate = JSON.parse(received[1]!.body) as {
      update_id: number;
    };
    expect(secondUpdate.update_id).toBeGreaterThan(update.update_id);

    // Inbound messages are recorded so /mock/state shows the full transcript.
    const userMessages = (server.getState().messages ?? []).filter(
      (m) => !m.from.is_bot && m.text === 'thanks!',
    );
    expect(userMessages).toHaveLength(1);
  });
});

describe('computeTelegramEntities', () => {
  it('marks a leading bot command', () => {
    expect(computeTelegramEntities('/new fix the bug')).toEqual([
      { type: 'bot_command', offset: 0, length: 4 },
    ]);
  });

  it('marks a suffixed group command and a mention', () => {
    expect(
      computeTelegramEntities('@roomote_mock_bot /new@roomote_mock_bot go'),
    ).toEqual([
      { type: 'mention', offset: 0, length: 17 },
      { type: 'bot_command', offset: 18, length: 21 },
    ]);
  });

  it('marks mid-sentence commands the way Telegram does', () => {
    expect(computeTelegramEntities('try running /done later')).toEqual([
      { type: 'bot_command', offset: 12, length: 5 },
    ]);
  });

  it('ignores snake_case and email-like tokens', () => {
    expect(computeTelegramEntities('rename snake_case in a/b paths')).toEqual(
      [],
    );
  });
});

async function startStubWebhook(
  received: Array<{ headers: IncomingMessage['headers']; body: string }>,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      received.push({
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    },
  );

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/api/webhooks/telegram`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
