import {
  getChatChannelMessages,
  addReactionToSlackMessage,
  clearSlackReplyQuote,
  getChatThread,
  postToSlackChannel,
  replyToSlackThread,
  trackSlackReplyQuote,
} from '../slack-api-client.js';
import type { RoomoteConfig } from '../types.js';

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://platform.example.com',
};

describe('replyToSlackThread', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('posts text-only replies', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messageTs: '111.222' }),
    });

    const result = await replyToSlackThread(config, {
      text: 'hello from worker',
    });

    expect(result).toEqual({ messageTs: '111.222' });
    expect(fetch).toHaveBeenCalledWith(
      'https://platform.example.com/api/mcp/slack/thread_reply',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
        body: JSON.stringify({ text: 'hello from worker' }),
      }),
    );
  });

  it('preserves a pathful platform API base URL', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messageTs: '111.222' }),
    });

    await replyToSlackThread(
      {
        ...config,
        platformApiUrl: 'https://app.example.com/_roomote-api',
      },
      {
        text: 'hello from worker',
      },
    );

    expect(fetch).toHaveBeenCalledWith(
      'https://app.example.com/_roomote-api/api/mcp/slack/thread_reply',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('adds the preview bypass header when configured', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messageTs: '111.222' }),
    });

    await replyToSlackThread(
      {
        ...config,
        authBypassHeaderName: 'x-custom-bypass',
        authBypassHeaderValue: 'bypass-token',
      },
      {
        text: 'hello from worker',
      },
    );

    expect(fetch).toHaveBeenCalledWith(
      'https://platform.example.com/api/mcp/slack/thread_reply',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'x-custom-bypass': 'bypass-token',
        }),
      }),
    );
  });

  it('includes image artifact ids in the request body', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messageTs: '333.444' }),
    });

    await replyToSlackThread(config, {
      text: 'with screenshot',
      images: [{ artifactId: 'art-1' }, { artifactId: 'art-2' }],
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://platform.example.com/api/mcp/slack/thread_reply',
      expect.objectContaining({
        body: JSON.stringify({
          text: 'with screenshot',
          images: [{ artifactId: 'art-1' }, { artifactId: 'art-2' }],
        }),
      }),
    );
  });

  it('retries transient 503 failures before succeeding', async () => {
    vi.useFakeTimers();
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messageTs: '444.555' }),
      });

    const replyPromise = replyToSlackThread(config, { text: 'retry me' });

    await vi.runAllTimersAsync();

    await expect(replyPromise).resolves.toEqual({ messageTs: '444.555' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting 503 retries', async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ error: 'busy' }),
    });

    const replyPromise = replyToSlackThread(config, { text: 'still busy' });
    const rejection = expect(replyPromise).rejects.toThrow(
      'Failed to reply to Slack thread: 503 busy',
    );

    await vi.runAllTimersAsync();

    await rejection;
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('throws the API error message on non-retryable failure', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: 'forbidden' }),
    });

    await expect(
      replyToSlackThread(config, { text: 'blocked' }),
    ).rejects.toThrow('Failed to reply to Slack thread: 403 forbidden');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('postToSlackChannel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('posts channel messages with the requested channel and optional thread', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messageTs: '777.888', channelId: 'C123' }),
    });

    const result = await postToSlackChannel(config, {
      channel: '#eng',
      threadTs: '111.222',
      text: 'hello channel',
      images: [{ artifactId: 'art-1' }],
    });

    expect(result).toEqual({ messageTs: '777.888', channelId: 'C123' });
    expect(fetch).toHaveBeenCalledWith(
      'https://platform.example.com/api/mcp/slack/channel_post',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
        body: JSON.stringify({
          channel: '#eng',
          threadTs: '111.222',
          text: 'hello channel',
          images: [{ artifactId: 'art-1' }],
        }),
      }),
    );
  });

  it('throws the API error message on failure', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({ error: 'Slack app is not a member of channel #eng.' }),
    });

    await expect(
      postToSlackChannel(config, {
        channel: '#eng',
        text: 'blocked',
      }),
    ).rejects.toThrow(
      'Failed to post to Slack channel: 403 Slack app is not a member of channel #eng.',
    );
  });
});

describe('reply quote helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('posts quote tracking requests through the Slack MCP API', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    const result = await trackSlackReplyQuote(config, {
      runId: 42,
      text: 'Follow up from web',
      userName: 'Casey',
    });

    expect(result).toEqual({ success: true });
    expect(fetch).toHaveBeenCalledWith(
      'https://platform.example.com/api/mcp/slack/track_reply_quote',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
        body: JSON.stringify({
          runId: 42,
          text: 'Follow up from web',
          userName: 'Casey',
        }),
      }),
    );
  });

  it('posts quote clear requests through the Slack MCP API', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    const result = await clearSlackReplyQuote(config, {
      runId: 42,
    });

    expect(result).toEqual({ success: true });
    expect(fetch).toHaveBeenCalledWith(
      'https://platform.example.com/api/mcp/slack/clear_reply_quote',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
        body: JSON.stringify({
          runId: 42,
        }),
      }),
    );
  });
});

