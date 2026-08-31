const mocks = vi.hoisted(() => {
  const cache = new Map<string, string>();
  return {
    cache,
    redis: {
      get: vi.fn(async (key: string) => cache.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        cache.set(key, value);
        return 'OK';
      }),
      eval: vi.fn(
        async (
          _script: string,
          _keyCount: number,
          key: string,
          expected: string,
        ) => {
          if (cache.get(key) !== expected) return 0;
          cache.delete(key);
          return 1;
        },
      ),
    },
    release: Object.assign(
      vi.fn(async () => {}),
      {
        renew: vi.fn(async () => true),
      },
    ),
    acquireLock: vi.fn(),
  };
});

vi.mock('@roomote/redis', () => ({
  getRedis: () => mocks.redis,
  acquireRedisLock: mocks.acquireLock,
}));

import {
  normalizeSlackAgentSessionTitle,
  syncSlackAgentSessionTitleBestEffort,
} from '../agent-session-title-sync';

describe('normalizeSlackAgentSessionTitle', () => {
  it('produces a trimmed single-line title without control characters', () => {
    expect(
      normalizeSlackAgentSessionTitle('  Investigate\nSlack\tstatus\u0000  '),
    ).toBe('Investigate Slack status');
  });

  it('truncates by Unicode character without splitting emoji', () => {
    const title = `${'a'.repeat(199)}😀extra`;

    expect(normalizeSlackAgentSessionTitle(title)).toBe(`${'a'.repeat(199)}😀`);
  });
});

