const mocks = vi.hoisted(() => ({
  beginStream: vi.fn(),
  endStream: vi.fn(),
  finalizeStream: vi.fn(),
  recordMessage: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  beginSlackThreadReplyStream: mocks.beginStream,
  endSlackThreadReplyStream: mocks.endStream,
  finalizeSlackThreadReplyStreamWithFooterText: mocks.finalizeStream,
  ROOMOTE_THREAD_REPLY_QUOTE_BLOCK_ID: 'quote',
  withSlackThreadReplyFooterLock: async ({
    fn,
  }: {
    fn: () => Promise<unknown>;
  }) => fn(),
}));
vi.mock('@roomote/communication', () => ({
  buildFastSessionReplyFooterText: () => 'footer',
}));
vi.mock('./fast-agent-provider-message', () => ({
  recordFastAgentConversationMessageBestEffort: mocks.recordMessage,
}));

import { createSlackFastReplyStream } from './fast-agent-slack-reply-stream';

const conversation = {
  surface: 'slack' as const,
  workspaceId: 'T1',
  conversationId: '100.1',
  replyTarget: { channelId: 'C1', threadId: '100.1' },
};

function slackMock() {
  return {
    startMessageStream: vi.fn<() => Promise<string | null>>(
      async () => '200.1',
    ),
    appendMessageStream: vi.fn(async () => true),
    stopMessageStream: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
    updateMessage: vi.fn(async () => true),
    getMessageBlocks: vi.fn(async () => []),
    getRawMessage: vi.fn(async () => null),
    postMessage: vi.fn(async () => undefined),
  };
}

function build(slack: ReturnType<typeof slackMock>, quote: string | null) {
  let pendingQuote = quote;
  const onDelivered = vi.fn();
  const stream = createSlackFastReplyStream({
    slack,
    conversation: conversation as never,
    channelId: 'C1',
    threadTs: '100.1',
    recipientTeamId: 'T1',
    recipientUserId: 'U1',
    sessionId: 'session-1',
    footerContext: {} as never,
    getQuote: () => pendingQuote,
    onDelivered: () => {
      pendingQuote = null;
      onDelivered();
    },
  });
  return { stream, onDelivered, getPendingQuote: () => pendingQuote };
}

