import { describe, expect, it, vi } from 'vitest';

import { UnsupportedCommunicationOperationError } from '../provider';
import { TelegramCommunicationProvider } from '../telegram-provider';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

describe('TelegramCommunicationProvider', () => {
  it('creates Telegram forum topics for task conversations', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        result: {
          message_thread_id: 77,
          name: 'Fix the flaky login test',
        },
      }),
    );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      provider.createForumTopic({
        channelId: '123',
        name: 'Fix the flaky login test',
      }),
    ).resolves.toEqual({
      messageThreadId: '77',
      name: 'Fix the flaky login test',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://telegram.example.test/botbot-token/createForumTopic',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          chat_id: '123',
          name: 'Fix the flaky login test',
        }),
      }),
    );
  });

  it('sends Telegram messages through the Bot API', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        result: {
          message_id: 99,
          message_thread_id: 7,
        },
      }),
    );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      provider.postMessage({
        channelId: '-100456',
        threadId: '7',
        replyToMessageId: '42',
        text: 'hello from Roomote',
      }),
    ).resolves.toEqual({
      provider: 'telegram',
      channelId: '-100456',
      messageId: '99',
      threadId: '7',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://telegram.example.test/botbot-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: '-100456',
          text: 'hello from Roomote',
          link_preview_options: {
            is_disabled: true,
          },
          message_thread_id: 7,
          reply_parameters: {
            message_id: 42,
            allow_sending_without_reply: true,
          },
        }),
      }),
    );
  });

  it('sends markdown text as Telegram HTML when textFormat is markdown', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        result: { message_id: 100 },
      }),
    );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await provider.postMessage({
      channelId: '123',
      text: '**done** see [task](https://example.test/t/1)',
      textFormat: 'markdown',
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    ) as { text: string; parse_mode?: string };

    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toBe(
      '<b>done</b> see <a href="https://example.test/t/1">task</a>',
    );
  });

  it('falls back to plain text when Telegram rejects HTML entities', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ok: false,
            error_code: 400,
            description:
              "Bad Request: can't parse entities: unexpected end tag",
          },
          400,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: { message_id: 101 },
        }),
      );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    const result = await provider.postMessage({
      channelId: '123',
      text: '**broken markdown',
      textFormat: 'markdown',
    });

    expect(result.messageId).toBe('101');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondBody = JSON.parse(
      (fetchMock.mock.calls[1]?.[1] as RequestInit).body as string,
    ) as { text: string; parse_mode?: string };

    expect(secondBody.parse_mode).toBeUndefined();
    expect(secondBody.text).toBe('**broken markdown');
  });

  it('splits long messages into multiple sends and anchors the reply on the first', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { message_id: 200 } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { message_id: 201 } }),
      );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    const longText = Array.from(
      { length: 200 },
      (_, i) => `line ${i} ${'x'.repeat(30)}`,
    ).join('\n');
    const result = await provider.postMessage({
      channelId: '123',
      replyToMessageId: '42',
      text: longText,
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(result.messageId).toBe('200');

    const firstBody = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    ) as { reply_parameters?: unknown };
    const secondBody = JSON.parse(
      (fetchMock.mock.calls[1]?.[1] as RequestInit).body as string,
    ) as { reply_parameters?: unknown };

    expect(firstBody.reply_parameters).toBeDefined();
    expect(secondBody.reply_parameters).toBeUndefined();
  });

  it('requires text or images for outbound Telegram messages', async () => {
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      fetch: vi.fn() as typeof fetch,
    });

    await expect(
      provider.postMessage({
        channelId: '123',
        text: '   ',
      }),
    ).rejects.toThrow('Telegram postMessage requires text or images');
  });

  it('sends images as native photos with captions', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { message_id: 300 } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { message_id: 301 } }),
      );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    const result = await provider.postMessage({
      channelId: '123',
      text: 'screenshot attached',
      images: [{ url: 'https://example.test/shot.png', altText: 'the shot' }],
    });

    expect(result.messageId).toBe('300');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://telegram.example.test/botbot-token/sendPhoto',
    );

    const photoBody = JSON.parse(
      (fetchMock.mock.calls[1]?.[1] as RequestInit).body as string,
    ) as { photo: string; caption?: string };

    expect(photoBody.photo).toBe('https://example.test/shot.png');
    expect(photoBody.caption).toBe('the shot');
  });

  it('anchors the reply on the photo for image-only messages', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { message_id: 310 } }),
      );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    const result = await provider.postMessage({
      channelId: '123',
      replyToMessageId: '42',
      images: [{ url: 'https://example.test/shot.png', altText: 'the shot' }],
    });

    expect(result.messageId).toBe('310');

    const photoBody = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    ) as { reply_parameters?: { message_id: number } };

    expect(photoBody.reply_parameters?.message_id).toBe(42);
  });

  it('falls back to a link message when sendPhoto fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ok: false,
            error_code: 400,
            description:
              'Bad Request: wrong file identifier/HTTP URL specified',
          },
          400,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { message_id: 320 } }),
      );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    const result = await provider.postMessage({
      channelId: '123',
      images: [{ url: 'https://example.test/shot.png', altText: 'the shot' }],
    });

    expect(result.messageId).toBe('320');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://telegram.example.test/botbot-token/sendMessage',
    );

    const fallbackBody = JSON.parse(
      (fetchMock.mock.calls[1]?.[1] as RequestInit).body as string,
    ) as { text: string };

    expect(fallbackBody.text).toBe('the shot: https://example.test/shot.png');
  });

  it('attaches inline keyboard buttons to the last message sent', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { message_id: 400 } }),
      );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await provider.postMessage({
      channelId: '123',
      text: 'Started a task',
      buttons: [
        [
          { text: 'Cancel task', callbackData: 'cancel_task:42' },
          { text: 'Open task', url: 'https://example.test/task/42' },
        ],
      ],
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    ) as {
      reply_markup?: {
        inline_keyboard: Array<
          Array<{ text: string; callback_data?: string; url?: string }>
        >;
      };
    };

    expect(body.reply_markup?.inline_keyboard).toEqual([
      [
        { text: 'Cancel task', callback_data: 'cancel_task:42' },
        { text: 'Open task', url: 'https://example.test/task/42' },
      ],
    ]);
  });

  it('answers callback queries through the Bot API', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: true }));
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await provider.answerCallbackQuery({
      callbackQueryId: 'cb-1',
      text: 'Done.',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://telegram.example.test/botbot-token/answerCallbackQuery',
      expect.objectContaining({
        body: JSON.stringify({ callback_query_id: 'cb-1', text: 'Done.' }),
      }),
    );
  });

  it('clears inline keyboards via editMessageReplyMarkup', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: true }));
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await provider.editMessageReplyMarkup({
      channelId: '123',
      messageId: '777',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://telegram.example.test/botbot-token/editMessageReplyMarkup',
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: '123',
          message_id: 777,
          reply_markup: { inline_keyboard: [] },
        }),
      }),
    );
  });

  it('registers the webhook with callback_query updates enabled', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: true }));
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await provider.registerWebhook({
      url: 'https://app.example.test/api/webhooks/telegram',
      secretToken: 'hook-secret',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://telegram.example.test/botbot-token/setWebhook',
      expect.objectContaining({
        body: JSON.stringify({
          url: 'https://app.example.test/api/webhooks/telegram',
          secret_token: 'hook-secret',
          allowed_updates: ['message', 'callback_query'],
        }),
      }),
    );
  });

  it('normalizes getWebhookInfo results', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        result: {
          url: 'https://app.example.test/api/webhooks/telegram',
          pending_update_count: 2,
          last_error_message: '502 Bad Gateway',
          last_error_date: 1_783_200_000,
          allowed_updates: ['message', 'callback_query'],
        },
      }),
    );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await expect(provider.getWebhookInfo()).resolves.toEqual({
      url: 'https://app.example.test/api/webhooks/telegram',
      pendingUpdateCount: 2,
      lastErrorMessage: '502 Bad Gateway',
      lastErrorAtMs: 1_783_200_000_000,
      allowedUpdates: ['message', 'callback_query'],
    });
  });

  it('adds reactions through setMessageReaction with mapped emoji', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: true }));
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      provider.addReaction({
        channelId: '123',
        messageId: '77',
        name: 'eyes',
      }),
    ).resolves.toEqual({
      provider: 'telegram',
      channelId: '123',
      messageId: '77',
      name: 'eyes',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://telegram.example.test/botbot-token/setMessageReaction',
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: '123',
          message_id: 77,
          reaction: [{ type: 'emoji', emoji: '👀' }],
        }),
      }),
    );
  });

  it('rejects reactions Telegram does not support', async () => {
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      fetch: vi.fn() as typeof fetch,
    });

    await expect(
      provider.addReaction({
        channelId: '123',
        messageId: '77',
        name: 'white_check_mark',
      }),
    ).rejects.toBeInstanceOf(UnsupportedCommunicationOperationError);
  });

  it('reports Telegram history reads as unsupported operations', async () => {
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      fetch: vi.fn() as typeof fetch,
    });

    await expect(
      provider.fetchThreadMessages({
        channelId: '123',
        messageId: '42',
      }),
    ).rejects.toMatchObject({
      code: 'communication_operation_unsupported',
      provider: 'telegram',
      operation: 'fetchThreadMessages',
    });
    await expect(
      provider.fetchThreadMessages({
        channelId: '123',
        messageId: '42',
      }),
    ).rejects.toBeInstanceOf(UnsupportedCommunicationOperationError);

    await expect(
      provider.fetchChannelMessages({
        channelId: '123',
      }),
    ).rejects.toMatchObject({
      code: 'communication_operation_unsupported',
      provider: 'telegram',
      operation: 'fetchChannelMessages',
    });
  });
});