describe('syncSlackAgentSessionTitleBestEffort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cache.clear();
    mocks.acquireLock.mockResolvedValue(mocks.release);
    mocks.release.renew.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const baseInput = {
    workspaceId: 'T123',
    channel: 'C123',
    threadTs: '100.001',
  };

  it('renames when Slack does not report the generated title', async () => {
    const renameAgentSession = vi.fn().mockResolvedValue({ ok: true });

    await syncSlackAgentSessionTitleBestEffort({
      ...baseInput,
      slack: { renameAgentSession },
      title: 'Generated Fast title',
    });

    expect(renameAgentSession).toHaveBeenCalledWith({
      channel: 'C123',
      threadTs: '100.001',
      title: 'Generated Fast title',
    });
  });

  it('sanitizes the title before sending it to Slack', async () => {
    const renameAgentSession = vi.fn().mockResolvedValue({ ok: true });

    await syncSlackAgentSessionTitleBestEffort({
      ...baseInput,
      slack: { renameAgentSession },
      title: '  Generated\nFast\t title  ',
    });

    expect(renameAgentSession).toHaveBeenCalledWith({
      channel: 'C123',
      threadTs: '100.001',
      title: 'Generated Fast title',
    });
  });

  it('records an already matching reported title without renaming', async () => {
    const renameAgentSession = vi.fn();

    await syncSlackAgentSessionTitleBestEffort({
      ...baseInput,
      slack: { renameAgentSession },
      title: 'Generated Fast title',
      reportedTitle: 'Generated Fast title',
    });

    expect(renameAgentSession).not.toHaveBeenCalled();
    expect(mocks.redis.set).toHaveBeenCalledTimes(2);
  });

  it('deduplicates an unchanged title across calls', async () => {
    const renameAgentSession = vi.fn().mockResolvedValue({ ok: true });
    const input = {
      ...baseInput,
      slack: { renameAgentSession },
      title: 'Generated Fast title',
    };

    await syncSlackAgentSessionTitleBestEffort(input);
    await syncSlackAgentSessionTitleBestEffort(input);

    expect(renameAgentSession).toHaveBeenCalledOnce();
  });

  it('renames again when the persisted title changes', async () => {
    const renameAgentSession = vi.fn().mockResolvedValue({ ok: true });

    await syncSlackAgentSessionTitleBestEffort({
      ...baseInput,
      slack: { renameAgentSession },
      title: 'First title',
    });
    await syncSlackAgentSessionTitleBestEffort({
      ...baseInput,
      slack: { renameAgentSession },
      title: 'Second title',
    });

    expect(renameAgentSession).toHaveBeenCalledTimes(2);
  });

  it('retries lock contention so a newer title is not dropped', async () => {
    vi.useFakeTimers();
    mocks.acquireLock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mocks.release);
    const renameAgentSession = vi.fn().mockResolvedValue({ ok: true });

    const syncing = syncSlackAgentSessionTitleBestEffort({
      ...baseInput,
      slack: { renameAgentSession },
      title: 'Newer title',
    });
    await vi.advanceTimersByTimeAsync(100);
    await syncing;

    expect(mocks.acquireLock).toHaveBeenCalledTimes(2);
    expect(renameAgentSession).toHaveBeenCalledWith({
      channel: 'C123',
      threadTs: '100.001',
      title: 'Newer title',
    });
  });

  it('lets the current lock holder drain a newer pending title', async () => {
    vi.useFakeTimers();
    let locked = false;
    const release = Object.assign(
      vi.fn(async () => {
        locked = false;
      }),
      { renew: vi.fn(async () => true) },
    );
    mocks.acquireLock.mockImplementation(async () => {
      if (locked) return null;
      locked = true;
      return release;
    });
    let resolveFirstRename!: (value: { ok: true }) => void;
    const renameAgentSession = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<{ ok: true }>((resolve) => {
          resolveFirstRename = resolve;
        }),
      )
      .mockResolvedValue({ ok: true });

    const first = syncSlackAgentSessionTitleBestEffort({
      ...baseInput,
      slack: { renameAgentSession },
      title: 'Older title',
    });
    await Promise.resolve();
    await Promise.resolve();
    const second = syncSlackAgentSessionTitleBestEffort({
      ...baseInput,
      slack: { renameAgentSession },
      title: 'Newer title',
    });
    await Promise.resolve();
    resolveFirstRename({ ok: true });
    await first;
    await vi.advanceTimersByTimeAsync(100);
    await second;

    expect(renameAgentSession.mock.calls.map(([input]) => input.title)).toEqual(
      ['Newer title'],
    );
  });

  it('does not let an older snapshot overwrite a newer persisted title', async () => {
    const renameAgentSession = vi.fn().mockResolvedValue({ ok: true });

    await syncSlackAgentSessionTitleBestEffort({
      ...baseInput,
      slack: { renameAgentSession },
      title: 'Older title',
      resolveTitle: async () => 'Newer title',
    });

    expect(renameAgentSession).not.toHaveBeenCalled();
    expect(mocks.redis.set).not.toHaveBeenCalled();
  });

  it('revalidates canonical title changes inside the lock', async () => {
    const renameAgentSession = vi.fn().mockResolvedValue({ ok: true });
    const resolveTitle = vi
      .fn()
      .mockResolvedValueOnce('Older title')
      .mockResolvedValue('Newer title');

    await syncSlackAgentSessionTitleBestEffort({
      ...baseInput,
      slack: { renameAgentSession },
      title: 'Older title',
      resolveTitle,
    });

    expect(renameAgentSession).toHaveBeenCalledOnce();
    expect(renameAgentSession).toHaveBeenCalledWith({
      channel: 'C123',
      threadTs: '100.001',
      title: 'Newer title',
    });
  });

  it('does not retry the same title after Slack rejects it as invalid', async () => {
    const renameAgentSession = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'invalid_name' });
    const input = {
      ...baseInput,
      slack: { renameAgentSession },
      title: 'Rejected title',
    };

    await syncSlackAgentSessionTitleBestEffort(input);
    await syncSlackAgentSessionTitleBestEffort(input);

    expect(renameAgentSession).toHaveBeenCalledOnce();
    expect(mocks.redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/:rejected:[a-f0-9]{64}$/u),
      '1',
      'EX',
      3600,
    );
  });

  it('still attempts a changed title after an invalid title rejection', async () => {
    const renameAgentSession = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'invalid_name' })
      .mockResolvedValueOnce({ ok: true });

    await syncSlackAgentSessionTitleBestEffort({
      ...baseInput,
      slack: { renameAgentSession },
      title: 'Rejected title',
    });
    await syncSlackAgentSessionTitleBestEffort({
      ...baseInput,
      slack: { renameAgentSession },
      title: 'Valid replacement',
    });

    expect(renameAgentSession).toHaveBeenCalledTimes(2);
  });

  it('remembers each rejected title independently', async () => {
    const renameAgentSession = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'invalid_name' });

    for (const title of ['Rejected A', 'Rejected B', 'Rejected A']) {
      await syncSlackAgentSessionTitleBestEffort({
        ...baseInput,
        slack: { renameAgentSession },
        title,
      });
    }

    expect(renameAgentSession.mock.calls.map(([input]) => input.title)).toEqual(
      ['Rejected A', 'Rejected B'],
    );
  });

  it('retries transient rename failures', async () => {
    const renameAgentSession = vi.fn().mockResolvedValue({ ok: false });
    const input = {
      ...baseInput,
      slack: { renameAgentSession },
      title: 'Retryable title',
    };

    await syncSlackAgentSessionTitleBestEffort(input);
    await syncSlackAgentSessionTitleBestEffort(input);

    expect(renameAgentSession).toHaveBeenCalledTimes(2);
  });

  it('omits blank titles and contains Redis failures', async () => {
    const renameAgentSession = vi.fn();
    await syncSlackAgentSessionTitleBestEffort({
      ...baseInput,
      slack: { renameAgentSession },
      title: '   ',
    });
    expect(renameAgentSession).not.toHaveBeenCalled();

    mocks.acquireLock.mockRejectedValueOnce(new Error('Redis unavailable'));
    await expect(
      syncSlackAgentSessionTitleBestEffort({
        ...baseInput,
        slack: { renameAgentSession },
        title: 'Generated Fast title',
      }),
    ).resolves.toBeUndefined();
  });
});
