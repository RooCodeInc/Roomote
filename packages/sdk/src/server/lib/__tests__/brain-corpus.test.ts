import {
  extractBrainCorpusPages,
  extractBrainPageContent,
  readBrainCorpus,
  resetBrainCorpusCache,
} from '../brain-corpus';

const { redisGet, redisSet, resolveBrainConnection } = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  resolveBrainConnection: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({ get: redisGet, set: redisSet }),
}));

vi.mock('../brain-clients', () => ({
  resolveBrainConnection,
}));

describe('extractBrainCorpusPages', () => {
  it('reads a bare array of page objects', () => {
    expect(
      extractBrainCorpusPages([
        [
          {
            slug: 'tasks/run-1',
            title: 'Fixed the drainer',
            updated_at: '2026-01-02T03:04:05Z',
          },
        ],
      ]),
    ).toEqual([
      {
        slug: 'tasks/run-1',
        title: 'Fixed the drainer',
        updatedAt: new Date('2026-01-02T03:04:05Z'),
      },
    ]);
  });

  it('reads pages wrapped under the key the tool happened to use', () => {
    const fromPages = extractBrainCorpusPages([
      { pages: [{ slug: 'slack/T1/C1/2026-01-02' }] },
    ]);
    const fromResults = extractBrainCorpusPages([
      { results: [{ slug: 'slack/T1/C1/2026-01-02' }] },
    ]);

    expect(fromPages).toEqual(fromResults);
    expect(fromPages[0]?.slug).toBe('slack/T1/C1/2026-01-02');
  });

  it('falls back to slugs listed as plain text', () => {
    expect(
      extractBrainCorpusPages(['people/member-a\npeople/member-b\n']).map(
        (page) => page.slug,
      ),
    ).toEqual(['people/member-a', 'people/member-b']);
  });

  it('keeps one entry per slug when the same page arrives twice', () => {
    expect(
      extractBrainCorpusPages([
        [{ slug: 'tasks/run-1', title: 'Structured' }],
        [{ slug: 'tasks/run-1', title: 'Text copy' }],
      ]),
    ).toHaveLength(1);
  });

  it('accepts a page whose date is missing or unparseable', () => {
    const [page] = extractBrainCorpusPages([
      [{ slug: 'notion/page-1', updated_at: 'sometime' }],
    ]);

    expect(page?.updatedAt).toBeNull();
    expect(page?.title).toBeNull();
  });

  it('ignores entries that do not identify a page', () => {
    expect(
      extractBrainCorpusPages([[{ title: 'no slug' }, '', null, 42]]),
    ).toEqual([]);
  });
});

describe('extractBrainPageContent', () => {
  it('reads the body from compiled_truth, the shape get_page actually answers', () => {
    const page = extractBrainPageContent('tasks/run-9', [
      {
        slug: 'tasks/run-9',
        title: 'Reworked the drainer',
        compiled_truth: 'The drainer now reclaims stale claims.',
        updated_at: '2026-08-18T10:00:00Z',
      },
    ]);

    expect(page).not.toBeNull();
    expect(page!.title).toBe('Reworked the drainer');
    expect(page!.content).toBe('The drainer now reclaims stale claims.');
    expect(page!.updatedAt).toEqual(new Date('2026-08-18T10:00:00Z'));
  });

  it('returns null when the answer carries neither body nor title', () => {
    expect(extractBrainPageContent('tasks/run-9', [{ ok: true }])).toBeNull();
  });
});

