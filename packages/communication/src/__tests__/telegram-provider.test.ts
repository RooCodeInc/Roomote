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
  it('registers the supported slash commands', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse({ ok: true, result: true }));
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await provider.registerCommands();

    expect(
      fetchMock.mock.calls.map(([, init]) => JSON.parse(init!.body as string)),
    ).toEqual([
      {
        commands: [
          { command: 'new', description: 'Start a fresh task' },
          {
            command: 'goal',
            description: 'Keep working toward an objective',
          },
        ],
        scope: { type: 'all_group_chats' },
      },
      {
        commands: [
          { command: 'start', description: 'Show welcome and command help' },
          { command: 'help', description: 'Show command help' },
          { command: 'new', description: 'Start a fresh task' },
          {
            command: 'goal',
            description: 'Keep working toward an objective',
          },
        ],
        scope: { type: 'all_private_chats' },
      },
    ]);
  });

  it('retries transient idempotent Bot API failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false }, 500))
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { has_topics_enabled: false } }),
      );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
      maxRetries: 1,
    });

    await expect(provider.getBotInfo()).resolves.toEqual({
      hasTopicsEnabled: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shows native Thinking in a private chat topic with a stable draft id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: true }));
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await provider.sendThinkingDraft({
      channelId: '123',
      threadId: '77',
      draftId: 42,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://telegram.example.test/botbot-token/sendRichMessageDraft',
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: 123,
          draft_id: 42,
          rich_message: {
            markdown: '<tg-thinking>Roomote is working...</tg-thinking>',
          },
          message_thread_id: 77,
        }),
      }),
    );
  });

  it('streams text through the same native Telegram draft', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: true }));
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await provider.sendRichMessageDraft({
      channelId: '123',
      draftId: 42,
      text: '**Highlights**\n\n- First\n- Second',
      textFormat: 'markdown',
    });

    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      chat_id: 123,
      draft_id: 42,
      rich_message: {
        markdown: '**Highlights**\n\n- First\n- Second',
      },
    });
  });

  it('streams literal plain text through escaped Rich Markdown', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: true }));
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await provider.sendRichMessageDraft({
      channelId: '123',
      draftId: 42,
      text: '**literal** <b>not bold</b>',
    });

    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      chat_id: 123,
      draft_id: 42,
      rich_message: {
        markdown: '<p>**literal** &lt;b&gt;not bold&lt;/b&gt;</p>',
      },
    });
  });

  it('rejects an invalid native Thinking draft id before calling Telegram', async () => {
    const fetchMock = vi.fn();
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      provider.sendThinkingDraft({ channelId: '123', draftId: 0 }),
    ).rejects.toThrow('requires a non-zero draft id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a rich live draft above the ordinary text limit in one update', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: true }));
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      provider.sendRichMessageDraft({
        channelId: '123',
        draftId: 42,
        text: 'x'.repeat(4_097),
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps the latest chunk visible in an oversized rich draft', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: true }));
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });
    const text = `early ${'a'.repeat(40_000)} latest`;

    await provider.sendRichMessageDraft({
      channelId: '123',
      draftId: 42,
      text,
      textFormat: 'markdown',
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    ) as { rich_message: { markdown: string } };
    expect(body.rich_message.markdown).toContain('latest');
    expect(body.rich_message.markdown).not.toContain('early');
    expect(body.rich_message.markdown.length).toBeLessThanOrEqual(32_768);
  });

  it('rejects live drafts outside a numeric private chat', async () => {
    const fetchMock = vi.fn();
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      provider.sendThinkingDraft({ channelId: '-100123', draftId: 42 }),
    ).rejects.toThrow('requires a private-chat id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not retry an ambiguous server error for message delivery', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false }, 500))
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { message_id: 99 } }),
      );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      provider.postMessage({ channelId: '123', text: 'hello' }),
    ).rejects.toThrow('Telegram sendRichMessage failed (500)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('reads the private-chat topics capability from getMe', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { has_topics_enabled: true } }),
      );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await expect(provider.getBotInfo()).resolves.toEqual({
      hasTopicsEnabled: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://telegram.example.test/botbot-token/getMe',
      expect.objectContaining({ method: 'POST' }),
    );
  });

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

  it('renames Telegram forum topics', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        result: true,
      }),
    );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await provider.editForumTopic({
      channelId: '123',
      threadId: '77',
      name: 'Fix flaky login tests',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://telegram.example.test/botbot-token/editForumTopic',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          chat_id: '123',
          message_thread_id: 77,
          name: 'Fix flaky login tests',
        }),
      }),
    );
  });

  it('resolves and applies a Telegram-supported topic icon', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: [
            { emoji: '💡', custom_emoji_id: 'idea-icon' },
            { emoji: '🦠', custom_emoji_id: 'bug-icon' },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: true }));
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    const iconCustomEmojiId = await provider.resolveForumTopicIconCustomEmojiId(
      ['🦠', '💡'],
    );
    await provider.editForumTopic({
      channelId: '123',
      threadId: '77',
      name: 'Fix flaky login tests',
      iconCustomEmojiId,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://telegram.example.test/botbot-token/getForumTopicIconStickers',
      expect.objectContaining({ body: '{}' }),
    );
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({
      chat_id: '123',
      message_thread_id: 77,
      name: 'Fix flaky login tests',
      icon_custom_emoji_id: 'bug-icon',
    });
  });

  it('updates a forum topic icon without resending an unchanged name', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, result: true }));
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock,
    });

    await provider.editForumTopic({
      channelId: '123',
      threadId: '77',
      iconCustomEmojiId: 'idea-icon',
    });

    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      chat_id: '123',
      message_thread_id: 77,
      icon_custom_emoji_id: 'idea-icon',
    });
  });

  it('honors an explicit reply target on the first topic message', async () => {
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
      lastTextMessageId: '99',
      threadId: '7',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://telegram.example.test/botbot-token/sendRichMessage',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: '-100456',
          rich_message: { markdown: '<p>hello from Roomote</p>' },
          message_thread_id: 7,
          reply_parameters: {
            message_id: 42,
            allow_sending_without_reply: true,
          },
        }),
      }),
    );
  });

  it('omits explicit reply targets in private chats', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { message_id: 99 } }),
      );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await provider.postMessage({
      channelId: '123',
      replyToMessageId: '42',
      text: 'hello from Roomote',
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    ) as { reply_parameters?: unknown };
    expect(body.reply_parameters).toBeUndefined();
  });

  it('leaves messages free-floating when no reply target is supplied', async () => {
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

    await provider.postMessage({
      channelId: '-100456',
      threadId: '7',
      text: 'hello from Roomote',
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    ) as { reply_parameters?: unknown };

    expect(body.reply_parameters).toBeUndefined();
  });

  it('sends markdown text through Telegram native Rich Markdown', async () => {
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
    ) as { rich_message: { markdown: string } };

    expect(body.rich_message.markdown).toBe(
      '**done** see [task](https://example.test/t/1)',
    );
  });

  it('preserves paragraph and list Markdown for Telegram to render', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
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

    await provider.postMessage({
      channelId: '123',
      text: '**Highlights**\n\n- **First.** Details\n- **Second.** More',
      textFormat: 'markdown',
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    ) as { rich_message: { markdown: string } };
    expect(body.rich_message.markdown).toBe(
      '**Highlights**\n\n- **First.** Details\n- **Second.** More',
    );
  });

  it('does not fall back when Telegram rejects a rich message', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(
        {
          ok: false,
          error_code: 400,
          description: "Bad Request: can't parse entities: unexpected end tag",
        },
        400,
      ),
    );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      provider.postMessage({
        channelId: '123',
        text: '**broken markdown',
        textFormat: 'markdown',
      }),
    ).rejects.toThrow('Telegram sendRichMessage failed (400)');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('posts provider-native expandable HTML without compatibility fallback', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(
        {
          ok: false,
          error_code: 400,
          description: 'Bad Request: unsupported expandable blockquote',
        },
        400,
      ),
    );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      provider.postMessage({
        channelId: '123',
        text: 'Starting task…',
        htmlText: '<blockquote expandable>Starting task…</blockquote>',
      }),
    ).rejects.toThrow('Telegram sendRichMessage failed (400)');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('posts a native rich footer while preserving topic, reply, and keyboard fields', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        result: { message_id: 103, message_thread_id: 7 },
      }),
    );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await provider.postMessage({
      channelId: '-100456',
      threadId: '7',
      replyToMessageId: '42',
      text: '**Complete.**',
      textFormat: 'markdown',
      footerText: 'Reply anytime · [Open in Roomote](https://roomote.test/s/1)',
      buttons: [[{ text: 'Open', url: 'https://roomote.test/s/1' }]],
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://telegram.example.test/botbot-token/sendRichMessage',
    );
    expect(
      JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string),
    ).toEqual({
      chat_id: '-100456',
      rich_message: {
        markdown: [
          '**Complete.**',
          '',
          '<footer>Reply anytime · <a href="https://roomote.test/s/1">Open in Roomote</a></footer>',
        ].join('\n'),
      },
      message_thread_id: 7,
      reply_markup: {
        inline_keyboard: [[{ text: 'Open', url: 'https://roomote.test/s/1' }]],
      },
      reply_parameters: {
        message_id: 42,
        allow_sending_without_reply: true,
      },
    });
  });

  it('does not fall back after an ambiguous rich-message server failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false }, 500));
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      provider.postMessage({
        channelId: '123',
        text: 'Completed.',
        footerText: 'Open in Roomote: https://roomote.test/s/1',
      }),
    ).rejects.toThrow('Telegram sendRichMessage failed (500)');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps topic targeting on every long-message chunk and anchors only the first', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      jsonResponse({
        ok: true,
        result: { message_id: fetchMock.mock.calls.length + 199 },
      }),
    );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    const longText = Array.from(
      { length: 2_000 },
      (_, i) => `line ${i} ${'x'.repeat(30)}`,
    ).join('\n');
    const result = await provider.postMessage({
      channelId: '-100456',
      threadId: '7',
      replyToMessageId: '42',
      text: longText,
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(result.messageId).toBe('200');
    expect(result.lastTextMessageId).toBe(
      String(fetchMock.mock.calls.length + 199),
    );

    const firstBody = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    ) as { message_thread_id?: number; reply_parameters?: unknown };
    const lastBody = JSON.parse(
      (fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body as string,
    ) as { message_thread_id?: number; reply_parameters?: unknown };

    expect(firstBody.message_thread_id).toBe(7);
    expect(lastBody.message_thread_id).toBe(7);
    expect(firstBody.reply_parameters).toEqual({
      message_id: 42,
      allow_sending_without_reply: true,
    });
    expect(lastBody.reply_parameters).toBeUndefined();
  });

  it('uses a rich footer only on the final chunk of a split reply', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      jsonResponse({
        ok: true,
        result: { message_id: fetchMock.mock.calls.length + 200 },
      }),
    );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await provider.postMessage({
      channelId: '123',
      text: 'Long narrative. '.repeat(3_000),
      textFormat: 'markdown',
      footerText: 'Reply anytime · [Open in Roomote](https://roomote.test/s/1)',
    });

    const methods = fetchMock.mock.calls.map((call) =>
      String(call[0]).split('/').at(-1),
    );
    expect(methods.length).toBeGreaterThan(1);
    expect(methods.every((method) => method === 'sendRichMessage')).toBe(true);
    const bodies = fetchMock.mock.calls.map(
      (call) =>
        JSON.parse((call[1] as RequestInit).body as string) as {
          rich_message: { markdown: string };
        },
    );
    expect(
      bodies
        .slice(0, -1)
        .every((body) => !body.rich_message.markdown.includes('<footer>')),
    ).toBe(true);
    expect(bodies.at(-1)?.rich_message.markdown).toContain('<footer>');
    expect(
      bodies.every((body) => body.rich_message.markdown.length <= 32_768),
    ).toBe(true);
  });

  it('delivers exact-limit text unchanged in one message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { message_id: 202 } }),
      );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });
    const text = 'x'.repeat(4_096);

    await provider.postMessage({ channelId: '123', text });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string),
    ).toMatchObject({ rich_message: { markdown: `<p>${text}</p>` } });
  });

  it('preserves leading and trailing whitespace in delivered text', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { message_id: 203 } }),
      );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });
    const text = '\n  complete response  \n';

    await provider.postMessage({ channelId: '123', text });

    expect(
      JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string),
    ).toMatchObject({
      rich_message: {
        markdown: '<p><br>  complete response  <br></p>',
      },
    });
  });

  it('keeps payloads above 4096 together below the rich-message limit', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      jsonResponse({
        ok: true,
        result: { message_id: fetchMock.mock.calls.length + 202 },
      }),
    );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });
    const text = `${'first '.repeat(800)}\n\n${'safe '.repeat(1_000)}`;

    await provider.postMessage({ channelId: '123', text });

    expect(text.length).toBeGreaterThan(4_096);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string),
    ).toMatchObject({
      rich_message: {
        markdown: `<p>${'first '.repeat(800)}<br><br>${'safe '.repeat(1_000)}</p>`,
      },
    });
  });

  it('keeps embedded native HTML above 4096 with topic and reply semantics', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      jsonResponse({
        ok: true,
        result: {
          message_id: fetchMock.mock.calls.length + 210,
          message_thread_id: 7,
        },
      }),
    );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });
    const text = Array.from(
      { length: 180 },
      (_, index) => `**section ${index}** ${'body '.repeat(8)}`,
    ).join('\n');

    const result = await provider.postMessage({
      channelId: '-100456',
      threadId: '7',
      replyToMessageId: '42',
      text,
      htmlText: `<b>${'oversized'.repeat(600)}</b>`,
      textFormat: 'markdown',
    });

    const bodies = fetchMock.mock.calls.map(
      (call) =>
        JSON.parse((call[1] as RequestInit).body as string) as {
          rich_message: { markdown: string };
          message_thread_id?: number;
          reply_parameters?: { message_id: number };
        },
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.rich_message.markdown.length).toBeGreaterThan(4_096);
    expect(bodies.every((body) => body.message_thread_id === 7)).toBe(true);
    expect(bodies[0]?.reply_parameters?.message_id).toBe(42);
    expect(result.lastTextMessageId).toBe('211');
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

  it('treats an unchanged edit as an idempotent success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          ok: false,
          error_code: 400,
          description: 'Bad Request: message is not modified',
        },
        400,
      ),
    );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      provider.editMessageText({
        channelId: '123',
        messageId: '42',
        text: 'Still running',
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('edits markdown through the same native Rich Markdown payload', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: true }));
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await provider.editMessageText({
      channelId: '123',
      messageId: '42',
      text: '# Status\n\n- [x] Complete',
      textFormat: 'markdown',
    });

    expect(
      JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string),
    ).toMatchObject({
      rich_message: { markdown: '# Status\n\n- [x] Complete' },
    });
  });

  it('does not fall back when a rich edit is rejected', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(
        {
          ok: false,
          error_code: 400,
          description: 'Bad Request: unsupported expandable blockquote',
        },
        400,
      ),
    );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      provider.editMessageText({
        channelId: '123',
        messageId: '42',
        text: 'Roomote task\nRunning\n\nProgress\nWorking',
        htmlText:
          '<b>Roomote task</b>\nRunning\n\n<blockquote expandable>Working</blockquote>',
      }),
    ).rejects.toThrow('Telegram editMessageText failed (400)');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('edits native rich-message footers with the existing keyboard contract', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: true }));
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await provider.editMessageText({
      channelId: '123',
      messageId: '42',
      text: 'Completed.',
      footerText: 'Reply anytime · [Open in Roomote](https://roomote.test/s/1)',
      buttons: [[{ text: 'Open', url: 'https://roomote.test/s/1' }]],
    });

    expect(
      JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string),
    ).toEqual({
      chat_id: '123',
      message_id: 42,
      rich_message: {
        markdown: [
          '<p>Completed.</p>',
          '',
          '<footer>Reply anytime · <a href="https://roomote.test/s/1">Open in Roomote</a></footer>',
        ].join('\n'),
      },
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [[{ text: 'Open', url: 'https://roomote.test/s/1' }]],
      },
    });
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

  it('omits the reply target on a private-chat image-only message', async () => {
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

    expect(photoBody.reply_parameters).toBeUndefined();
  });

  it('treats whitespace-only text with an image as image-only', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { message_id: 311 } }),
      );
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });

    await provider.postMessage({
      channelId: '123',
      text: '\n',
      images: [{ url: 'https://example.test/shot.png', altText: 'the shot' }],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://telegram.example.test/botbot-token/sendPhoto',
    );
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
      'https://telegram.example.test/botbot-token/sendRichMessage',
    );

    const fallbackBody = JSON.parse(
      (fetchMock.mock.calls[1]?.[1] as RequestInit).body as string,
    ) as { rich_message: { markdown: string } };

    expect(fallbackBody.rich_message.markdown).toBe(
      '<p>the shot: https://example.test/shot.png</p>',
    );
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
          allowed_updates: ['message', 'callback_query', 'message_reaction'],
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
          allowed_updates: ['message', 'callback_query', 'message_reaction'],
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
      allowedUpdates: ['message', 'callback_query', 'message_reaction'],
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
