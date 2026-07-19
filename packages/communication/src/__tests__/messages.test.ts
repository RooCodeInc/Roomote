import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  delMock,
  execMock,
  evalMock,
  expireMock,
  getMock,
  lrangeMock,
  multiDelMock,
  multiExpireMock,
  multiLpushMock,
  multiMock,
  rpushMock,
  setMock,
} = vi.hoisted(() => ({
  delMock: vi.fn(),
  execMock: vi.fn(),
  evalMock: vi.fn(),
  expireMock: vi.fn(),
  getMock: vi.fn(),
  lrangeMock: vi.fn(),
  multiDelMock: vi.fn(),
  multiExpireMock: vi.fn(),
  multiLpushMock: vi.fn(),
  multiMock: vi.fn(),
  rpushMock: vi.fn(),
  setMock: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: vi.fn(() => ({
    del: delMock,
    get: getMock,
    eval: evalMock,
    multi: multiMock,
    expire: expireMock,
    rpush: rpushMock,
    set: setMock,
  })),
}));

import {
  clearLatestUserMessageForReplyQuote,
  getCommunicationMessages,
  getLatestInboundMessageId,
  getLatestUserMessageForReplyQuote,
  prependCommunicationMessages,
  queueCommunicationMessage,
  queueCommunicationMessageOnce,
  setLatestInboundMessageId,
  setLatestUserMessageForReplyQuote,
  trackLatestUserMessageForReplyQuote,
} from '../messages';

