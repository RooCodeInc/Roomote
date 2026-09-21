import { FastAgentPromptSkillSnapshotCache } from '../fast-agent-prompt-skill-snapshot-cache';

type Snapshot = { directory: string; revision: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

describe('FastAgentPromptSkillSnapshotCache', () => {
  let now = 0;
  const cleanup = vi.fn(async () => {});

  function createCache() {
    return new FastAgentPromptSkillSnapshotCache<Snapshot>({
      cleanup,
      coldWaitMs: 1_000,
      freshMs: 10_000,
      now: () => now,
      staleMs: 60_000,
    });
  }

  beforeEach(() => {
    now = 0;
    cleanup.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads once and serves later turns without fetching again', async () => {
    const cache = createCache();
    const load = vi.fn(async () => ({ directory: '/tmp/a', revision: 'r1' }));

    await expect(cache.get('repo', load)).resolves.toMatchObject({
      revision: 'r1',
    });
    now = 9_000;
    await expect(cache.get('repo', load)).resolves.toMatchObject({
      revision: 'r1',
    });

    expect(load).toHaveBeenCalledTimes(1);
    // The prompt never reads the checkout, so it is removed once loaded.
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('serves a stale snapshot immediately while one refresh runs behind it', async () => {
    const cache = createCache();
    await cache.get('repo', async () => ({ directory: '/a', revision: 'r1' }));
    now = 20_000;
    const refresh = deferred<Snapshot>();
    const load = vi.fn(() => refresh.promise);

    await expect(cache.get('repo', load)).resolves.toMatchObject({
      revision: 'r1',
    });
    await expect(cache.get('repo', load)).resolves.toMatchObject({
      revision: 'r1',
    });
    expect(load).toHaveBeenCalledTimes(1);

    refresh.resolve({ directory: '/b', revision: 'r2' });
    await vi.advanceTimersByTimeAsync(0);
    await expect(cache.get('repo', load)).resolves.toMatchObject({
      revision: 'r2',
    });
  });

  it('keeps serving the stale snapshot when its refresh fails', async () => {
    const cache = createCache();
    await cache.get('repo', async () => ({ directory: '/a', revision: 'r1' }));
    now = 20_000;

    await cache.get('repo', async () => {
      throw new Error('fetch failed');
    });
    await vi.advanceTimersByTimeAsync(0);

    await expect(
      cache.get('repo', async () => ({ directory: '/b', revision: 'r2' })),
    ).resolves.toMatchObject({ revision: 'r1' });
  });

  it('stops waiting on a cold load, then serves it once it finishes', async () => {
    const cache = createCache();
    const slow = deferred<Snapshot>();
    const load = vi.fn(() => slow.promise);

    const first = cache.get('repo', load);
    const firstOutcome = expect(first).rejects.toThrow('still loading');
    await vi.advanceTimersByTimeAsync(1_000);
    await firstOutcome;

    // A second turn during the same load waits on it rather than fetching.
    const second = cache.get('repo', load);
    const secondOutcome = expect(second).rejects.toThrow('still loading');
    await vi.advanceTimersByTimeAsync(1_000);
    await secondOutcome;
    expect(load).toHaveBeenCalledTimes(1);

    slow.resolve({ directory: '/a', revision: 'r1' });
    await vi.advanceTimersByTimeAsync(0);
    await expect(cache.get('repo', load)).resolves.toMatchObject({
      revision: 'r1',
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reloads a snapshot that aged past the stale window', async () => {
    const cache = createCache();
    await cache.get('repo', async () => ({ directory: '/a', revision: 'r1' }));
    now = 61_000;

    await expect(
      cache.get('repo', async () => ({ directory: '/b', revision: 'r2' })),
    ).resolves.toMatchObject({ revision: 'r2' });
  });

  it('keeps keys apart', async () => {
    const cache = createCache();
    await cache.get('a', async () => ({ directory: '/a', revision: 'ra' }));

    await expect(
      cache.get('b', async () => ({ directory: '/b', revision: 'rb' })),
    ).resolves.toMatchObject({ revision: 'rb' });
  });

  it('propagates a failed cold load and retries on the next turn', async () => {
    const cache = createCache();

    await expect(
      cache.get('repo', async () => {
        throw new Error('fetch failed');
      }),
    ).rejects.toThrow('fetch failed');
    await expect(
      cache.get('repo', async () => ({ directory: '/a', revision: 'r1' })),
    ).resolves.toMatchObject({ revision: 'r1' });
  });
});
