const mocks = vi.hoisted(() => ({
  footerMessageTs: vi.fn(),
  postWithFooter: vi.fn(),
  recordMessage: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  findSlackConversationSubjectByUserId: vi.fn(async () => ({})),
  recordSlackConversationMessageBestEffort: mocks.recordMessage,
}));
vi.mock('@roomote/slack', () => ({
  postSlackThreadMessageWithFooterText: mocks.postWithFooter,
  getSlackThreadReplyFooterMessageTs: mocks.footerMessageTs,
  buildSlackThreadReplyFooterBlock: ({
    footerText,
  }: {
    footerText: string;
  }) => ({
    type: 'context',
    text: footerText,
  }),
  withSlackThreadReplyFooterLock: async ({
    fn,
  }: {
    fn: () => Promise<unknown>;
  }) => fn(),
}));
vi.mock('@roomote/communication', () => ({
  buildFastSessionReplyFooterText: () => 'Session footer',
}));

import { postSlackThreadMarkdownMessage } from '../thread-posting';

describe('Slack reply video delivery', () => {
  const slack = {
    hasMessageInThread: vi.fn(),
    updateMessage: vi.fn(),
  };
  const deliverVideos = vi.fn();
  const params = {
    slack: slack as never,
    channel: 'C1',
    threadTs: '100.1',
    sourceMessageTs: '100.2',
    text: 'Recording ready.',
    images: [{ url: 'https://example.com/image.png', altText: 'Screenshot' }],
    fastSessionFooter: {
      sessionId: 'session-1',
      linkedPrs: [],
      livePreviewUrl: null,
    },
    conversationLog: {
      userId: 'user-1',
      slackTeamId: 'T1',
      source: 'fast_agent',
    },
    deliverVideos,
  };
  const fallback = '[View video](https://example.com/video)';

  beforeEach(() => {
    vi.resetAllMocks();
    slack.hasMessageInThread.mockResolvedValue(true);
    slack.updateMessage.mockResolvedValue(true);
    mocks.postWithFooter.mockResolvedValue('reply-ts');
    mocks.footerMessageTs.mockResolvedValue('reply-ts');
    deliverVideos.mockResolvedValue(fallback);
  });

  it('does not upload until the text post has succeeded', async () => {
    let completePost!: (ts: string) => void;
    mocks.postWithFooter.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          completePost = resolve;
        }),
    );
    const posting = postSlackThreadMarkdownMessage(params);
    await vi.waitFor(() => expect(mocks.postWithFooter).toHaveBeenCalledOnce());
    expect(deliverVideos).not.toHaveBeenCalled();
    completePost('reply-ts');
    await expect(posting).resolves.toEqual({
      status: 'posted',
      messageId: 'reply-ts',
    });
    expect(deliverVideos).toHaveBeenCalledOnce();
  });

  it.each(['suppressed', 'failed', 'thrown'] as const)(
    'does not upload when the text post is %s',
    async (outcome) => {
      if (outcome === 'suppressed')
        slack.hasMessageInThread.mockResolvedValue(false);
      if (outcome === 'failed') mocks.postWithFooter.mockResolvedValue(null);
      if (outcome === 'thrown')
        mocks.postWithFooter.mockRejectedValue(new Error('post failed'));
      const posting = postSlackThreadMarkdownMessage(params);
      if (outcome === 'thrown')
        await expect(posting).rejects.toThrow('post failed');
      else await expect(posting).resolves.toBe(outcome);
      expect(deliverVideos).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    'preserves images and the current footer without reclaiming a relocated footer (carrier=%s)',
    async (isCarrier) => {
      mocks.footerMessageTs.mockResolvedValue(
        isCarrier ? 'reply-ts' : 'later-reply-ts',
      );
      await postSlackThreadMarkdownMessage(params);
      const text = `${params.text}\n\n${fallback}`;
      expect(slack.updateMessage).toHaveBeenCalledExactlyOnceWith({
        channel: 'C1',
        ts: 'reply-ts',
        message: {
          text,
          blocks: [
            { type: 'markdown', text },
            {
              type: 'image',
              image_url: params.images[0]!.url,
              alt_text: 'Screenshot',
            },
            ...(isCarrier ? [{ type: 'context', text: 'Session footer' }] : []),
          ],
        },
      });
      expect(mocks.recordMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text }),
      );
    },
  );

  it.each(['rejected', 'thrown'] as const)(
    'does not claim fallback delivery when its update is %s',
    async (outcome) => {
      if (outcome === 'rejected') slack.updateMessage.mockResolvedValue(false);
      else slack.updateMessage.mockRejectedValue(new Error('update failed'));
      await expect(postSlackThreadMarkdownMessage(params)).rejects.toThrow(
        outcome === 'rejected'
          ? 'Slack did not update the Fast video fallback reply.'
          : 'update failed',
      );
      expect(mocks.recordMessage).not.toHaveBeenCalled();
    },
  );
});
