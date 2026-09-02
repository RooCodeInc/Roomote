const mocks = vi.hoisted(() => ({
  updateWithFooter: vi.fn(),
  recordMessage: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  ROOMOTE_THREAD_REPLY_QUOTE_BLOCK_ID: 'quote',
  updateSlackThreadMessageWithFooterText: mocks.updateWithFooter,
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
    updateMessage: vi.fn(async () => true),
    getMessageBlocks: vi.fn(async () => []),
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
    takeQuote: () => {
      const value = pendingQuote;
      pendingQuote = null;
      return value;
    },
    onDelivered,
  });
  return { stream, onDelivered };
}

describe('createSlackFastReplyStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateWithFooter.mockResolvedValue(true);
    mocks.recordMessage.mockResolvedValue(undefined);
  });

  it('starts on the first append, appends after, and finishes into the canonical reply body', async () => {
    const slack = slackMock();
    const { stream, onDelivered } = build(slack, '> Matt: hi');

    await stream.append('Looking');
    await stream.append(' at the logs');
    expect(slack.startMessageStream).toHaveBeenCalledWith({
      channel: 'C1',
      threadTs: '100.1',
      recipientTeamId: 'T1',
      recipientUserId: 'U1',
      markdownText: 'Looking',
    });
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
    expect(mocks.updateWithFooter).toHaveBeenCalledWith(
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
      }),
    );
    expect(mocks.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', messageId: '200.1' }),
    );
    expect(onDelivered).toHaveBeenCalledOnce();
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
    expect(mocks.updateWithFooter).not.toHaveBeenCalled();
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
    expect(mocks.updateWithFooter).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'One two three.' }),
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
    expect(mocks.updateWithFooter).not.toHaveBeenCalled();
  });
});
