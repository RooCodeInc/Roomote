import {
  FAST_AGENT_TELEGRAM_DRAFT_REFRESH_MS,
  FAST_AGENT_TELEGRAM_PROCESSING_DELAY_MS,
  FAST_AGENT_TELEGRAM_STREAM_INTERVAL_MS,
  FAST_AGENT_TELEGRAM_TYPING_REFRESH_MS,
  createFastAgentTelegramActivity,
  runWithFastAgentTelegramActivityReassertion,
} from './fast-agent-telegram-activity';

describe('Fast Telegram activity', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows non-empty Thinking before replacing it with the first partial', async () => {
    const sendMessageDraft = vi.fn().mockResolvedValue(undefined);
    const sendChatAction = vi.fn().mockResolvedValue(undefined);
    const activity = createFastAgentTelegramActivity({
      provider: { sendMessageDraft, sendChatAction },
      replyTarget: { channelId: '123', threadId: '77' },
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(
      FAST_AGENT_TELEGRAM_PROCESSING_DELAY_MS - 1,
    );
    expect(sendMessageDraft).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const thinkingDraftId = sendMessageDraft.mock.calls[0]![0].draftId;
    expect(thinkingDraftId).not.toBe(0);
    expect(sendMessageDraft).toHaveBeenCalledWith({
      channelId: '123',
      threadId: '77',
      draftId: thinkingDraftId,
      text: 'Roomote is working...',
    });
    expect(sendChatAction).not.toHaveBeenCalled();

    const stream = activity.createReplyStream(vi.fn());
    await stream.append('Partial answer');
    expect(sendMessageDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: thinkingDraftId,
        text: 'Partial answer',
      }),
    );
    expect(
      sendMessageDraft.mock.calls.some(([input]) => input.text === ''),
    ).toBe(false);
    await activity.dispose();
  });

  it('refreshes one non-empty Thinking draft below its TTL in private chats', async () => {
    const sendMessageDraft = vi.fn().mockResolvedValue(undefined);
    const sendChatAction = vi.fn().mockResolvedValue(undefined);
    const activity = createFastAgentTelegramActivity({
      provider: {
        sendMessageDraft,
        sendChatAction,
      },
      replyTarget: { channelId: '123', threadId: '77' },
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_TELEGRAM_PROCESSING_DELAY_MS);
    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
    const firstDraftId = sendMessageDraft.mock.calls[0]![0].draftId;
    expect(sendMessageDraft).toHaveBeenCalledWith({
      channelId: '123',
      threadId: '77',
      draftId: firstDraftId,
      text: 'Roomote is working...',
    });

    await vi.advanceTimersByTimeAsync(FAST_AGENT_TELEGRAM_DRAFT_REFRESH_MS);
    expect(sendMessageDraft).toHaveBeenCalledTimes(2);
    expect(sendMessageDraft.mock.calls[1]![0].draftId).toBe(firstDraftId);
    await activity.settle();
  });

  it('does not show a working draft for a turn that settles within the delay', async () => {
    const sendMessageDraft = vi.fn().mockResolvedValue(undefined);
    const activity = createFastAgentTelegramActivity({
      provider: { sendMessageDraft, sendChatAction: vi.fn() },
      replyTarget: { channelId: '123' },
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(
      FAST_AGENT_TELEGRAM_PROCESSING_DELAY_MS - 1,
    );
    await activity.settle();
    await vi.advanceTimersByTimeAsync(1);
    expect(sendMessageDraft).not.toHaveBeenCalled();
  });

  it('streams the first partial immediately instead of waiting for the status delay', async () => {
    const sendMessageDraft = vi.fn().mockResolvedValue(undefined);
    const activity = createFastAgentTelegramActivity({
      provider: { sendMessageDraft, sendChatAction: vi.fn() },
      replyTarget: { channelId: '123' },
    });

    activity.start();
    const stream = activity.createReplyStream(vi.fn());
    await stream.append('Partial answer');
    expect(sendMessageDraft).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: 'Partial answer' }),
    );
    await activity.settle();
  });

  it('restores Thinking after an intermediate post but cancels it on true completion', async () => {
    const sendMessageDraft = vi.fn().mockResolvedValue(undefined);
    const sendChatAction = vi.fn().mockResolvedValue(undefined);
    const activity = createFastAgentTelegramActivity({
      provider: {
        sendMessageDraft,
        sendChatAction,
      },
      replyTarget: { channelId: '123' },
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_TELEGRAM_PROCESSING_DELAY_MS);
    activity.reassert();
    await vi.advanceTimersByTimeAsync(
      FAST_AGENT_TELEGRAM_PROCESSING_DELAY_MS - 1,
    );
    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sendMessageDraft).toHaveBeenCalledTimes(2);
    expect(sendMessageDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'Roomote is working...' }),
    );

    activity.reassert();
    await activity.settle();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_TELEGRAM_PROCESSING_DELAY_MS);
    expect(sendMessageDraft).toHaveBeenCalledTimes(2);
    expect(sendChatAction).not.toHaveBeenCalled();
  });

  it('drains an issued working draft and fences refreshes during cleanup', async () => {
    let resolveDraft!: () => void;
    const draft = new Promise<void>((resolve) => {
      resolveDraft = resolve;
    });
    const sendMessageDraft = vi.fn(() => draft);
    const activity = createFastAgentTelegramActivity({
      provider: { sendMessageDraft, sendChatAction: vi.fn() },
      replyTarget: { channelId: '123' },
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_TELEGRAM_PROCESSING_DELAY_MS);
    expect(sendMessageDraft).toHaveBeenCalledOnce();
    const settlement = activity.settle();
    let settled = false;
    void settlement.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(FAST_AGENT_TELEGRAM_DRAFT_REFRESH_MS);
    expect(settled).toBe(false);
    expect(sendMessageDraft).toHaveBeenCalledOnce();

    resolveDraft();
    await settlement;
    expect(settled).toBe(true);
    await vi.advanceTimersByTimeAsync(FAST_AGENT_TELEGRAM_DRAFT_REFRESH_MS);
    expect(sendMessageDraft).toHaveBeenCalledOnce();
  });

  it('writes the first partial immediately, then paces later coalesced drafts before final delivery', async () => {
    const sendMessageDraft = vi.fn().mockResolvedValue(undefined);
    const deliver = vi.fn().mockResolvedValue({ messageId: 'final-1' });
    const activity = createFastAgentTelegramActivity({
      provider: { sendMessageDraft, sendChatAction: vi.fn() },
      replyTarget: { channelId: '123' },
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_TELEGRAM_PROCESSING_DELAY_MS);
    const stream = activity.createReplyStream(deliver);
    await stream.append('Partial ');
    expect(sendMessageDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'Partial ' }),
    );

    await vi.advanceTimersByTimeAsync(
      FAST_AGENT_TELEGRAM_STREAM_INTERVAL_MS / 2,
    );
    await stream.append('answer');
    await stream.append(' in progress');
    expect(
      sendMessageDraft.mock.calls
        .filter(([input]) => input.text)
        .map(([input]) => input.text),
    ).toEqual(['Roomote is working...', 'Partial ']);
    await vi.advanceTimersByTimeAsync(
      FAST_AGENT_TELEGRAM_STREAM_INTERVAL_MS / 2,
    );
    expect(sendMessageDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'Partial answer in progress' }),
    );
    expect(
      sendMessageDraft.mock.calls
        .filter(([input]) => input.text)
        .map(([input]) => input.text),
    ).toEqual([
      'Roomote is working...',
      'Partial ',
      'Partial answer in progress',
    ]);

    await expect(
      stream.finish({ purpose: 'closeout', message: 'Final answer' }),
    ).resolves.toEqual({ messageId: 'final-1' });
    expect(deliver).toHaveBeenCalledWith({
      purpose: 'closeout',
      message: 'Final answer',
    });
    await activity.settle();
  });

  it('drains the first non-empty draft before finish and fences late writes', async () => {
    let resolveDraft!: () => void;
    const draft = new Promise<void>((resolve) => {
      resolveDraft = resolve;
    });
    const sendMessageDraft = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(draft);
    const deliver = vi.fn().mockResolvedValue({ messageId: 'final-1' });
    const activity = createFastAgentTelegramActivity({
      provider: { sendMessageDraft, sendChatAction: vi.fn() },
      replyTarget: { channelId: '123' },
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_TELEGRAM_PROCESSING_DELAY_MS);
    const stream = activity.createReplyStream(deliver);
    const appending = stream.append('Partial');
    await vi.advanceTimersByTimeAsync(0);
    const finishing = stream.finish({
      purpose: 'closeout',
      message: 'Final',
    });
    expect(deliver).not.toHaveBeenCalled();
    resolveDraft();
    await Promise.all([appending, finishing]);
    expect(deliver).toHaveBeenCalledOnce();
    await activity.settle();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_TELEGRAM_DRAFT_REFRESH_MS);
    expect(sendMessageDraft).toHaveBeenCalledTimes(2);
    await activity.dispose();
  });

  it('retains ordinary typing in group chats where drafts are unsupported', async () => {
    const sendChatAction = vi.fn().mockResolvedValue(undefined);
    const sendMessageDraft = vi.fn();
    const activity = createFastAgentTelegramActivity({
      provider: { sendMessageDraft, sendChatAction },
      replyTarget: { channelId: '-100123', threadId: '77' },
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_TELEGRAM_PROCESSING_DELAY_MS);
    expect(sendChatAction).toHaveBeenCalledWith({
      channelId: '-100123',
      threadId: '77',
    });
    expect(sendMessageDraft).not.toHaveBeenCalled();
    expect(activity.supportsReplyStream).toBe(false);
    await vi.advanceTimersByTimeAsync(FAST_AGENT_TELEGRAM_TYPING_REFRESH_MS);
    expect(sendChatAction).toHaveBeenCalledTimes(2);
    await activity.dispose();
  });

  it('falls back to a typing heartbeat when Telegram rejects live drafts', async () => {
    const sendMessageDraft = vi
      .fn()
      .mockRejectedValue(new Error('method unavailable'));
    const sendChatAction = vi.fn().mockResolvedValue(undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const activity = createFastAgentTelegramActivity({
      provider: { sendMessageDraft, sendChatAction },
      replyTarget: { channelId: '123', threadId: '77' },
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_TELEGRAM_PROCESSING_DELAY_MS);
    expect(sendMessageDraft).toHaveBeenCalledOnce();
    expect(sendChatAction).toHaveBeenCalledWith({
      channelId: '123',
      threadId: '77',
    });
    expect(warn).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(FAST_AGENT_TELEGRAM_TYPING_REFRESH_MS);
    expect(sendMessageDraft).toHaveBeenCalledOnce();
    expect(sendChatAction).toHaveBeenCalledTimes(2);
    await activity.dispose();
    warn.mockRestore();
  });

  it.each(['success', 'failure'] as const)(
    'reasserts after a draft-clearing operation %s',
    async (outcome) => {
      const activity = { reassert: vi.fn() };
      const operation =
        outcome === 'success'
          ? vi.fn().mockResolvedValue('result')
          : vi.fn().mockRejectedValue(new Error('failed'));

      if (outcome === 'success') {
        await expect(
          runWithFastAgentTelegramActivityReassertion(activity, operation),
        ).resolves.toBe('result');
      } else {
        await expect(
          runWithFastAgentTelegramActivityReassertion(activity, operation),
        ).rejects.toThrow('failed');
      }
      expect(activity.reassert).toHaveBeenCalledOnce();
    },
  );
});
