import {
  extractBrainCorpusPages,
  extractBrainPageContent,
  readBrainCorpusSample,
  resetBrainCorpusSampleCache,
} from '../brain-corpus';

vi.mock('../brain-clients', () => ({
  resolveBrainConnection: vi.fn(async () => ({
    baseUrl: 'http://brain.test',
    token: 'read-token',
  })),
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
    // gbrain answers with both structured content and a text rendering of the
    // same result, so every payload is scanned and duplicates are expected.
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

describe('readBrainCorpusSample', () => {
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

  function windowOf(start: number, count: number) {
    return Array.from({ length: count }, (_, index) => ({
      slug: `tasks/run-${start + index}`,
      title: `Run ${start + index}`,
      updated_at: '2026-08-19T10:00:00Z',
    }));
  }

  function listedOffsets(mock: ReturnType<typeof vi.fn>) {
    return mock.mock.calls.map((call) => {
      const body = JSON.parse(call[1].body as string) as {
        params: { arguments: Record<string, unknown> };
      };
      return body.params.arguments.offset;
    });
  }

  beforeEach(() => {
    resetBrainCorpusSampleCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('pages past the listing window and reports a capped sample as truncated', async () => {
    // gbrain caps list_pages at 100 per call; five full windows reach the
    // 500-page sample bound with every window full, so more likely exist.
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        params: { arguments: { offset?: number } };
      };
      return toolResponse(windowOf(body.params.arguments.offset ?? 0, 100));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const snapshot = await readBrainCorpusSample();

    expect(snapshot).not.toBeNull();
    expect(snapshot!.pages).toHaveLength(500);
    expect(snapshot!.truncated).toBe(true);
    expect(listedOffsets(fetchMock)).toEqual([0, 100, 200, 300, 400]);
  });

  it('treats a short window as the end of the corpus', async () => {
    const windows = [windowOf(0, 100), windowOf(100, 37)];
    const fetchMock = vi.fn(async () => toolResponse(windows.shift() ?? []));
    global.fetch = fetchMock as unknown as typeof fetch;

    const snapshot = await readBrainCorpusSample();

    expect(snapshot!.pages).toHaveLength(137);
    expect(snapshot!.truncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops and reports truncation when the server ignores offset', async () => {
    // The same full window answered twice means paging would loop on the
    // newest slice forever; the sample must say it only saw that slice.
    const fetchMock = vi.fn(async () => toolResponse(windowOf(0, 100)));
    global.fetch = fetchMock as unknown as typeof fetch;

    const snapshot = await readBrainCorpusSample();

    expect(snapshot!.pages).toHaveLength(100);
    expect(snapshot!.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('spends one deadline across all windows instead of one per window', async () => {
    // Three seconds per window against an eight-second listing budget: the
    // third window ends past the deadline, so a fourth is never attempted
    // and the result is honestly a truncated sample. Without the shared
    // deadline this listing would run five windows and hold the settings
    // page for the sum of the per-window timeouts.
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
        vi.advanceTimersByTime(3_000);
        const body = JSON.parse(init.body as string) as {
          params: { arguments: { offset?: number } };
        };
        return toolResponse(windowOf(body.params.arguments.offset ?? 0, 100));
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const snapshot = await readBrainCorpusSample();

      expect(snapshot!.pages).toHaveLength(300);
      expect(snapshot!.truncated).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to a bare listing on an argument-shape error, as a sample', async () => {
    let first = true;
    const fetchMock = vi.fn(async () => {
      if (first) {
        first = false;
        return toolResponse(null, true);
      }
      return toolResponse(windowOf(0, 42));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const snapshot = await readBrainCorpusSample();

    expect(snapshot!.pages).toHaveLength(42);
    expect(snapshot!.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
