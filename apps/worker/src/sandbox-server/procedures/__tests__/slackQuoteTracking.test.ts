const {
  mockFindFirstById,
  mockGetRoomoteConfig,
  mockTrackSlackReplyQuote,
  mockClearSlackReplyQuote,
} = vi.hoisted(() => ({
  mockFindFirstById: vi.fn(),
  mockGetRoomoteConfig: vi.fn(),
  mockTrackSlackReplyQuote: vi.fn(),
  mockClearSlackReplyQuote: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      findFirstById: mockFindFirstById,
    },
  },
}));

vi.mock('@roomote/slack/client', () => ({
  hasSlackThreadReplyContext: ({
    payload,
    slackThreadTs,
  }: {
    payload: unknown;
    slackThreadTs: string | null;
  }) => {
    const record =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : {};

    return (
      (typeof record.channel === 'string' &&
        typeof record.thread_ts === 'string') ||
      (typeof record.slackChannel === 'string' &&
        typeof slackThreadTs === 'string')
    );
  },
}));

vi.mock('../../../mcp/roomote-mcp-server/config', () => ({
  getRoomoteConfig: mockGetRoomoteConfig,
}));

vi.mock('../../../mcp/roomote-mcp-server/slack-api-client', () => ({
  trackSlackReplyQuote: mockTrackSlackReplyQuote,
  clearSlackReplyQuote: mockClearSlackReplyQuote,
}));

import {
  clearLatestUserMessageForSlackThreadQuote,
  trackLatestUserMessageForSlackThreadQuote,
} from '../slackQuoteTracking';

describe('trackLatestUserMessageForSlackThreadQuote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirstById.mockResolvedValue({
      payload: {
        channel: 'C123',
        thread_ts: '111.222',
      },
      slackThreadTs: '111.222',
    });
    mockGetRoomoteConfig.mockReturnValue({
      token: 'run-token',
      platformApiUrl: 'https://platform.example.com',
    });
    mockTrackSlackReplyQuote.mockResolvedValue({
      success: true,
      quoteId: 'quote-1',
    });
    mockClearSlackReplyQuote.mockResolvedValue({ success: true });
  });

  it('tracks the latest user message through the API when the task run has Slack thread context', async () => {
    const trackedQuote = await trackLatestUserMessageForSlackThreadQuote({
      runId: 1,
      text: 'Follow up from web',
      userName: 'Casey',
      logPrefix: 'testProcedure',
    });

    expect(trackedQuote).toEqual({ quoteId: 'quote-1' });
    expect(mockFindFirstById).toHaveBeenCalledWith(1);
    expect(mockGetRoomoteConfig).toHaveBeenCalledTimes(1);
    expect(mockTrackSlackReplyQuote).toHaveBeenCalledWith(
      {
        token: 'run-token',
        platformApiUrl: 'https://platform.example.com',
      },
      {
        runId: 1,
        text: 'Follow up from web',
        userName: 'Casey',
      },
    );
  });

  it('preserves tracked state when an older API omits quoteId', async () => {
    mockTrackSlackReplyQuote.mockResolvedValueOnce({ success: true });

    const trackedQuote = await trackLatestUserMessageForSlackThreadQuote({
      runId: 1,
      text: 'Follow up from web',
      userName: 'Casey',
      logPrefix: 'testProcedure',
    });

    expect(trackedQuote).toEqual({});
  });

  it('does not leak raw user IDs into the stored Slack quote username', async () => {
    await trackLatestUserMessageForSlackThreadQuote({
      runId: 1,
      text: 'Follow up from web',
      userName: undefined,
      logPrefix: 'testProcedure',
    });

    expect(mockTrackSlackReplyQuote).toHaveBeenCalledWith(
      {
        token: 'run-token',
        platformApiUrl: 'https://platform.example.com',
      },
      {
        runId: 1,
        text: 'Follow up from web',
        userName: 'Someone',
      },
    );
  });

  it('does not store a message when the task run has no Slack thread context', async () => {
    mockFindFirstById.mockResolvedValueOnce({
      payload: {},
      slackThreadTs: null,
    });

    await trackLatestUserMessageForSlackThreadQuote({
      runId: 1,
      text: 'Follow up from web',
      userName: undefined,
      logPrefix: 'testProcedure',
    });

    expect(mockFindFirstById).toHaveBeenCalledWith(1);
    expect(mockGetRoomoteConfig).not.toHaveBeenCalled();
    expect(mockTrackSlackReplyQuote).not.toHaveBeenCalled();
  });

  it('does not query the task run for empty text or missing task run IDs', async () => {
    await trackLatestUserMessageForSlackThreadQuote({
      runId: 1,
      text: '   ',
      userName: undefined,
      logPrefix: 'testProcedure',
    });
    await trackLatestUserMessageForSlackThreadQuote({
      runId: undefined,
      text: 'Follow up from web',
      userName: undefined,
      logPrefix: 'testProcedure',
    });

    expect(mockFindFirstById).not.toHaveBeenCalled();
    expect(mockGetRoomoteConfig).not.toHaveBeenCalled();
    expect(mockTrackSlackReplyQuote).not.toHaveBeenCalled();
  });

  it('logs non-fatal lookup failures with the caller prefix', async () => {
    const warn = vi.fn();
    mockFindFirstById.mockRejectedValueOnce(new Error('lookup failed'));

    await trackLatestUserMessageForSlackThreadQuote({
      runId: 1,
      text: 'Follow up from web',
      userName: undefined,
      logPrefix: 'testProcedure',
      warn,
    });

    expect(mockTrackSlackReplyQuote).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[testProcedure] Non-fatal latest user message sync failure for task run 1: lookup failed',
    );
  });

  it('logs non-fatal API config failures with the caller prefix', async () => {
    const warn = vi.fn();
    mockGetRoomoteConfig.mockReturnValueOnce(null);

    await trackLatestUserMessageForSlackThreadQuote({
      runId: 1,
      text: 'Follow up from web',
      userName: undefined,
      logPrefix: 'testProcedure',
      warn,
    });

    expect(mockTrackSlackReplyQuote).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[testProcedure] Non-fatal latest user message sync failure for task run 1: ROOMOTE_CLOUD_TOKEN/AUTH_TOKEN environment variable not set',
    );
  });

  it('clears the latest user message through the API when the task run has Slack thread context', async () => {
    await clearLatestUserMessageForSlackThreadQuote({
      runId: 1,
      quoteId: 'quote-1',
      logPrefix: 'testProcedure',
    });

    expect(mockFindFirstById).toHaveBeenCalledWith(1);
    expect(mockGetRoomoteConfig).toHaveBeenCalledTimes(1);
    expect(mockClearSlackReplyQuote).toHaveBeenCalledWith(
      {
        token: 'run-token',
        platformApiUrl: 'https://platform.example.com',
      },
      {
        runId: 1,
        quoteId: 'quote-1',
      },
    );
  });

  it('uses legacy cleanup when the tracked response had no quoteId', async () => {
    await clearLatestUserMessageForSlackThreadQuote({
      runId: 1,
      logPrefix: 'testProcedure',
    });

    expect(mockClearSlackReplyQuote).toHaveBeenCalledWith(
      {
        token: 'run-token',
        platformApiUrl: 'https://platform.example.com',
      },
      { runId: 1 },
    );
  });
});
