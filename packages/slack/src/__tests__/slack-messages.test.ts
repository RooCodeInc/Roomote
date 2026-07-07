const {
  delMock,
  execMock,
  expireMock,
  getMock,
  lrangeMock,
  multiDelMock,
  multiExpireMock,
  multiLpushMock,
  multiMock,
  rpushMock,
  saddMock,
  setMock,
} = vi.hoisted(() => ({
  delMock: vi.fn(),
  execMock: vi.fn(),
  expireMock: vi.fn(),
  getMock: vi.fn(),
  lrangeMock: vi.fn(),
  multiDelMock: vi.fn(),
  multiExpireMock: vi.fn(),
  multiLpushMock: vi.fn(),
  multiMock: vi.fn(),
  rpushMock: vi.fn(),
  saddMock: vi.fn(),
  setMock: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: vi.fn(() => ({
    del: delMock,
    multi: multiMock,
    expire: expireMock,
    get: getMock,
    rpush: rpushMock,
    sadd: saddMock,
    set: setMock,
  })),
}));

import {
  clearLatestUserMessage,
  clearSlackThreadExplicitMentionRequired,
  getLatestSlackBotReply,
  getLatestUserMessage,
  getSlackMessages,
  hasSlackThreadReplyContext,
  isSlackThreadExplicitMentionRequired,
  markSlackThreadExplicitMentionRequired,
  prependSlackMessages,
  setLatestSlackBotReply,
  setLatestUserMessage,
  trackLatestUserMessageForSlackQuote,
  trackSlackBotReply,
} from '../slack-messages';

