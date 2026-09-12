import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  adapter: null as unknown,
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    get: async (key: string) => mocks.store.get(key) ?? null,
    set: async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && mocks.store.has(key)) return null;
      if (args.includes('XX') && !mocks.store.has(key)) return null;
      mocks.store.set(key, value);
      return 'OK';
    },
    eval: async (
      script: string,
      keyCount: number,
      firstKey: string,
      ...args: (string | number)[]
    ) => {
      if (keyCount === 2) {
        const [recordKey, ownerId, record, ttl] = args as [
          string,
          string,
          string,
          string | number,
        ];
        if (mocks.store.get(firstKey) !== ownerId) return 0;
        if (ttl === 'keepTtl' && !mocks.store.has(recordKey)) return 0;
        mocks.store.set(recordKey, record);
        return 1;
      }

      const ownerId = String(args[0]);
      if (mocks.store.get(firstKey) !== ownerId) return 0;
      if (script.includes("redis.call('del'")) mocks.store.delete(firstKey);
      return 1;
    },
    zadd: async () => 1,
  }),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  attachCanonicalPrReviewActionMessage: vi.fn(),
  claimCanonicalPrReviewAction: vi.fn(),
  completeCanonicalPrReviewActionDispatch: vi.fn(),
  db: { query: { slackInstallations: {} } },
  eq: vi.fn(),
  findPrReviewAutoPreference: vi.fn(),
  retireCanonicalPrReviewActionsForDestination: vi.fn(),
  retireCanonicalPrReviewActionsForPullRequest: vi.fn(),
  slackInstallations: {},
  upsertPrReviewAutoPreference: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  buildResolvedSlackPrReviewMessageBlocks: vi.fn(),
  SlackNotifier: class {},
}));

vi.mock('../../communication-providers', () => ({
  getCommunicationProviderAdapter: async () => mocks.adapter,
}));

import {
  getThreadReplyFooterRecord,
  postTextThreadReplyWithFooter,
} from '@roomote/communication';
import { TelegramCommunicationProvider } from '@roomote/communication/telegram-provider';
import { retirePrReviewActionMessagesBestEffort } from '../pr-review-action';

function telegramResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Telegram PR review action carrier lifecycle', () => {
  beforeEach(() => {
    mocks.store.clear();
    mocks.adapter = null;
  });

  it('keeps retired buttons absent when the managed footer later relocates', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(telegramResponse({ message_id: 101 }))
      .mockResolvedValueOnce(telegramResponse(true))
      .mockResolvedValueOnce(telegramResponse({ message_id: 102 }))
      .mockResolvedValueOnce(telegramResponse(true));
    const provider = new TelegramCommunicationProvider({
      botToken: 'bot-token',
      apiBaseUrl: 'https://telegram.example.test',
      fetch: fetchMock as typeof fetch,
    });
    mocks.adapter = provider;
    const buttons = [
      [{ text: 'Resolve these issues', callbackData: 'prr:y:nonce' }],
      [
        { text: 'Auto-resolve on this PR', callbackData: 'prr:a:nonce' },
        { text: 'Dismiss', callbackData: 'prr:d:nonce' },
      ],
    ];

    await postTextThreadReplyWithFooter({
      provider,
      input: {
        channelId: '222',
        threadId: '7',
        text: 'Review feedback',
        buttons,
      },
      footerText: 'Reply anytime',
    });
    await retirePrReviewActionMessagesBestEffort([
      {
        provider: 'telegram',
        channelId: '222',
        threadId: '7',
        messageId: '101',
      },
    ]);

    expect(
      (await getThreadReplyFooterRecord('telegram', '222', '7'))?.buttons,
    ).toBeUndefined();

    await postTextThreadReplyWithFooter({
      provider,
      input: {
        channelId: '222',
        threadId: '7',
        text: 'Auto-resolve enabled',
      },
      footerText: 'Reply anytime',
    });

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      method: String(url).split('/').at(-1),
      body: JSON.parse(String((init as RequestInit).body)) as {
        reply_markup?: { inline_keyboard: unknown[][] };
      },
    }));
    expect(requests[0]).toMatchObject({
      method: 'sendMessage',
      body: {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Resolve these issues', callback_data: 'prr:y:nonce' }],
            [
              {
                text: 'Auto-resolve on this PR',
                callback_data: 'prr:a:nonce',
              },
              { text: 'Dismiss', callback_data: 'prr:d:nonce' },
            ],
          ],
        },
      },
    });
    expect(requests[1]).toMatchObject({
      method: 'editMessageReplyMarkup',
      body: { reply_markup: { inline_keyboard: [] } },
    });
    expect(requests[2]?.body.reply_markup).toBeUndefined();
    expect(requests[3]).toMatchObject({
      method: 'editMessageText',
      body: { reply_markup: { inline_keyboard: [] } },
    });
  });
});
