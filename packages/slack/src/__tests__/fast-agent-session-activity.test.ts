import {
  createFastAgentSlackSessionActivity,
  FAST_AGENT_SLACK_PROCESSING_DELAY_MS,
} from '../fast-agent-session-activity';

describe('createFastAgentSlackSessionActivity', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips Slack activity when the turn settles before the delay', async () => {
    vi.useFakeTimers();
    const setAgentSessionStatus = vi.fn();
    const renameAgentSession = vi.fn();
    const activity = createFastAgentSlackSessionActivity({
      slack: { renameAgentSession, setAgentSessionStatus },
      channel: 'C123',
      threadTs: '100.001',
    });

    activity.start();
    await activity.settle();
    await vi.runAllTimersAsync();

    expect(setAgentSessionStatus).not.toHaveBeenCalled();
    expect(renameAgentSession).not.toHaveBeenCalled();
  });

  it('creates an untitled session without sending a fallback title', async () => {
    vi.useFakeTimers();
    const setAgentSessionStatus = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });
    const renameAgentSession = vi.fn();
    const activity = createFastAgentSlackSessionActivity({
      slack: { renameAgentSession, setAgentSessionStatus },
      channel: 'C123',
      threadTs: '100.001',
      title: '   ',
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_SLACK_PROCESSING_DELAY_MS);
    await activity.settle();

    expect(setAgentSessionStatus).toHaveBeenNthCalledWith(1, {
      channel: 'C123',
      threadTs: '100.001',
      status: 'processing',
    });
    expect(setAgentSessionStatus).toHaveBeenNthCalledWith(2, {
      channel: 'C123',
      threadTs: '100.001',
      status: 'active',
    });
    expect(renameAgentSession).not.toHaveBeenCalled();
  });

  it('does not rename when Slack already has the Fast title', async () => {
    vi.useFakeTimers();
    const setAgentSessionStatus = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        title: 'Investigate Slack agent status',
      })
      .mockResolvedValueOnce({ ok: true });
    const renameAgentSession = vi.fn();
    const activity = createFastAgentSlackSessionActivity({
      slack: { renameAgentSession, setAgentSessionStatus },
      channel: 'C123',
      threadTs: '100.001',
      title: 'Investigate Slack agent status',
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_SLACK_PROCESSING_DELAY_MS);
    await activity.settle();

    expect(renameAgentSession).not.toHaveBeenCalled();
    expect(setAgentSessionStatus).toHaveBeenNthCalledWith(2, {
      channel: 'C123',
      threadTs: '100.001',
      status: 'active',
      title: 'Investigate Slack agent status',
    });
  });

  it('does not rename when Slack omits the current title', async () => {
    vi.useFakeTimers();
    const setAgentSessionStatus = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });
    const renameAgentSession = vi.fn();
    const activity = createFastAgentSlackSessionActivity({
      slack: { renameAgentSession, setAgentSessionStatus },
      channel: 'C123',
      threadTs: '100.001',
      title: 'Investigate Slack agent status',
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_SLACK_PROCESSING_DELAY_MS);
    activity.updateTitle?.('Investigate Slack agent status');
    await activity.settle();

    expect(renameAgentSession).not.toHaveBeenCalled();
  });

  it('bounds a persisted title to Slack’s 200-character limit', async () => {
    vi.useFakeTimers();
    const persistedTitle = `Status ${'detail'.repeat(40)}`;
    const title = persistedTitle.slice(0, 200);
    const setAgentSessionStatus = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, title })
      .mockResolvedValueOnce({ ok: true, title });
    const renameAgentSession = vi.fn();
    const activity = createFastAgentSlackSessionActivity({
      slack: { renameAgentSession, setAgentSessionStatus },
      channel: 'C123',
      threadTs: '100.001',
      title: persistedTitle,
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_SLACK_PROCESSING_DELAY_MS);
    await activity.settle();

    expect(setAgentSessionStatus).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ title }),
    );
    expect(setAgentSessionStatus).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ title }),
    );
    expect(renameAgentSession).not.toHaveBeenCalled();
  });

  it('renames an untitled session when its Fast title is generated', async () => {
    vi.useFakeTimers();
    const setAgentSessionStatus = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, title: 'Slack default title' })
      .mockResolvedValueOnce({ ok: true });
    const renameAgentSession = vi.fn().mockResolvedValue(true);
    const activity = createFastAgentSlackSessionActivity({
      slack: { renameAgentSession, setAgentSessionStatus },
      channel: 'C123',
      threadTs: '100.001',
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_SLACK_PROCESSING_DELAY_MS);
    activity.updateTitle?.('Generated Fast title');
    await activity.settle();

    expect(renameAgentSession).toHaveBeenCalledWith({
      channel: 'C123',
      threadTs: '100.001',
      title: 'Generated Fast title',
    });
    expect(setAgentSessionStatus).toHaveBeenNthCalledWith(2, {
      channel: 'C123',
      threadTs: '100.001',
      status: 'active',
      title: 'Generated Fast title',
    });
  });

  it('renames a generated title after a short turn has already settled', async () => {
    vi.useFakeTimers();
    const setAgentSessionStatus = vi.fn();
    const renameAgentSession = vi.fn().mockResolvedValue(true);
    const activity = createFastAgentSlackSessionActivity({
      slack: { renameAgentSession, setAgentSessionStatus },
      channel: 'C123',
      threadTs: '100.001',
    });

    activity.start();
    await activity.settle();
    activity.updateTitle?.('Generated Fast title');
    await vi.runAllTimersAsync();

    expect(setAgentSessionStatus).not.toHaveBeenCalled();
    expect(renameAgentSession).toHaveBeenCalledOnce();
    expect(renameAgentSession).toHaveBeenCalledWith({
      channel: 'C123',
      threadTs: '100.001',
      title: 'Generated Fast title',
    });
  });

  it('retries a generated title after status creates the Slack session', async () => {
    vi.useFakeTimers();
    let resolveProcessing!: (value: { ok: true }) => void;
    const processing = new Promise<{ ok: true }>((resolve) => {
      resolveProcessing = resolve;
    });
    const setAgentSessionStatus = vi
      .fn()
      .mockReturnValueOnce(processing)
      .mockResolvedValueOnce({ ok: true });
    const renameAgentSession = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const activity = createFastAgentSlackSessionActivity({
      slack: { renameAgentSession, setAgentSessionStatus },
      channel: 'C123',
      threadTs: '100.001',
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_SLACK_PROCESSING_DELAY_MS);
    activity.updateTitle?.('Generated Fast title');
    await vi.waitFor(() => expect(renameAgentSession).toHaveBeenCalledOnce());

    resolveProcessing({ ok: true });
    await activity.settle();

    expect(renameAgentSession).toHaveBeenCalledTimes(2);
    expect(renameAgentSession).toHaveBeenLastCalledWith({
      channel: 'C123',
      threadTs: '100.001',
      title: 'Generated Fast title',
    });
  });

  it('does not rename blank or unchanged generated titles', async () => {
    vi.useFakeTimers();
    const setAgentSessionStatus = vi.fn();
    const renameAgentSession = vi.fn();
    const activity = createFastAgentSlackSessionActivity({
      slack: { renameAgentSession, setAgentSessionStatus },
      channel: 'C123',
      threadTs: '100.001',
      title: 'Existing Fast title',
    });

    activity.start();
    await activity.settle();
    activity.updateTitle?.('Existing Fast title');
    activity.updateTitle?.('   ');
    await vi.runAllTimersAsync();

    expect(renameAgentSession).not.toHaveBeenCalled();
  });

  it('keeps generated title rename failures non-fatal', async () => {
    vi.useFakeTimers();
    const setAgentSessionStatus = vi.fn();
    const renameAgentSession = vi
      .fn()
      .mockRejectedValue(new Error('Slack unavailable'));
    const activity = createFastAgentSlackSessionActivity({
      slack: { renameAgentSession, setAgentSessionStatus },
      channel: 'C123',
      threadTs: '100.001',
    });

    activity.start();
    await activity.settle();
    activity.updateTitle?.('Generated Fast title');
    await vi.runAllTimersAsync();

    expect(renameAgentSession).toHaveBeenCalledOnce();
  });

  it('renames an existing session before active cleanup when the title changed', async () => {
    vi.useFakeTimers();
    let resolveRename!: (value: boolean) => void;
    const rename = new Promise<boolean>((resolve) => {
      resolveRename = resolve;
    });
    const setAgentSessionStatus = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, title: 'Old title' })
      .mockResolvedValueOnce({ ok: true });
    const renameAgentSession = vi.fn().mockReturnValue(rename);
    const activity = createFastAgentSlackSessionActivity({
      slack: { renameAgentSession, setAgentSessionStatus },
      channel: 'C123',
      threadTs: '100.001',
      title: 'Investigate Slack agent status',
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_SLACK_PROCESSING_DELAY_MS);
    const settling = activity.settle();

    expect(renameAgentSession).toHaveBeenCalledWith({
      channel: 'C123',
      threadTs: '100.001',
      title: 'Investigate Slack agent status',
    });
    expect(setAgentSessionStatus).toHaveBeenCalledTimes(1);

    resolveRename(true);
    await settling;

    expect(setAgentSessionStatus).toHaveBeenNthCalledWith(2, {
      channel: 'C123',
      threadTs: '100.001',
      status: 'active',
      title: 'Investigate Slack agent status',
    });
  });

  it('attempts active cleanup when processing is rejected', async () => {
    vi.useFakeTimers();
    const setAgentSessionStatus = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    const renameAgentSession = vi.fn();
    const activity = createFastAgentSlackSessionActivity({
      slack: { renameAgentSession, setAgentSessionStatus },
      channel: 'C123',
      threadTs: '100.001',
      title: 'Investigate Slack agent status',
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_SLACK_PROCESSING_DELAY_MS);
    await activity.settle();

    expect(
      setAgentSessionStatus.mock.calls.map(([input]) => input.status),
    ).toEqual(['processing', 'active']);
    expect(renameAgentSession).not.toHaveBeenCalled();
    expect(setAgentSessionStatus).toHaveBeenNthCalledWith(2, {
      channel: 'C123',
      threadTs: '100.001',
      status: 'active',
      title: 'Investigate Slack agent status',
    });
  });
});
