import {
  createFastAgentSlackSessionActivity,
  FAST_AGENT_SLACK_PROCESSING_DELAY_MS,
  FAST_AGENT_SLACK_SESSION_TITLE,
} from '../fast-agent-session-activity';

describe('createFastAgentSlackSessionActivity', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips Slack status writes when the turn settles before the delay', async () => {
    vi.useFakeTimers();
    const setAgentSessionStatus = vi.fn().mockResolvedValue(true);
    const activity = createFastAgentSlackSessionActivity({
      slack: { setAgentSessionStatus },
      channel: 'C123',
      threadTs: '100.001',
    });

    activity.start();
    await activity.settle();
    await vi.runAllTimersAsync();

    expect(setAgentSessionStatus).not.toHaveBeenCalled();
  });

  it('serializes processing and active updates for a long turn', async () => {
    vi.useFakeTimers();
    let resolveProcessing!: (value: boolean) => void;
    const processing = new Promise<boolean>((resolve) => {
      resolveProcessing = resolve;
    });
    const setAgentSessionStatus = vi
      .fn()
      .mockReturnValueOnce(processing)
      .mockResolvedValueOnce(true);
    const activity = createFastAgentSlackSessionActivity({
      slack: { setAgentSessionStatus },
      channel: 'C123',
      threadTs: '100.001',
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_SLACK_PROCESSING_DELAY_MS);
    const settling = activity.settle();

    expect(setAgentSessionStatus).toHaveBeenCalledTimes(1);
    expect(setAgentSessionStatus).toHaveBeenNthCalledWith(1, {
      channel: 'C123',
      threadTs: '100.001',
      status: 'processing',
      title: FAST_AGENT_SLACK_SESSION_TITLE,
    });

    resolveProcessing(true);
    await settling;

    expect(setAgentSessionStatus).toHaveBeenNthCalledWith(2, {
      channel: 'C123',
      threadTs: '100.001',
      status: 'active',
      title: FAST_AGENT_SLACK_SESSION_TITLE,
    });
  });

  it('attempts active cleanup even when processing is rejected', async () => {
    vi.useFakeTimers();
    const setAgentSessionStatus = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const activity = createFastAgentSlackSessionActivity({
      slack: { setAgentSessionStatus },
      channel: 'C123',
      threadTs: '100.001',
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_SLACK_PROCESSING_DELAY_MS);
    await activity.settle();

    expect(
      setAgentSessionStatus.mock.calls.map(([input]) => input.status),
    ).toEqual(['processing', 'active']);
  });
});