describe('slack-messages', () => {
  const consoleErrorMock = vi
    .spyOn(console, 'error')
    .mockImplementation(() => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    saddMock.mockResolvedValue(1);
    expireMock.mockResolvedValue(1);
    setMock.mockResolvedValue('OK');
    delMock.mockResolvedValue(1);
    getMock.mockResolvedValue(null);
    rpushMock.mockResolvedValue(1);
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

  afterAll(() => {
    consoleErrorMock.mockRestore();
  });

  it('marks the posted bot reply as delivered in the thread set', async () => {
    await trackSlackBotReply('C123', '111.222', '999.888');

    expect(saddMock).toHaveBeenCalledWith(
      'slack:thread_delivered_messages:C123:111.222',
      '999.888',
    );
    expect(expireMock).toHaveBeenCalledWith(
      'slack:thread_delivered_messages:C123:111.222',
      30 * 24 * 60 * 60,
    );
  });

  it('stores the latest tracked bot reply for a thread', async () => {
    await setLatestSlackBotReply('C123', '111.222', '999.888', 'hello world');

    expect(setMock).toHaveBeenCalledWith(
      'slack:thread_latest_bot_reply:C123:111.222',
      JSON.stringify({ ts: '999.888', text: 'hello world' }),
      'EX',
      30 * 24 * 60 * 60,
    );
  });

  it('retrieves the latest tracked bot reply for a thread', async () => {
    getMock.mockResolvedValueOnce(
      JSON.stringify({ ts: '999.888', text: 'hello world' }),
    );

    await expect(getLatestSlackBotReply('C123', '111.222')).resolves.toEqual({
      ts: '999.888',
      text: 'hello world',
    });
  });

  it('round-trips the out-of-band flag on tracked bot replies', async () => {
    await setLatestSlackBotReply('C123', '111.222', '999.888', 'notification', {
      outOfBand: true,
    });

    expect(setMock).toHaveBeenCalledWith(
      'slack:thread_latest_bot_reply:C123:111.222',
      JSON.stringify({ ts: '999.888', text: 'notification', outOfBand: true }),
      'EX',
      30 * 24 * 60 * 60,
    );

    getMock.mockResolvedValueOnce(
      JSON.stringify({ ts: '999.888', text: 'notification', outOfBand: true }),
    );

    await expect(getLatestSlackBotReply('C123', '111.222')).resolves.toEqual({
      ts: '999.888',
      text: 'notification',
      outOfBand: true,
    });
  });

  it('returns null for missing or malformed tracked bot replies', async () => {
    getMock.mockResolvedValueOnce(null).mockResolvedValueOnce('not-json');

    await expect(getLatestSlackBotReply('C123', '111.222')).resolves.toBeNull();
    await expect(getLatestSlackBotReply('C123', '111.222')).resolves.toBeNull();
  });

  it('clears the explicit-mention flag when a new bot reply is tracked', async () => {
    await setLatestSlackBotReply('C123', '111.222', '999.888', 'hello world');

    expect(delMock).toHaveBeenCalledWith(
      'slack:thread_explicit_mention_required:C123:111.222',
    );
  });

  it('marks a thread as requiring an explicit mention', async () => {
    await markSlackThreadExplicitMentionRequired('C123', '111.222');

    expect(setMock).toHaveBeenCalledWith(
      'slack:thread_explicit_mention_required:C123:111.222',
      '1',
      'EX',
      30 * 24 * 60 * 60,
    );
  });

  it('reports whether a thread requires an explicit mention', async () => {
    getMock.mockResolvedValueOnce('1').mockResolvedValueOnce(null);

    await expect(
      isSlackThreadExplicitMentionRequired('C123', '111.222'),
    ).resolves.toBe(true);
    await expect(
      isSlackThreadExplicitMentionRequired('C123', '111.222'),
    ).resolves.toBe(false);
  });

  it('clears the explicit-mention flag for a thread', async () => {
    await clearSlackThreadExplicitMentionRequired('C123', '111.222');

    expect(delMock).toHaveBeenCalledWith(
      'slack:thread_explicit_mention_required:C123:111.222',
    );
  });

  it('stores the latest user message for a cloud job', async () => {
    await setLatestUserMessage(42, {
      text: 'Need a follow-up',
      userName: 'Brock',
    });

    expect(setMock).toHaveBeenCalledWith(
      'slack:latest_user_message:42',
      JSON.stringify({
        text: 'Need a follow-up',
        userName: 'Brock',
      }),
      'EX',
      30 * 24 * 60 * 60,
    );
  });

  it('tracks the latest user message for Slack quotes', async () => {
    await trackLatestUserMessageForSlackQuote({
      cloudJobId: 42,
      text: 'Need a follow-up',
      userName: 'Brock',
    });

    expect(setMock).toHaveBeenCalledWith(
      'slack:latest_user_message:42',
      JSON.stringify({
        text: 'Need a follow-up',
        userName: 'Brock',
      }),
      'EX',
      30 * 24 * 60 * 60,
    );
  });

  it('logs through the provided handler when quote tracking fails', async () => {
    const onError = vi.fn();
    const error = new Error('redis failed');
    setMock.mockRejectedValueOnce(error);

    await expect(
      trackLatestUserMessageForSlackQuote({
        cloudJobId: 42,
        text: 'Need a follow-up',
        userName: 'Brock',
        onError,
      }),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(error);
  });

  it('retrieves the latest user message for a cloud job', async () => {
    getMock.mockResolvedValueOnce(
      JSON.stringify({ text: 'Need a follow-up', userName: 'Brock' }),
    );

    await expect(getLatestUserMessage(42)).resolves.toEqual({
      text: 'Need a follow-up',
      userName: 'Brock',
    });
  });

  it('clears the latest user message for a cloud job', async () => {
    await clearLatestUserMessage(42);

    expect(delMock).toHaveBeenCalledWith('slack:latest_user_message:42');
  });

  it('does not throw when clearing the latest user message fails', async () => {
    delMock.mockRejectedValueOnce(new Error('redis failed'));

    await expect(clearLatestUserMessage(42)).resolves.toBeUndefined();

    expect(consoleErrorMock).toHaveBeenCalledWith(
      '[clearLatestUserMessage] Failed to clear latest user message for cloud job 42: redis failed',
    );
  });

  it('detects Slack thread reply context from either Slack task payload shape', () => {
    expect(
      hasSlackThreadReplyContext({
        payload: {
          channel: 'C123',
          thread_ts: '111.222',
        },
        slackThreadTs: null,
      }),
    ).toBe(true);

    expect(
      hasSlackThreadReplyContext({
        payload: {
          slackChannel: 'C123',
        },
        slackThreadTs: '111.222',
      }),
    ).toBe(true);
  });

  it('rejects Slack thread reply context when payload is missing or malformed', () => {
    expect(
      hasSlackThreadReplyContext({
        payload: null,
        slackThreadTs: '111.222',
      }),
    ).toBe(false);

    expect(
      hasSlackThreadReplyContext({
        payload: {
          slackChannel: 'C123',
        },
        slackThreadTs: null,
      }),
    ).toBe(false);
  });

  it('throws when prependSlackMessages sees a command-level multi error', async () => {
    execMock.mockResolvedValueOnce([[new Error('lpush failed'), null]]);

    await expect(
      prependSlackMessages(42, [
        {
          text: 'Context from teammate',
          user: 'U123',
          ts: '111.222',
        },
      ]),
    ).rejects.toThrow('lpush failed');

    expect(multiLpushMock).toHaveBeenCalledWith(
      'slack:messages:42',
      JSON.stringify({
        text: 'Context from teammate',
        user: 'U123',
        ts: '111.222',
      }),
    );
    expect(multiExpireMock).toHaveBeenCalledWith('slack:messages:42', 3600);
  });

  it('drains queued Slack messages and skips malformed entries', async () => {
    execMock.mockResolvedValueOnce([
      [
        null,
        [
          JSON.stringify({
            text: 'Context from teammate',
            user: 'U123',
            ts: '111.222',
            formattedPrompt:
              '<thread_activity>\nAlice Example: Context from teammate\n</thread_activity>',
            turnPolicy: {
              reactionsAllowed: false,
            },
            contextOnly: true,
          }),
          'not-json',
        ],
      ],
      [null, 1],
    ]);

    await expect(getSlackMessages(42)).resolves.toEqual([
      {
        text: 'Context from teammate',
        user: 'U123',
        ts: '111.222',
        formattedPrompt:
          '<thread_activity>\nAlice Example: Context from teammate\n</thread_activity>',
        turnPolicy: {
          reactionsAllowed: false,
        },
        contextOnly: true,
      },
    ]);

    expect(lrangeMock).toHaveBeenCalledWith('slack:messages:42', 0, -1);
    expect(multiDelMock).toHaveBeenCalledWith('slack:messages:42');
  });

  it('returns an empty queue when redis closes before draining queued Slack messages', async () => {
    execMock.mockRejectedValueOnce(new Error('Connection is closed.'));

    await expect(getSlackMessages(42)).resolves.toEqual([]);

    expect(consoleErrorMock).toHaveBeenCalledWith(
      '[getCommunicationMessages] Redis multi exec failed for slack cloud job 42: Connection is closed.',
    );
    expect(lrangeMock).toHaveBeenCalledWith('slack:messages:42', 0, -1);
    expect(multiDelMock).toHaveBeenCalledWith('slack:messages:42');
  });
});