describe('readBrainCorpus', () => {
  const originalFetch = global.fetch;

  function toolResponse(payload: unknown, isError = false) {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: isError
          ? { isError: true, content: [{ type: 'text', text: 'bad args' }] }
          : { content: [{ type: 'text', text: JSON.stringify(payload) }] },
      }),
      { status: 200 },
    );
  }

  function windowOf(start: number, count: number, sameTimestamp = false) {
    return Array.from({ length: count }, (_, index) => ({
      slug: `tasks/run-${start + index}`,
      title: `Run ${start + index}`,
      updated_at: sameTimestamp
        ? '2026-08-19T10:00:00.000Z'
        : new Date(Date.UTC(2026, 0, 1, 0, start + index)).toISOString(),
    }));
  }

  function listedArguments(mock: ReturnType<typeof vi.fn>) {
    return mock.mock.calls.map((call) => {
      const body = JSON.parse(call[1].body as string) as {
        params: { arguments: Record<string, unknown> };
      };
      return body.params.arguments;
    });
  }

  beforeEach(() => {
    resetBrainCorpusCache();
    resolveBrainConnection.mockReset();
    resolveBrainConnection.mockResolvedValue({
      baseUrl: 'http://brain.test',
      token: 'read-token',
    });
    redisGet.mockReset();
    redisGet.mockResolvedValue(null);
    redisSet.mockReset();
    redisSet.mockResolvedValue('OK');
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('keyset-pages until a short window and returns the full corpus', async () => {
    const windows = [windowOf(0, 100), windowOf(99, 38)];
    const fetchMock = vi.fn(async () => toolResponse(windows.shift() ?? []));
    global.fetch = fetchMock as unknown as typeof fetch;

    const snapshot = await readBrainCorpus();

    expect(snapshot).not.toBeNull();
    expect(snapshot!.pages).toHaveLength(137);
    expect(listedArguments(fetchMock)).toEqual([
      { limit: 100, sort: 'updated_asc' },
      {
        limit: 100,
        sort: 'updated_asc',
        updated_after: '2026-01-01T01:38:00.000Z',
      },
    ]);
  });

  it('uses an overlap-checked offset inside a timestamp tie cluster', async () => {
    const windows = [windowOf(0, 100, true), windowOf(99, 38, true)];
    const fetchMock = vi.fn(async () => toolResponse(windows.shift() ?? []));
    global.fetch = fetchMock as unknown as typeof fetch;

    const snapshot = await readBrainCorpus();

    expect(snapshot!.pages).toHaveLength(137);
    expect(listedArguments(fetchMock)[1]).toEqual({
      limit: 100,
      sort: 'updated_asc',
      offset: 99,
    });
  });

  it('returns unavailable when list_pages ignores the keyset cursor', async () => {
    const fetchMock = vi.fn(async () => toolResponse(windowOf(0, 100)));
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(await readBrainCorpus()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares the cached full listing across settings reads', async () => {
    const fetchMock = vi.fn(async () => toolResponse(windowOf(0, 42)));
    global.fetch = fetchMock as unknown as typeof fetch;

    const first = await readBrainCorpus();
    const second = await readBrainCorpus();

    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(redisSet).toHaveBeenCalledTimes(1);
  });

  it('tops up a fresh cached snapshot with pages written since its newest row', async () => {
    vi.useFakeTimers();
    try {
      const calls: unknown[] = [];
      let windows = [windowOf(0, 42)];
      const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
        calls.push(
          (
            JSON.parse(init.body as string) as {
              params: { arguments: unknown };
            }
          ).params.arguments,
        );
        return toolResponse(windows.shift() ?? []);
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const first = await readBrainCorpus();
      expect(first?.pages).toHaveLength(42);

      // Ingestion lands one more page; a read past the top-up window sees it
      // immediately without waiting for the ten-minute census.
      vi.advanceTimersByTime(4_000);
      windows = [windowOf(42, 1)];
      const second = await readBrainCorpus();

      expect(second?.pages).toHaveLength(43);
      expect(second?.pages.some((page) => page.slug === 'tasks/run-42')).toBe(
        true,
      );
      expect(calls.at(-1)).toMatchObject({
        limit: 100,
        sort: 'updated_asc',
        updated_after: expect.stringContaining('2026-01-01'),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one top-up across a burst of reads', async () => {
    vi.useFakeTimers();
    try {
      let windows = [windowOf(0, 42)];
      const fetchMock = vi.fn(async () => toolResponse(windows.shift() ?? []));
      global.fetch = fetchMock as unknown as typeof fetch;

      await readBrainCorpus();
      vi.advanceTimersByTime(4_000);
      windows = [[]] as never;
      await readBrainCorpus();
      const callsAfterTopUp = fetchMock.mock.calls.length;
      await readBrainCorpus();
      await readBrainCorpus();

      expect(fetchMock.mock.calls.length).toBe(callsAfterTopUp);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sees a new page that shares the cached newest timestamp', async () => {
    vi.useFakeTimers();
    try {
      // Two pages stamped with one timestamp, as a bulk import writes them.
      let windows = [windowOf(0, 2, true)];
      const fetchMock = vi.fn(async () => toolResponse(windows.shift() ?? []));
      global.fetch = fetchMock as unknown as typeof fetch;

      const first = await readBrainCorpus();
      expect(first?.pages).toHaveLength(2);

      // A third page lands with that same updated_at. A strict > query from
      // the boundary would never return it.
      vi.advanceTimersByTime(4_000);
      windows = [windowOf(0, 3, true)];
      const second = await readBrainCorpus();

      expect(second?.pages).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves the cached snapshot when a top-up fails', async () => {
    vi.useFakeTimers();
    try {
      const windows = [windowOf(0, 42)];
      const fetchMock = vi.fn(async () => toolResponse(windows.shift() ?? []));
      global.fetch = fetchMock as unknown as typeof fetch;

      const first = await readBrainCorpus();
      vi.advanceTimersByTime(4_000);
      fetchMock.mockRejectedValueOnce(new Error('brain restarting'));

      const second = await readBrainCorpus();

      expect(second).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves an empty census but neither stores it nor trusts it for the full TTL', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => toolResponse([]));
      global.fetch = fetchMock as unknown as typeof fetch;

      const first = await readBrainCorpus();
      expect(first?.pages).toEqual([]);
      expect(redisSet).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Within the short window the empty snapshot is served from memory.
      await readBrainCorpus();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // First ingestion lands moments later; the very next read past the
      // short window awaits a fresh walk and returns the new pages, rather
      // than serving "nothing here" once more via stale-while-revalidate.
      vi.advanceTimersByTime(31_000);
      const windows = [windowOf(0, 42)];
      fetchMock.mockImplementation(async () =>
        toolResponse(windows.shift() ?? []),
      );
      const third = await readBrainCorpus();
      expect(third?.pages).toHaveLength(42);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-walks instead of hydrating a stored empty census', async () => {
    redisGet.mockResolvedValue(
      JSON.stringify({ generatedAt: new Date().toISOString(), pages: [] }),
    );
    const fetchMock = vi.fn(async () => toolResponse(windowOf(0, 3)));
    global.fetch = fetchMock as unknown as typeof fetch;

    const snapshot = await readBrainCorpus();

    expect(snapshot?.pages).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('hydrates a completed census from shared storage with one top-up, not a walk', async () => {
    redisGet.mockResolvedValue(
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        pages: [
          {
            slug: 'tasks/shared-run',
            title: 'Shared run',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    // The stored census may predate pages written while this process was
    // down; hydration makes the same bounded updated_after call as a warm
    // read instead of trusting it blind (or re-walking).
    const fetchMock = vi.fn(async () => toolResponse(windowOf(90, 1)));
    global.fetch = fetchMock as unknown as typeof fetch;

    const snapshot = await readBrainCorpus();

    expect(snapshot?.pages.map((page) => page.slug).sort()).toEqual([
      'tasks/run-90',
      'tasks/shared-run',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(listedArguments(fetchMock)[0]).toMatchObject({
      limit: 100,
      sort: 'updated_asc',
      // One millisecond before the stored newest row: the boundary's tie
      // cluster is deliberately re-read.
      updated_after: '2025-12-31T23:59:59.999Z',
    });
  });

  it('throttles refresh attempts when a stale cache loses its connection', async () => {
    vi.useFakeTimers();
    try {
      redisGet.mockResolvedValue(
        JSON.stringify({
          generatedAt: new Date().toISOString(),
          pages: [
            {
              slug: 'tasks/cached-run',
              title: 'Cached run',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      );
      await readBrainCorpus();

      vi.advanceTimersByTime(10 * 60_000 + 1);
      resolveBrainConnection.mockResolvedValue(null);

      expect((await readBrainCorpus())?.pages).toHaveLength(1);
      await Promise.resolve();
      await Promise.resolve();
      expect((await readBrainCorpus())?.pages).toHaveLength(1);
      // Load + its hydration top-up, then on expiry one top-up attempt plus
      // one refresh; the second read inside the failure window resolves
      // nothing further.
      expect(resolveBrainConnection).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not publish a partial corpus when a later window fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(toolResponse(windowOf(0, 100)))
      .mockResolvedValueOnce(toolResponse(null, true));
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(await readBrainCorpus()).toBeNull();
  });
});
