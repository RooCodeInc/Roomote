import {
  FAST_AGENT_TELEGRAM_DRAFT_REFRESH_MS,
  FAST_AGENT_TELEGRAM_REASSERT_DELAY_MS,
  FAST_AGENT_TELEGRAM_TYPING_REFRESH_MS,
  createFastAgentTelegramActivity,
} from './fast-agent-telegram-activity';

describe('Fast Telegram activity', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refreshes one native Thinking draft below its TTL in private chats', async () => {
    const sendThinkingDraft = vi.fn().mockResolvedValue(undefined);
    const activity = createFastAgentTelegramActivity({
      provider: {
        sendThinkingDraft,
        sendChatAction: vi.fn(),
      },
      replyTarget: { channelId: '123', threadId: '77' },
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendThinkingDraft).toHaveBeenCalledTimes(1);
    const firstDraftId = sendThinkingDraft.mock.calls[0]![0].draftId;
    expect(sendThinkingDraft).toHaveBeenCalledWith({
      channelId: '123',
      threadId: '77',
      draftId: firstDraftId,
    });

    await vi.advanceTimersByTimeAsync(FAST_AGENT_TELEGRAM_DRAFT_REFRESH_MS);
    expect(sendThinkingDraft).toHaveBeenCalledTimes(2);
    expect(sendThinkingDraft.mock.calls[1]![0].draftId).toBe(firstDraftId);
    await activity.settle();
  });

  it('restores Thinking after an intermediate post but cancels it on true completion', async () => {
    const sendThinkingDraft = vi.fn().mockResolvedValue(undefined);
    const activity = createFastAgentTelegramActivity({
      provider: {
        sendThinkingDraft,
        sendChatAction: vi.fn(),
      },
      replyTarget: { channelId: '123' },
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(0);
    activity.reassert();
    await vi.advanceTimersByTimeAsync(
      FAST_AGENT_TELEGRAM_REASSERT_DELAY_MS - 1,
    );
    expect(sendThinkingDraft).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sendThinkingDraft).toHaveBeenCalledTimes(2);

    activity.reassert();
    await activity.settle();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_TELEGRAM_REASSERT_DELAY_MS);
    expect(sendThinkingDraft).toHaveBeenCalledTimes(2);
  });

  it('retains ordinary typing in group chats where drafts are unsupported', async () => {
    const sendChatAction = vi.fn().mockResolvedValue(undefined);
    const sendThinkingDraft = vi.fn();
    const activity = createFastAgentTelegramActivity({
      provider: { sendThinkingDraft, sendChatAction },
      replyTarget: { channelId: '-100123', threadId: '77' },
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendChatAction).toHaveBeenCalledWith({
      channelId: '-100123',
      threadId: '77',
    });
    expect(sendThinkingDraft).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_TELEGRAM_TYPING_REFRESH_MS);
    expect(sendChatAction).toHaveBeenCalledTimes(2);
    await activity.dispose();
  });
});