describe('communication message queues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpushMock.mockResolvedValue(1);
    expireMock.mockResolvedValue(1);
    execMock.mockResolvedValue([]);
    evalMock.mockResolvedValue(1);

    const multi = {
      lpush: multiLpushMock,
      expire: multiExpireMock,
      lrange: lrangeMock,
      del: multiDelMock,
      exec: execMock,
    };

    multiLpushMock.mockReturnValue(multi);
    multiExpireMock.mockReturnValue(multi);
    lrangeMock.mockReturnValue(multi);
    multiDelMock.mockReturnValue(multi);
    multiMock.mockReturnValue(multi);
  });

  it('queues Slack messages under the legacy Slack key prefix', async () => {
    await queueCommunicationMessage('slack', 42, {
      text: 'hello',
      user: 'U123',
      ts: '111.222',
    });

    expect(rpushMock).toHaveBeenCalledWith(
      'slack:messages:42',
      JSON.stringify({
        text: 'hello',
        user: 'U123',
        ts: '111.222',
      }),
    );
    expect(expireMock).toHaveBeenCalledWith('slack:messages:42', 3600);
  });

  it('queues Teams messages under the Teams provider key prefix', async () => {
    await queueCommunicationMessage('teams', 43, {
      provider: 'teams',
      text: 'hello from teams',
      user: '29:user',
      ts: 'activity-1',
      channel: '19:channel',
      threadTs: 'activity-root',
    });

    expect(rpushMock).toHaveBeenCalledWith(
      'teams:messages:43',
      JSON.stringify({
        provider: 'teams',
        text: 'hello from teams',
        user: '29:user',
        ts: 'activity-1',
        channel: '19:channel',
        threadTs: 'activity-root',
      }),
    );
    expect(expireMock).toHaveBeenCalledWith('teams:messages:43', 3600);
  });

  it('queues a retried provider message only once by upstream id', async () => {
    const message = {
      provider: 'discord' as const,
      text: 'hello from Discord',
      user: 'discord-user-1',
      ts: 'message-1',
    };

    await expect(
      queueCommunicationMessageOnce('discord', 44, message),
    ).resolves.toBe(true);
    expect(evalMock).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('RPUSH'"),
      2,
      'discord:messages:44',
      'discord:messages:dedupe:44:message-1',
      JSON.stringify(message),
      '3600',
      '86400',
    );

    evalMock.mockResolvedValue(0);
    await expect(
      queueCommunicationMessageOnce('discord', 44, message),
    ).resolves.toBe(false);
  });

  it('prepends messages in delivery order for a provider queue', async () => {
    await prependCommunicationMessages('teams', 44, [
      {
        provider: 'teams',
        text: 'first',
        user: '29:user',
        ts: 'activity-1',
      },
      {
        provider: 'teams',
        text: 'second',
        user: '29:user',
        ts: 'activity-2',
      },
    ]);

    expect(multiLpushMock).toHaveBeenNthCalledWith(
      1,
      'teams:messages:44',
      JSON.stringify({
        provider: 'teams',
        text: 'second',
        user: '29:user',
        ts: 'activity-2',
      }),
    );
    expect(multiLpushMock).toHaveBeenNthCalledWith(
      2,
      'teams:messages:44',
      JSON.stringify({
        provider: 'teams',
        text: 'first',
        user: '29:user',
        ts: 'activity-1',
      }),
    );
    expect(multiExpireMock).toHaveBeenCalledWith('teams:messages:44', 3600);
  });

  it('drains and validates queued provider messages', async () => {
    const consoleErrorMock = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    execMock.mockResolvedValueOnce([
      [
        null,
        [
          JSON.stringify({
            provider: 'teams',
            text: 'good',
            user: '29:user',
            ts: 'activity-1',
          }),
          JSON.stringify({ provider: 'teams', user: 'missing text' }),
        ],
      ],
      [null, 1],
    ]);

    await expect(getCommunicationMessages('teams', 45)).resolves.toEqual([
      {
        provider: 'teams',
        text: 'good',
        user: '29:user',
        ts: 'activity-1',
      },
    ]);

    expect(lrangeMock).toHaveBeenCalledWith('teams:messages:45', 0, -1);
    expect(multiDelMock).toHaveBeenCalledWith('teams:messages:45');
    expect(consoleErrorMock).toHaveBeenCalledWith(
      expect.stringContaining(
        '[getCommunicationMessages] Failed to parse teams message for task run 45:',
      ),
    );
    consoleErrorMock.mockRestore();
  });

  describe('latest inbound message id tracker', () => {
    it('writes the latest inbound message id with a TTL', async () => {
      await setLatestInboundMessageId('telegram', 42, '998877');

      expect(setMock).toHaveBeenCalledWith(
        'telegram:latest_inbound_message_id:42',
        '998877',
        'EX',
        86_400,
      );
    });

    it('skips writing an empty message id', async () => {
      await setLatestInboundMessageId('telegram', 42, '   ');

      expect(setMock).not.toHaveBeenCalled();
    });

    it('reads the latest inbound message id and trims whitespace', async () => {
      getMock.mockResolvedValueOnce('  12345  ');

      await expect(getLatestInboundMessageId('telegram', 42)).resolves.toBe(
        '12345',
      );

      expect(getMock).toHaveBeenCalledWith(
        'telegram:latest_inbound_message_id:42',
      );
    });

    it('returns null when no latest message id is stored', async () => {
      getMock.mockResolvedValueOnce(null);

      await expect(
        getLatestInboundMessageId('telegram', 42),
      ).resolves.toBeNull();
    });
  });

  describe('latest user message reply-quote tracker', () => {
    it('writes the latest user message with a TTL', async () => {
      await setLatestUserMessageForReplyQuote('discord', 44, {
        text: 'Do it',
        userName: 'Matt Rubens',
      });

      expect(setMock).toHaveBeenCalledWith(
        'discord:latest_user_message:44',
        JSON.stringify({ text: 'Do it', userName: 'Matt Rubens' }),
        'EX',
        30 * 24 * 60 * 60,
      );
    });

    it('tracks through the non-throwing helper', async () => {
      await trackLatestUserMessageForReplyQuote({
        provider: 'discord',
        runId: 44,
        text: 'ship it',
        userName: 'Ada',
      });

      expect(setMock).toHaveBeenCalledWith(
        'discord:latest_user_message:44',
        JSON.stringify({ text: 'ship it', userName: 'Ada' }),
        'EX',
        30 * 24 * 60 * 60,
      );
    });

    it('reads the latest user message', async () => {
      getMock.mockResolvedValueOnce(
        JSON.stringify({ text: 'hello', userName: 'Bob' }),
      );

      await expect(
        getLatestUserMessageForReplyQuote('discord', 44),
      ).resolves.toEqual({
        text: 'hello',
        userName: 'Bob',
      });

      expect(getMock).toHaveBeenCalledWith('discord:latest_user_message:44');
    });

    it('clears the latest user message', async () => {
      delMock.mockResolvedValueOnce(1);

      await clearLatestUserMessageForReplyQuote('discord', 44);

      expect(delMock).toHaveBeenCalledWith('discord:latest_user_message:44');
    });
  });
});
