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
    },
    release: vi.fn(async () => {}),
    acquireLock: vi.fn(),
  };
});

vi.mock('@roomote/redis', () => ({
  getRedis: () => mocks.redis,
  acquireRedisLock: mocks.acquireLock,
}));

import { syncSlackAgentSessionTitleBestEffort } from '../agent-session-title-sync';

describe('syncSlackAgentSessionTitleBestEffort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cache.clear();
    mocks.acquireLock.mockResolvedValue(mocks.release);
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
    const renameAgentSession = vi.fn().mockResolvedValue(true);

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

  it('records an already matching reported title without renaming', async () => {
    const renameAgentSession = vi.fn();

    await syncSlackAgentSessionTitleBestEffort({
      ...baseInput,
      slack: { renameAgentSession },
      title: 'Generated Fast title',
      reportedTitle: 'Generated Fast title',
    });

    expect(renameAgentSession).not.toHaveBeenCalled();
    expect(mocks.redis.set).toHaveBeenCalledOnce();
  });

  it('deduplicates an unchanged title across calls', async () => {
    const renameAgentSession = vi.fn().mockResolvedValue(true);
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
    const renameAgentSession = vi.fn().mockResolvedValue(true);

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
    const renameAgentSession = vi.fn().mockResolvedValue(true);

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

  it('does not let an older snapshot overwrite a newer persisted title', async () => {
    const renameAgentSession = vi.fn().mockResolvedValue(true);

    await syncSlackAgentSessionTitleBestEffort({
      ...baseInput,
      slack: { renameAgentSession },
      title: 'Older title',
      resolveTitle: async () => 'Newer title',
    });

    expect(renameAgentSession).not.toHaveBeenCalled();
    expect(mocks.redis.set).not.toHaveBeenCalled();
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
