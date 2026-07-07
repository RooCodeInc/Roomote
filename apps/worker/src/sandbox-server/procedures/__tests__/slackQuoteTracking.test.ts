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
    cloudJobs: {
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
      token: 'job-token',
      platformApiUrl: 'https://platform.example.com',
    });
    mockTrackSlackReplyQuote.mockResolvedValue({ success: true });
    mockClearSlackReplyQuote.mockResolvedValue({ success: true });
  });

  it('tracks the latest user message through the API when the cloud job has Slack thread context', async () => {
    await trackLatestUserMessageForSlackThreadQuote({
      cloudJobId: 1,
      text: 'Follow up from web',
      userName: 'Casey',
      logPrefix: 'testProcedure',
    });

    expect(mockFindFirstById).toHaveBeenCalledWith(1);
    expect(mockGetRoomoteConfig).toHaveBeenCalledTimes(1);
    expect(mockTrackSlackReplyQuote).toHaveBeenCalledWith(
      {
        token: 'job-token',
        platformApiUrl: 'https://platform.example.com',
      },
      {
        cloudJobId: 1,
        text: 'Follow up from web',
        userName: 'Casey',
      },
    );
  });

  it('does not leak raw user IDs into the stored Slack quote username', async () => {
    await trackLatestUserMessageForSlackThreadQuote({
      cloudJobId: 1,
      text: 'Follow up from web',
      userName: undefined,
      logPrefix: 'testProcedure',
    });

    expect(mockTrackSlackReplyQuote).toHaveBeenCalledWith(
      {
        token: 'job-token',
        platformApiUrl: 'https://platform.example.com',
      },
      {
        cloudJobId: 1,
        text: 'Follow up from web',
        userName: 'Someone',
      },
    );
  });

  it('does not store a message when the cloud job has no Slack thread context', async () => {
    mockFindFirstById.mockResolvedValueOnce({
      payload: {},
      slackThreadTs: null,
    });

    await trackLatestUserMessageForSlackThreadQuote({
      cloudJobId: 1,
      text: 'Follow up from web',
      userName: undefined,
      logPrefix: 'testProcedure',
    });

    expect(mockFindFirstById).toHaveBeenCalledWith(1);
    expect(mockGetRoomoteConfig).not.toHaveBeenCalled();
    expect(mockTrackSlackReplyQuote).not.toHaveBeenCalled();
  });

  it('does not query the cloud job for empty text or missing cloud job IDs', async () => {
    await trackLatestUserMessageForSlackThreadQuote({
      cloudJobId: 1,
      text: '   ',
      userName: undefined,
      logPrefix: 'testProcedure',
    });
    await trackLatestUserMessageForSlackThreadQuote({
      cloudJobId: undefined,
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
      cloudJobId: 1,
      text: 'Follow up from web',
      userName: undefined,
      logPrefix: 'testProcedure',
      warn,
    });

    expect(mockTrackSlackReplyQuote).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[testProcedure] Non-fatal latest user message sync failure for cloud job 1: lookup failed',
    );
  });

  it('logs non-fatal API config failures with the caller prefix', async () => {
    const warn = vi.fn();
    mockGetRoomoteConfig.mockReturnValueOnce(null);

    await trackLatestUserMessageForSlackThreadQuote({
      cloudJobId: 1,
      text: 'Follow up from web',
      userName: undefined,
      logPrefix: 'testProcedure',
      warn,
    });

    expect(mockTrackSlackReplyQuote).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[testProcedure] Non-fatal latest user message sync failure for cloud job 1: ROOMOTE_CLOUD_TOKEN/AUTH_TOKEN environment variable not set',
    );
  });

  it('strips the <github-pr-follow-up> wrapper and tracks only the clean comment body', async () => {
    const wrappedMessage = [
      '<github-pr-follow-up>',
      'This GitHub PR mention was routed into the existing Roomote task.',
      '',
      '<requested-follow-up>',
      '@roomote please fix the failing CI test',
      '</requested-follow-up>',
      '',
      '<task_context>',
      '  <repository>owner/repo</repository>',
      '</task_context>',
      '</github-pr-follow-up>',
      '',
      '<github_message_instructions>',
      '  <rule>Keep GitHub replies brief.</rule>',
      '</github_message_instructions>',
    ].join('\n');

    await trackLatestUserMessageForSlackThreadQuote({
      cloudJobId: 1,
      text: wrappedMessage,
      userName: 'Matt Rubens',
      logPrefix: 'testProcedure',
    });

    expect(mockTrackSlackReplyQuote).toHaveBeenCalledWith(
      {
        token: 'job-token',
        platformApiUrl: 'https://platform.example.com',
      },
      {
        cloudJobId: 1,
        text: '@roomote please fix the failing CI test',
        userName: 'Matt Rubens',
      },
    );
  });

  it('strips the leading marker even when the envelope is malformed so it never leaks into the quote', async () => {
    const malformedMessage = [
      '<github-pr-follow-up>',
      'This envelope is missing the requested-follow-up block so it will not fully parse.',
    ].join('\n');

    await trackLatestUserMessageForSlackThreadQuote({
      cloudJobId: 1,
      text: malformedMessage,
      userName: 'Matt Rubens',
      logPrefix: 'testProcedure',
    });

    expect(mockTrackSlackReplyQuote).toHaveBeenCalledWith(
      {
        token: 'job-token',
        platformApiUrl: 'https://platform.example.com',
      },
      {
        cloudJobId: 1,
        text: 'This envelope is missing the requested-follow-up block so it will not fully parse.',
        userName: 'Matt Rubens',
      },
    );
  });

  it('clears the latest user message through the API when the cloud job has Slack thread context', async () => {
    await clearLatestUserMessageForSlackThreadQuote({
      cloudJobId: 1,
      logPrefix: 'testProcedure',
    });

    expect(mockFindFirstById).toHaveBeenCalledWith(1);
    expect(mockGetRoomoteConfig).toHaveBeenCalledTimes(1);
    expect(mockClearSlackReplyQuote).toHaveBeenCalledWith(
      {
        token: 'job-token',
        platformApiUrl: 'https://platform.example.com',
      },
      {
        cloudJobId: 1,
      },
    );
  });
});
