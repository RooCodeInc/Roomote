import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  execMock,
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
  execMock: vi.fn(),
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
    get: getMock,
    multi: multiMock,
    expire: expireMock,
    rpush: rpushMock,
    set: setMock,
  })),
}));

import {
  getCommunicationMessages,
  getLatestInboundMessageId,
  prependCommunicationMessages,
  queueCommunicationMessage,
  setLatestInboundMessageId,
} from '../messages';

describe('communication message queues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpushMock.mockResolvedValue(1);
    expireMock.mockResolvedValue(1);
    execMock.mockResolvedValue([]);

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
});
