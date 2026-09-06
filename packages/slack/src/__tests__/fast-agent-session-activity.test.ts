import {
  createFastAgentSlackSessionActivity,
  FAST_AGENT_SLACK_PROCESSING_DELAY_MS,
} from '../fast-agent-session-activity';
import type { syncSlackAgentSessionTitleBestEffort } from '../agent-session-title-sync';
import type { SlackNotifier } from '../slack-notifier';

describe('createFastAgentSlackSessionActivity', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createActivity(input: {
    title?: string | null;
    resolveTitle?: () => Promise<string | null | undefined>;
    setAgentSessionStatus?: ReturnType<
      typeof vi.fn<SlackNotifier['setAgentSessionStatus']>
    >;
    syncTitle?: ReturnType<
      typeof vi.fn<typeof syncSlackAgentSessionTitleBestEffort>
    >;
  }) {
    const setAgentSessionStatus =
      input.setAgentSessionStatus ??
      vi
        .fn<SlackNotifier['setAgentSessionStatus']>()
        .mockResolvedValue({ ok: true });
    const syncTitle =
      input.syncTitle ??
      vi
        .fn<typeof syncSlackAgentSessionTitleBestEffort>()
        .mockResolvedValue(undefined);
    return {
      activity: createFastAgentSlackSessionActivity({
        slack: {
          renameAgentSession: vi.fn(),
          setAgentSessionStatus,
        },
        workspaceId: 'T123',
        channel: 'C123',
        threadTs: '100.001',
        title: input.title,
        resolveTitle: input.resolveTitle,
        syncTitle,
      }),
      setAgentSessionStatus,
      syncTitle,
    };
  }

  it('initializes an idle Slack session when the turn settles before the delay', async () => {
    vi.useFakeTimers();
    const { activity, setAgentSessionStatus, syncTitle } = createActivity({});

    activity.start();
    await activity.settle();
    await vi.runAllTimersAsync();

    expect(setAgentSessionStatus).toHaveBeenCalledExactlyOnceWith({
      channel: 'C123',
      threadTs: '100.001',
      status: 'active',
    });
    expect(syncTitle).not.toHaveBeenCalled();
  });

  it('creates an untitled session without sending or syncing a fallback', async () => {
    vi.useFakeTimers();
    const { activity, setAgentSessionStatus, syncTitle } = createActivity({
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
    expect(syncTitle).not.toHaveBeenCalled();
  });

  it('syncs a persisted title even when setStatus omits its current title', async () => {
    vi.useFakeTimers();
    const { activity, syncTitle } = createActivity({
      title: 'Investigate Slack agent status',
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_SLACK_PROCESSING_DELAY_MS);
    await activity.settle();

    expect(syncTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'T123',
        channel: 'C123',
        threadTs: '100.001',
        title: 'Investigate Slack agent status',
        reportedTitle: undefined,
      }),
    );
  });

  it('syncs a title generated after the Slack session was created', async () => {
    vi.useFakeTimers();
    const { activity, setAgentSessionStatus, syncTitle } = createActivity({});

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_SLACK_PROCESSING_DELAY_MS);
    activity.updateTitle?.('Generated Fast title');
    await activity.settle();

    expect(syncTitle).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Generated Fast title' }),
    );
    expect(setAgentSessionStatus).toHaveBeenNthCalledWith(2, {
      channel: 'C123',
      threadTs: '100.001',
      status: 'active',
    });
  });

  it('syncs a generated title that arrives after the turn settles', async () => {
    vi.useFakeTimers();
    const { activity, syncTitle } = createActivity({});

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_SLACK_PROCESSING_DELAY_MS);
    await activity.settle();
    activity.updateTitle?.('Generated after settlement');
    await Promise.resolve();
    await Promise.resolve();

    expect(syncTitle).toHaveBeenCalledOnce();
    expect(syncTitle).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Generated after settlement' }),
    );
  });

  it('creates a titled active session when a short turn generates its title', async () => {
    vi.useFakeTimers();
    const { activity, setAgentSessionStatus, syncTitle } = createActivity({});

    activity.start();
    activity.updateTitle?.('Fast title before settlement');
    await activity.settle();
    await vi.runAllTimersAsync();

    expect(setAgentSessionStatus).toHaveBeenCalledOnce();
    expect(setAgentSessionStatus).toHaveBeenCalledWith({
      channel: 'C123',
      threadTs: '100.001',
      status: 'active',
    });
    expect(syncTitle).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Fast title before settlement' }),
    );
  });

  it('creates a titled active session when a short turn title arrives after settlement', async () => {
    vi.useFakeTimers();
    const { activity, setAgentSessionStatus, syncTitle } = createActivity({});

    activity.start();
    await activity.settle();
    activity.updateTitle?.('Fast title after settlement');
    await Promise.resolve();
    await Promise.resolve();

    expect(setAgentSessionStatus).toHaveBeenCalledWith({
      channel: 'C123',
      threadTs: '100.001',
      status: 'active',
    });
    expect(syncTitle).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Fast title after settlement' }),
    );
  });

  it('passes a canonical resolver so stale turn titles cannot overwrite newer titles', async () => {
    vi.useFakeTimers();
    const { activity, syncTitle } = createActivity({
      title: 'Older turn title',
      resolveTitle: async () => 'Newer persisted title',
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_SLACK_PROCESSING_DELAY_MS);
    await activity.settle();

    const resolver = syncTitle.mock.calls[0]![0].resolveTitle;
    await expect(resolver?.()).resolves.toBe('Newer persisted title');
  });

  it.each([undefined, 'Initial title'])(
    'does not clear a newer turn status when a short turn receives a late title (%s)',
    async (title) => {
      vi.useFakeTimers();
      const first = createActivity({ title });
      first.activity.start();
      await first.activity.settle();

      const second = createActivity({
        setAgentSessionStatus: first.setAgentSessionStatus,
      });
      second.activity.start();
      await vi.advanceTimersByTimeAsync(FAST_AGENT_SLACK_PROCESSING_DELAY_MS);

      first.activity.updateTitle?.('Late title');
      await vi.runAllTimersAsync();

      expect(
        first.setAgentSessionStatus.mock.calls.map(([input]) => input.status),
      ).toEqual(['active', 'processing']);
      expect(first.syncTitle).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Late title' }),
      );

      await second.activity.settle();
      expect(first.setAgentSessionStatus).toHaveBeenLastCalledWith({
        channel: 'C123',
        threadTs: '100.001',
        status: 'active',
      });
    },
  );

  it('waits for title synchronization before active cleanup', async () => {
    vi.useFakeTimers();
    let resolveSync!: () => void;
    const syncTitle = vi
      .fn(
        () =>
          new Promise<void>((resolve) => {
            resolveSync = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    syncTitle.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSync = resolve;
        }),
    );
    const { activity, setAgentSessionStatus } = createActivity({
      title: 'Investigate Slack agent status',
      syncTitle,
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_SLACK_PROCESSING_DELAY_MS);
    const settling = activity.settle();

    expect(setAgentSessionStatus).toHaveBeenCalledTimes(1);
    resolveSync();
    await settling;
    expect(setAgentSessionStatus).toHaveBeenCalledTimes(2);
  });

  it('attempts active cleanup when processing is rejected', async () => {
    vi.useFakeTimers();
    const setAgentSessionStatus = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    const { activity, syncTitle } = createActivity({
      title: 'Investigate Slack agent status',
      setAgentSessionStatus,
    });

    activity.start();
    await vi.advanceTimersByTimeAsync(FAST_AGENT_SLACK_PROCESSING_DELAY_MS);
    await activity.settle();

    expect(
      setAgentSessionStatus.mock.calls.map(([input]) => input.status),
    ).toEqual(['processing', 'active']);
    expect(syncTitle).not.toHaveBeenCalled();
  });
});