describe('addReactionToSlackMessage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('adds a reaction with the requested channel, timestamp, and name', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        channelId: 'C123',
        messageTs: '111.222',
        name: 'eyes',
      }),
    });

    const result = await addReactionToSlackMessage(config, {
      channel: '#eng',
      messageTs: '111.222',
      name: 'eyes',
    });

    expect(result).toEqual({
      channelId: 'C123',
      messageTs: '111.222',
      name: 'eyes',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://platform.example.com/api/mcp/slack/reaction_add',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
        body: JSON.stringify({
          channel: '#eng',
          messageTs: '111.222',
          name: 'eyes',
        }),
      }),
    );
  });

  it('throws the API error message on failure', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () =>
        JSON.stringify({
          error: 'Slack reactions.add failed for channel C123 at 111.222.',
        }),
    });

    await expect(
      addReactionToSlackMessage(config, {
        channel: 'C123',
        messageTs: '111.222',
        name: 'eyes',
      }),
    ).rejects.toThrow(
      'Failed to add Slack reaction: 502 Slack reactions.add failed for channel C123 at 111.222.',
    );
  });
});

describe('getChatThread', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('looks up a thread by message timestamp', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        provider: 'slack',
        channelId: 'C123',
        requestedMessageId: '111.222',
        threadId: '111.000',
        matchedMessageIndex: 1,
        messageCount: 2,
        messages: [
          {
            provider: 'slack',
            id: '111.000',
            user: 'U1',
            username: 'Alice',
            text: 'root',
            channelId: 'C123',
            threadId: '111.000',
            fileCount: 0,
          },
          {
            provider: 'slack',
            id: '111.222',
            user: 'U2',
            username: 'Bob',
            text: 'reply',
            channelId: 'C123',
            threadId: '111.000',
            fileCount: 0,
          },
        ],
      }),
    });

    const result = await getChatThread(config, {
      channel: '#eng',
      messageId: '111.222',
    });

    expect(result).toEqual({
      provider: 'slack',
      channelId: 'C123',
      requestedMessageId: '111.222',
      threadId: '111.000',
      matchedMessageIndex: 1,
      messageCount: 2,
      messages: [
        {
          provider: 'slack',
          id: '111.000',
          user: 'U1',
          username: 'Alice',
          text: 'root',
          channelId: 'C123',
          threadId: '111.000',
          fileCount: 0,
        },
        {
          provider: 'slack',
          id: '111.222',
          user: 'U2',
          username: 'Bob',
          text: 'reply',
          channelId: 'C123',
          threadId: '111.000',
          fileCount: 0,
        },
      ],
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://platform.example.com/api/mcp/communication/thread_lookup',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
        body: JSON.stringify({ channel: '#eng', messageId: '111.222' }),
      }),
    );
  });

  it('throws the API error message on lookup failure', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'Slack message not found' }),
    });

    await expect(
      getChatThread(config, { messageId: '111.222' }),
    ).rejects.toThrow(
      'Failed to look up chat thread: 404 Slack message not found',
    );
  });
});

describe('getChatChannelMessages', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('looks up channel history with optional bounds', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        provider: 'slack',
        channelId: 'C123',
        requestedOldest: '2026-04-01T00:00:00Z',
        requestedLatest: '2026-04-02T00:00:00Z',
        messageCount: 2,
        messages: [
          {
            provider: 'slack',
            id: '1711929600.000000',
            user: 'U1',
            username: 'Alice',
            text: 'root',
            channelId: 'C123',
            fileCount: 0,
          },
          {
            provider: 'slack',
            id: '1711929900.000000',
            user: 'U2',
            username: 'Bob',
            threadId: '1711929600.000000',
            text: 'reply',
            channelId: 'C123',
            fileCount: 0,
          },
        ],
      }),
    });

    const result = await getChatChannelMessages(config, {
      channel: '#eng',
      oldest: '2026-04-01T00:00:00Z',
      latest: '2026-04-02T00:00:00Z',
    });

    expect(result).toEqual({
      provider: 'slack',
      channelId: 'C123',
      requestedOldest: '2026-04-01T00:00:00Z',
      requestedLatest: '2026-04-02T00:00:00Z',
      messageCount: 2,
      messages: [
        {
          provider: 'slack',
          id: '1711929600.000000',
          user: 'U1',
          username: 'Alice',
          text: 'root',
          channelId: 'C123',
          fileCount: 0,
        },
        {
          provider: 'slack',
          id: '1711929900.000000',
          user: 'U2',
          username: 'Bob',
          threadId: '1711929600.000000',
          text: 'reply',
          channelId: 'C123',
          fileCount: 0,
        },
      ],
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://platform.example.com/api/mcp/communication/channel_messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
        body: JSON.stringify({
          channel: '#eng',
          oldest: '2026-04-01T00:00:00Z',
          latest: '2026-04-02T00:00:00Z',
        }),
      }),
    );
  });

  it('throws the API error message on lookup failure', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({
          error: 'Linked Slack user is not a member of channel #eng.',
        }),
    });

    await expect(
      getChatChannelMessages(config, { channel: '#eng' }),
    ).rejects.toThrow(
      'Failed to look up chat channel messages: 403 Linked Slack user is not a member of channel #eng.',
    );
  });
});