describe('createSlackFastReplyStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.beginStream.mockResolvedValue('stream-token');
    mocks.endStream.mockResolvedValue(undefined);
    mocks.finalizeStream.mockResolvedValue(true);
    mocks.recordMessage.mockResolvedValue(undefined);
  });

  it('starts on the first append, appends after, and finishes into the canonical reply body', async () => {
    const slack = slackMock();
    const { stream, onDelivered, getPendingQuote } = build(slack, '> Matt: hi');

    await stream.append('Looking');
    await stream.append(' at the logs');
    expect(slack.startMessageStream).toHaveBeenCalledWith({
      channel: 'C1',
      threadTs: '100.1',
      recipientTeamId: 'T1',
      recipientUserId: 'U1',
      markdownText: 'Looking',
    });
    expect(mocks.beginStream.mock.invocationCallOrder[0]).toBeLessThan(
      slack.startMessageStream.mock.invocationCallOrder[0]!,
    );
    expect(slack.appendMessageStream).toHaveBeenCalledWith({
      channel: 'C1',
      ts: '200.1',
      markdownText: ' at the logs',
    });

    await expect(
      stream.finish({ purpose: 'closeout', message: 'Looking at the logs.' }),
    ).resolves.toEqual({ messageId: '200.1' });
    expect(slack.stopMessageStream).toHaveBeenCalledWith({
      channel: 'C1',
      ts: '200.1',
    });
    expect(slack.appendMessageStream.mock.invocationCallOrder[0]).toBeLessThan(
      slack.stopMessageStream.mock.invocationCallOrder[0]!,
    );
    expect(slack.stopMessageStream.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.finalizeStream.mock.invocationCallOrder[0]!,
    );
    expect(mocks.finalizeStream).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1',
        threadTs: '100.1',
        messageTs: '200.1',
        text: '> Matt: hi\nLooking at the logs.',
        bodyBlocks: [
          {
            type: 'section',
            block_id: 'quote',
            text: { type: 'mrkdwn', text: '> Matt: hi' },
          },
          { type: 'markdown', text: 'Looking at the logs.' },
        ],
        footerText: 'footer',
        streamToken: 'stream-token',
      }),
    );
    expect(mocks.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', messageId: '200.1' }),
    );
    expect(onDelivered).toHaveBeenCalledOnce();
    expect(getPendingQuote()).toBeNull();
    // Finishing twice or aborting afterwards does nothing more.
    await expect(
      stream.finish({ purpose: 'closeout', message: 'again' }),
    ).resolves.toBeUndefined();
    await stream.abort();
    expect(slack.stopMessageStream).toHaveBeenCalledTimes(1);
  });

  it('yields nothing when the stream never opened so the caller posts normally', async () => {
    const slack = slackMock();
    slack.startMessageStream.mockResolvedValue(null);
    const { stream, onDelivered } = build(slack, null);

    await stream.append('Looking');
    await stream.append(' more');
    expect(slack.startMessageStream).toHaveBeenCalledTimes(1);
    expect(slack.appendMessageStream).not.toHaveBeenCalled();
    await expect(
      stream.finish({ purpose: 'closeout', message: 'Done.' }),
    ).resolves.toBeUndefined();
    expect(mocks.finalizeStream).not.toHaveBeenCalled();
    expect(onDelivered).not.toHaveBeenCalled();
  });

  it('stops appending after a failed append but still finishes with the full reply', async () => {
    const slack = slackMock();
    slack.appendMessageStream.mockResolvedValueOnce(false);
    const { stream } = build(slack, null);

    await stream.append('One');
    await stream.append(' two');
    await stream.append(' three');
    expect(slack.appendMessageStream).toHaveBeenCalledTimes(1);

    await expect(
      stream.finish({ purpose: 'closeout', message: 'One two three.' }),
    ).resolves.toEqual({ messageId: '200.1' });
    expect(mocks.finalizeStream).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'One two three.' }),
    );
  });

  it('removes the partial stream before falling back to a normal post', async () => {
    const slack = slackMock();
    mocks.finalizeStream.mockResolvedValue(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { stream, onDelivered, getPendingQuote } = build(slack, '> Matt: hi');

    await stream.append('Looking');
    await expect(
      stream.finish({ purpose: 'closeout', message: 'Looking.' }),
    ).resolves.toBeUndefined();
    expect(slack.stopMessageStream).toHaveBeenCalledTimes(1);
    expect(slack.deleteMessage).toHaveBeenCalledWith({
      channel: 'C1',
      ts: '200.1',
    });
    expect(mocks.recordMessage).not.toHaveBeenCalled();
    expect(onDelivered).not.toHaveBeenCalled();
    expect(getPendingQuote()).toBe('> Matt: hi');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('did not accept the final body'),
    );
  });

  it('keeps the partial stream as the delivery when it cannot be removed', async () => {
    const slack = slackMock();
    mocks.finalizeStream.mockResolvedValue(false);
    slack.deleteMessage.mockResolvedValue(false);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { stream, onDelivered } = build(slack, null);

    await stream.append('Looking');
    await expect(
      stream.finish({ purpose: 'closeout', message: 'Looking.' }),
    ).resolves.toEqual({ messageId: '200.1' });
    expect(mocks.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', messageId: '200.1' }),
    );
    expect(onDelivered).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('partial stream could not be removed'),
    );
  });

  it('removes the partial stream when the final rewrite throws', async () => {
    const slack = slackMock();
    mocks.finalizeStream.mockRejectedValue(new Error('lock timed out'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { stream } = build(slack, null);

    await stream.append('Looking');
    await expect(
      stream.finish({ purpose: 'closeout', message: 'Looking.' }),
    ).resolves.toBeUndefined();
    expect(slack.deleteMessage).toHaveBeenCalledWith({
      channel: 'C1',
      ts: '200.1',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to apply the final body'),
    );
  });

  it('aborts by stopping the stream and leaving its text', async () => {
    const slack = slackMock();
    const { stream } = build(slack, null);
    await stream.append('Half');
    await stream.abort();
    expect(slack.stopMessageStream).toHaveBeenCalledWith({
      channel: 'C1',
      ts: '200.1',
    });
    expect(mocks.finalizeStream).not.toHaveBeenCalled();
    expect(mocks.endStream).toHaveBeenCalledWith({
      channel: 'C1',
      threadTs: '100.1',
      token: 'stream-token',
    });
  });
});
