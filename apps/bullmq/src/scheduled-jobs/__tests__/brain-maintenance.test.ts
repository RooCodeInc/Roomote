const {
  mockEnv,
  mockGetBrainSyncState,
  mockRunBrainEntityCompilation,
  mockPostToBrain,
  mockResolveConnection,
  mockResolveProvider,
  mockUpsertBrainSyncState,
} = vi.hoisted(() => ({
  mockEnv: { TRPC_URL: 'http://api.test:3001' },
  mockGetBrainSyncState: vi.fn(),
  mockRunBrainEntityCompilation: vi.fn(),
  mockPostToBrain: vi.fn(),
  mockResolveConnection: vi.fn(),
  mockResolveProvider: vi.fn(),
  mockUpsertBrainSyncState: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  getBrainGatewayToken: () => 'brain-gateway-token',
  resolveBrainConnection: mockResolveConnection,
  resolveBrainInferenceProvider: mockResolveProvider,
}));

vi.mock('@roomote/env', () => ({
  Env: mockEnv,
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  getBrainSyncState: mockGetBrainSyncState,
  upsertBrainSyncState: mockUpsertBrainSyncState,
}));

vi.mock('../brain-outbox-drain', () => ({
  postToBrain: mockPostToBrain,
}));

vi.mock('../brain-entity-compilation', () => ({
  runBrainEntityCompilation: mockRunBrainEntityCompilation,
}));

import {
  brainMaintenanceJob,
  buildDailyDigestPage,
  buildWeeklySynthesisPage,
  runBrainDailyDigest,
  runBrainWeeklySynthesis,
} from '../brain-maintenance';

const TEST_PROVIDER = {
  providerId: 'openrouter' as const,
  apiKey: 'brain-provider-key',
};

function synthesisResponse(input?: {
  answer?: string;
  sources?: string[];
  coverageOmissions?: Record<string, string>;
}): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              answer: input?.answer ?? '## Key decisions\n\nUse one digest.',
              sources: input?.sources ?? ['slack/general/2026-08-16'],
              gaps: [],
              synthesis_status: 'ok',
              coverage_omissions: input?.coverageOmissions,
            }),
          },
        },
      ],
    }),
    { status: 200 },
  );
}

function searchResponse(input?: {
  results?: Array<{
    slug: string;
    title: string;
    chunk_text?: string;
    effective_date?: string | null;
  }>;
}): Response {
  const results = input?.results ?? [
    {
      slug: 'slack/general/2026-08-16',
      title: 'Slack general — 2026-08-16',
      effective_date: '2026-08-16',
    },
  ];

  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              results.map((result) => ({
                ...result,
                chunk_text:
                  result.chunk_text ?? `Evidence from ${result.title}.`,
              })),
            ),
          },
        ],
      },
    }),
    { status: 200 },
  );
}

function submitResponse(): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }),
    { status: 200 },
  );
}

function pageResponse(input: {
  slug: string;
  title?: string;
  content?: string;
}): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        structuredContent: {
          slug: input.slug,
          title: input.title ?? input.slug,
          compiled_truth: input.content ?? `# ${input.title ?? input.slug}`,
        },
      },
    }),
    { status: 200 },
  );
}

function mockDigestFetch(searches: Response[], following: Response[] = []) {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const paddedSearches = [
    ...searches,
    ...Array.from({ length: Math.max(0, 4 - searches.length) }, () =>
      searchResponse({ results: [] }),
    ),
  ].slice(0, 4);

  for (const response of [...paddedSearches, ...following]) {
    fetchSpy.mockResolvedValueOnce(response);
  }

  return fetchSpy;
}

function asServerSentEvent(response: Response): Promise<Response> {
  return response.text().then(
    (body) =>
      new Response(`event: message\ndata: ${body}\n\n`, {
        status: response.status,
        headers: { 'content-type': 'text/event-stream' },
      }),
  );
}

describe('brainMaintenanceJob', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T07:00:00.000Z'));
    vi.restoreAllMocks();
    mockGetBrainSyncState.mockReset();
    mockGetBrainSyncState.mockResolvedValue(null);
    mockPostToBrain.mockReset();
    mockRunBrainEntityCompilation.mockReset();
    mockRunBrainEntityCompilation.mockResolvedValue({
      scanned: 0,
      compiled: 0,
      unchanged: 0,
    });
    mockResolveConnection.mockReset();
    mockResolveProvider.mockReset();
    mockUpsertBrainSyncState.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing when the Brain provider is disabled', async () => {
    mockResolveProvider.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await brainMaintenanceJob();

    expect(mockResolveConnection).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('submits the built-in autopilot cycle with the maintenance credential', async () => {
    mockResolveProvider.mockResolvedValue(TEST_PROVIDER);
    mockResolveConnection.mockImplementation(async (credential: string) => ({
      baseUrl: 'http://gbrain.test/',
      token: `${credential}-token`,
    }));
    const fetchSpy = mockDigestFetch(
      [searchResponse()],
      [synthesisResponse(), submitResponse()],
    );

    await brainMaintenanceJob();

    expect(mockResolveConnection).toHaveBeenCalledWith('maintenance');
    expect(mockResolveConnection).toHaveBeenCalledWith('ingest');
    expect(mockRunBrainEntityCompilation).toHaveBeenCalledWith(
      { baseUrl: 'http://gbrain.test/', token: 'maintenance-token' },
      { baseUrl: 'http://gbrain.test/', token: 'ingest-token' },
      new Date('2026-08-17T07:00:00.000Z'),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      6,
      'http://gbrain.test/mcp',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer maintenance-token',
        }),
      }),
    );
    const request = fetchSpy.mock.calls[5]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      params: {
        name: 'submit_job',
        arguments: {
          name: 'autopilot-cycle',
          data: {
            pull: false,
            phases: [
              'lint',
              'backlinks',
              'sync',
              'extract',
              'extract_facts',
              'resolve_symbol_edges',
              'recompute_emotional_weight',
              'consolidate',
              'embed',
              'orphans',
              'purge',
            ],
          },
          timeout_ms: 60 * 60 * 1000,
        },
      },
    });
    expect(mockPostToBrain).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: expect.stringMatching(/^daily\/digests\//),
      }),
      {
        baseUrl: 'http://gbrain.test/',
        token: 'ingest-token',
      },
    );
  });

  it('fails the scheduler job when gbrain rejects the submission', async () => {
    mockResolveProvider.mockResolvedValue(TEST_PROVIDER);
    mockResolveConnection.mockResolvedValue({
      baseUrl: 'http://gbrain.test',
      token: 'maintenance-token',
    });
    mockDigestFetch(
      [searchResponse()],
      [synthesisResponse(), new Response('{"error":"nope"}', { status: 500 })],
    );

    await expect(brainMaintenanceJob()).rejects.toThrow(
      'gbrain submit_job failed: 500',
    );
  });

  it('still submits maintenance when daily synthesis fails', async () => {
    mockResolveProvider.mockResolvedValue(TEST_PROVIDER);
    mockResolveConnection.mockImplementation(async (credential: string) => ({
      baseUrl: 'http://gbrain.test',
      token: `${credential}-token`,
    }));
    mockDigestFetch(
      [searchResponse()],
      [
        new Response('{"error":"unavailable"}', { status: 500 }),
        submitResponse(),
      ],
    );

    await expect(brainMaintenanceJob()).rejects.toThrow(
      'Brain daily digest inference failed: 500',
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(6);
  });
});

describe('runBrainDailyDigest', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockEnv.TRPC_URL = 'http://api.test:3001';
    mockGetBrainSyncState.mockReset();
    mockPostToBrain.mockReset();
    mockResolveProvider.mockReset();
    mockResolveProvider.mockResolvedValue(TEST_PROVIDER);
    mockUpsertBrainSyncState.mockReset();
  });

  it('preserves a path-prefixed TRPC_URL for Brain inference', async () => {
    mockEnv.TRPC_URL = 'https://roomote.test/_roomote-api';
    mockGetBrainSyncState.mockResolvedValue(null);
    const fetchSpy = mockDigestFetch([searchResponse()], [synthesisResponse()]);

    await runBrainDailyDigest(
      { baseUrl: 'http://gbrain.test', token: 'read-token' },
      { baseUrl: 'http://gbrain.test', token: 'write-token' },
      new Date('2026-08-16T07:00:00.000Z'),
    );

    expect(String(fetchSpy.mock.calls[4]?.[0])).toBe(
      'https://roomote.test/_roomote-api/api/brain/inference/v1/chat/completions',
    );
  });

  it('includes date-only pages on the timestamp watermark boundary', async () => {
    const watermark = new Date('2026-08-15T07:00:00.000Z');
    const runAt = new Date('2026-08-16T07:00:00.000Z');
    const expectedUntil = new Date('2026-08-16T06:00:00.000Z');
    mockGetBrainSyncState.mockResolvedValue({ watermark });
    const fetchSpy = mockDigestFetch(
      [
        searchResponse({
          results: [
            {
              slug: 'slack/general/2026-08-16',
              title: 'Slack general',
              effective_date: '2026-08-16',
            },
          ],
        }),
        searchResponse({ results: [] }),
        searchResponse({
          results: [
            {
              slug: 'prs/example/42',
              title: 'Ship a specific change',
              effective_date: '2026-08-15',
            },
          ],
        }),
      ],
      [
        synthesisResponse({
          answer:
            '## Work shipped\n\nA specific change shipped [prs/example/42] and was discussed in Slack [slack/general/2026-08-16].',
          sources: ['prs/example/42', 'slack/general/2026-08-16'],
        }),
      ],
    );

    await runBrainDailyDigest(
      { baseUrl: 'http://gbrain.test', token: 'read-token' },
      { baseUrl: 'http://gbrain.test', token: 'write-token' },
      runAt,
    );

    const searchRequest = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(searchRequest.body))).toMatchObject({
      params: {
        name: 'query',
        arguments: {
          since: '2026-08-14T23:59:59.999Z',
          until: '2026-08-16T06:00:00.000Z',
        },
      },
    });
    for (let index = 0; index < 4; index++) {
      const request = fetchSpy.mock.calls[index]?.[1] as RequestInit;
      expect(JSON.parse(String(request.body))).toMatchObject({
        params: {
          name: 'query',
          arguments: {
            since: '2026-08-14T23:59:59.999Z',
            until: '2026-08-16T06:00:00.000Z',
            limit: 30,
          },
        },
      });
    }
    const synthesisRequest = fetchSpy.mock.calls[4]?.[1] as RequestInit;
    const synthesisBody = JSON.parse(String(synthesisRequest.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(String(fetchSpy.mock.calls[4]?.[0])).toBe(
      'http://api.test:3001/api/brain/inference/v1/chat/completions',
    );
    expect(new Headers(synthesisRequest.headers).get('authorization')).toBe(
      'Bearer brain-gateway-token',
    );
    expect(synthesisBody.messages[1]?.content).toContain(
      '"slug":"prs/example/42"',
    );
    expect(synthesisBody.messages[1]?.content).toContain(
      '"slug":"slack/general/2026-08-16"',
    );
    expect(synthesisBody.messages[1]?.content).toContain(
      '2026-08-15T06:00:00.000Z through 2026-08-16T06:00:00.000Z',
    );
    expect(JSON.parse(String(synthesisRequest.body))).toMatchObject({
      model: 'gpt-5.6-luna',
      response_format: { type: 'json_object' },
    });
    expect(mockPostToBrain).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'daily/digests/2026-08-16',
        content: expect.stringContaining('[[prs/example/42]]'),
      }),
      { baseUrl: 'http://gbrain.test', token: 'write-token' },
    );
    expect(mockUpsertBrainSyncState).toHaveBeenCalledWith(
      {},
      'roomote-daily-digest',
      { watermark: expectedUntil },
    );
  });

  it('parses MCP server-sent events with a leading event field', async () => {
    mockGetBrainSyncState.mockResolvedValue(null);
    mockDigestFetch(
      [await asServerSentEvent(searchResponse())],
      [synthesisResponse()],
    );

    await runBrainDailyDigest(
      { baseUrl: 'http://gbrain.test', token: 'read-token' },
      { baseUrl: 'http://gbrain.test', token: 'write-token' },
      new Date('2026-08-16T07:00:00.000Z'),
    );

    expect(mockPostToBrain).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'daily/digests/2026-08-16' }),
      { baseUrl: 'http://gbrain.test', token: 'write-token' },
    );
  });

  it('does not advance the watermark when the digest write fails', async () => {
    mockGetBrainSyncState.mockResolvedValue(null);
    mockDigestFetch([searchResponse()], [synthesisResponse()]);
    mockPostToBrain.mockRejectedValue(new Error('write failed'));

    await expect(
      runBrainDailyDigest(
        { baseUrl: 'http://gbrain.test', token: 'read-token' },
        { baseUrl: 'http://gbrain.test', token: 'write-token' },
        new Date('2026-08-16T07:00:00.000Z'),
      ),
    ).rejects.toThrow('write failed');
    expect(mockUpsertBrainSyncState).not.toHaveBeenCalled();
  });

  it('rejects synthesis that cites a page outside the bounded evidence', async () => {
    mockGetBrainSyncState.mockResolvedValue(null);
    mockDigestFetch(
      [searchResponse()],
      [
        synthesisResponse({
          answer: 'An older item was important.',
          sources: ['notion/older-page'],
        }),
      ],
    );

    await expect(
      runBrainDailyDigest(
        { baseUrl: 'http://gbrain.test', token: 'read-token' },
        { baseUrl: 'http://gbrain.test', token: 'write-token' },
        new Date('2026-08-16T07:00:00.000Z'),
      ),
    ).rejects.toThrow('outside its evidence window');
    expect(mockPostToBrain).not.toHaveBeenCalled();
    expect(mockUpsertBrainSyncState).not.toHaveBeenCalled();
  });

  it('rejects an out-of-window inline citation omitted from sources', async () => {
    mockGetBrainSyncState.mockResolvedValue(null);
    mockDigestFetch(
      [searchResponse()],
      [
        synthesisResponse({
          answer:
            'Current context [slack/general/2026-08-16], plus an older item [notion/older-page].',
          sources: ['slack/general/2026-08-16'],
        }),
      ],
    );

    await expect(
      runBrainDailyDigest(
        { baseUrl: 'http://gbrain.test', token: 'read-token' },
        { baseUrl: 'http://gbrain.test', token: 'write-token' },
        new Date('2026-08-16T07:00:00.000Z'),
      ),
    ).rejects.toThrow('outside its evidence window: notion/older-page');
    expect(mockPostToBrain).not.toHaveBeenCalled();
    expect(mockUpsertBrainSyncState).not.toHaveBeenCalled();
  });

  it('advances the watermark without synthesis when nothing changed', async () => {
    const runAt = new Date('2026-08-16T07:00:00.000Z');
    const expectedUntil = new Date('2026-08-16T06:00:00.000Z');
    mockGetBrainSyncState.mockResolvedValue(null);
    const fetchSpy = mockDigestFetch([]);

    await runBrainDailyDigest(
      { baseUrl: 'http://gbrain.test', token: 'read-token' },
      { baseUrl: 'http://gbrain.test', token: 'write-token' },
      runAt,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(mockPostToBrain).not.toHaveBeenCalled();
    expect(mockUpsertBrainSyncState).toHaveBeenCalledWith(
      {},
      'roomote-daily-digest',
      { watermark: expectedUntil },
    );
  });

  it('does not synthesize prior generated synthesis pages', async () => {
    const runAt = new Date('2026-08-16T07:00:00.000Z');
    const expectedUntil = new Date('2026-08-16T06:00:00.000Z');
    mockGetBrainSyncState.mockResolvedValue(null);
    const fetchSpy = mockDigestFetch([
      searchResponse({
        results: [
          {
            slug: 'wiki/personal/reflections/task-1',
            title: 'Prior reflection',
            effective_date: '2026-08-16',
          },
          {
            slug: 'wiki/personal/patterns/pattern-1',
            title: 'Prior pattern',
            effective_date: '2026-08-16',
          },
          {
            slug: 'daily/digests/2026-08-15',
            title: 'Prior digest',
            effective_date: '2026-08-15',
          },
        ],
      }),
    ]);

    await runBrainDailyDigest(
      { baseUrl: 'http://gbrain.test', token: 'read-token' },
      { baseUrl: 'http://gbrain.test', token: 'write-token' },
      runAt,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(mockPostToBrain).not.toHaveBeenCalled();
    expect(mockUpsertBrainSyncState).toHaveBeenCalledWith(
      {},
      'roomote-daily-digest',
      { watermark: expectedUntil },
    );
  });

  it('rejects query results without an effective date inside the window', async () => {
    const runAt = new Date('2026-08-16T07:00:00.000Z');
    const expectedUntil = new Date('2026-08-16T06:00:00.000Z');
    mockGetBrainSyncState.mockResolvedValue(null);
    const fetchSpy = mockDigestFetch([
      searchResponse({
        results: [
          {
            slug: 'slack/general/2026-08-14',
            title: 'Historical Slack page',
            effective_date: '2026-08-14',
          },
          {
            slug: 'notion/undated',
            title: 'Undated page',
            effective_date: null,
          },
        ],
      }),
    ]);

    await runBrainDailyDigest(
      { baseUrl: 'http://gbrain.test', token: 'read-token' },
      { baseUrl: 'http://gbrain.test', token: 'write-token' },
      runAt,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(mockPostToBrain).not.toHaveBeenCalled();
    expect(mockUpsertBrainSyncState).toHaveBeenCalledWith(
      {},
      'roomote-daily-digest',
      { watermark: expectedUntil },
    );
  });

  it('keeps evidence from each source family and excludes person profiles', async () => {
    mockGetBrainSyncState.mockResolvedValue(null);
    const fetchSpy = mockDigestFetch(
      [
        searchResponse({
          results: [
            {
              slug: 'people/member-1',
              title: 'A person profile',
              effective_date: '2026-08-16',
            },
            {
              slug: 'slack/team/channel/2026-08-16/batch',
              title: 'Slack discussion',
              effective_date: '2026-08-16',
            },
          ],
        }),
        searchResponse({
          results: [
            {
              slug: 'tasks/task-1/runs/1',
              title: 'Completed task',
              effective_date: '2026-08-16',
            },
          ],
        }),
        searchResponse({
          results: [
            {
              slug: 'prs/acme/repo/42',
              title: 'Merged pull request',
              effective_date: '2026-08-16',
            },
          ],
        }),
        searchResponse({
          results: [
            {
              slug: 'notion/decision',
              title: 'Decision document',
              effective_date: '2026-08-16',
            },
          ],
        }),
      ],
      [
        synthesisResponse({
          answer:
            'Sources [slack/team/channel/2026-08-16/batch] [tasks/task-1/runs/1] [prs/acme/repo/42] [notion/decision].',
          sources: [
            'slack/team/channel/2026-08-16/batch',
            'tasks/task-1/runs/1',
            'prs/acme/repo/42',
            'notion/decision',
          ],
        }),
      ],
    );

    await runBrainDailyDigest(
      { baseUrl: 'http://gbrain.test', token: 'read-token' },
      { baseUrl: 'http://gbrain.test', token: 'write-token' },
      new Date('2026-08-16T07:00:00.000Z'),
    );

    const synthesisRequest = fetchSpy.mock.calls[4]?.[1] as RequestInit;
    const synthesisBody = String(synthesisRequest.body);
    expect(synthesisBody).toContain('slack/team/channel/2026-08-16/batch');
    expect(synthesisBody).toContain('tasks/task-1/runs/1');
    expect(synthesisBody).toContain('prs/acme/repo/42');
    expect(synthesisBody).toContain('notion/decision');
    expect(synthesisBody).not.toContain('people/member-1');
  });

  it('records why a nonempty source family was not cited', async () => {
    mockGetBrainSyncState.mockResolvedValue(null);
    mockDigestFetch(
      [
        searchResponse({
          results: [
            {
              slug: 'slack/team/channel/2026-08-16/batch',
              title: 'Slack decision',
              effective_date: '2026-08-16',
            },
          ],
        }),
        searchResponse({
          results: [
            {
              slug: 'tasks/task-1/runs/1',
              title: 'Routine task',
              effective_date: '2026-08-16',
            },
          ],
        }),
      ],
      [
        synthesisResponse({
          answer: 'A decision was made [slack/team/channel/2026-08-16/batch].',
          sources: ['slack/team/channel/2026-08-16/batch'],
          coverageOmissions: {
            tasks: 'The task contained no durable change.',
          },
        }),
      ],
    );

    await runBrainDailyDigest(
      { baseUrl: 'http://gbrain.test', token: 'read-token' },
      { baseUrl: 'http://gbrain.test', token: 'write-token' },
      new Date('2026-08-16T07:00:00.000Z'),
    );

    expect(mockPostToBrain).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(
          '- Roomote tasks: 1 candidate, 0 cited — The task contained no durable change.',
        ),
      }),
      { baseUrl: 'http://gbrain.test', token: 'write-token' },
    );
  });
});

describe('runBrainWeeklySynthesis', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockEnv.TRPC_URL = 'http://api.test:3001';
    mockPostToBrain.mockReset();
  });

  it('updates one ISO-week page from multiple cited daily digests', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        pageResponse({
          slug: 'daily/digests/2026-08-17',
          title: 'Daily digest — 2026-08-17',
          content: '# Monday\n\nA blocker appeared.',
        }),
      )
      .mockResolvedValueOnce(
        synthesisResponse({
          answer:
            'A blocker persisted across both days [daily/digests/2026-08-17] [daily/digests/2026-08-18].',
          sources: ['daily/digests/2026-08-17', 'daily/digests/2026-08-18'],
        }),
      );

    const page = await runBrainWeeklySynthesis(
      { baseUrl: 'http://gbrain.test', token: 'read-token' },
      { baseUrl: 'http://gbrain.test', token: 'write-token' },
      {
        slug: 'daily/digests/2026-08-18',
        title: 'Daily digest — 2026-08-18',
        content: '# Daily digest — 2026-08-18\n\nTuesday decisions.',
      },
      new Date('2026-08-18T06:00:00.000Z'),
    );

    expect(page?.slug).toBe('weekly/summaries/2026-W34');
    expect(page?.content).toContain('[[daily/digests/2026-08-17]]');
    expect(page?.content).toContain('[[daily/digests/2026-08-18]]');
    expect(mockPostToBrain).toHaveBeenCalledWith(page, {
      baseUrl: 'http://gbrain.test',
      token: 'write-token',
    });
    const pageRequest = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(pageRequest.body))).toMatchObject({
      params: {
        name: 'get_page',
        arguments: {
          slug: 'daily/digests/2026-08-17',
          fuzzy: false,
        },
      },
    });
    const synthesisRequest = fetchSpy.mock.calls[1]?.[1] as RequestInit;
    const synthesisBody = JSON.parse(String(synthesisRequest.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
      'http://api.test:3001/api/brain/inference/v1/chat/completions',
    );
    expect(synthesisBody.messages[1]?.content).toContain(
      '"slug":"daily/digests/2026-08-17"',
    );
    expect(synthesisBody.messages[1]?.content).toContain(
      '"slug":"daily/digests/2026-08-18"',
    );
    expect(synthesisBody.messages[1]?.content).not.toContain(
      'slack/general/2026-08-17',
    );
  });

  it('skips weekly synthesis until two daily pages exist', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const page = await runBrainWeeklySynthesis(
      { baseUrl: 'http://gbrain.test', token: 'read-token' },
      { baseUrl: 'http://gbrain.test', token: 'write-token' },
      {
        slug: 'daily/digests/2026-08-17',
        title: 'Daily digest — 2026-08-17',
        content: '# Daily digest — 2026-08-17',
      },
      new Date('2026-08-17T06:00:00.000Z'),
    );

    expect(page).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockPostToBrain).not.toHaveBeenCalled();
  });

  it('rejects citations outside the current week evidence', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(pageResponse({ slug: 'daily/digests/2026-08-17' }))
      .mockResolvedValueOnce(
        synthesisResponse({
          answer: 'An older conclusion was important.',
          sources: ['daily/digests/2026-08-10'],
        }),
      );

    await expect(
      runBrainWeeklySynthesis(
        { baseUrl: 'http://gbrain.test', token: 'read-token' },
        { baseUrl: 'http://gbrain.test', token: 'write-token' },
        {
          slug: 'daily/digests/2026-08-18',
          title: 'Daily digest — 2026-08-18',
          content: '# Daily digest — 2026-08-18',
        },
        new Date('2026-08-18T06:00:00.000Z'),
      ),
    ).rejects.toThrow('outside its evidence window');
    expect(mockPostToBrain).not.toHaveBeenCalled();
  });

  it('does not synthesize when only the current daily digest exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            isError: true,
            content: [{ type: 'text', text: 'page_not_found: Page not found' }],
          },
        }),
        { status: 200 },
      ),
    );

    const page = await runBrainWeeklySynthesis(
      { baseUrl: 'http://gbrain.test', token: 'read-token' },
      { baseUrl: 'http://gbrain.test', token: 'write-token' },
      {
        slug: 'daily/digests/2026-08-18',
        title: 'Daily digest — 2026-08-18',
        content: '# Daily digest — 2026-08-18',
      },
      new Date('2026-08-18T06:00:00.000Z'),
    );

    expect(page).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(mockPostToBrain).not.toHaveBeenCalled();
  });
});

describe('buildDailyDigestPage', () => {
  it('writes one dated daily page with deduplicated source links', () => {
    const page = buildDailyDigestPage({
      synthesis: {
        answer: '## Key decisions\n\nUse the bounded version.',
        sources: ['notion/decision', 'notion/decision', 'slack/general'],
      },
      since: new Date('2026-08-15T07:00:00.000Z'),
      until: new Date('2026-08-16T07:00:00.000Z'),
      coverage: [
        { family: 'slack', candidates: 2, cited: 1 },
        { family: 'tasks', candidates: 0, cited: 0 },
        {
          family: 'github',
          candidates: 1,
          cited: 0,
          omissionReason: 'No high-signal GitHub change.',
        },
        { family: 'notion_meetings', candidates: 1, cited: 1 },
      ],
    });

    expect(page.slug).toBe('daily/digests/2026-08-16');
    expect(page.content).toContain('## Key decisions');
    expect(page.content.match(/\[\[notion\/decision\]\]/g)).toHaveLength(1);
    expect(page.content).toContain('[[slack/general]]');
    expect(page.content).toContain('source_coverage:');
    expect(page.content).toContain(
      '- GitHub: 1 candidate, 0 cited — No high-signal GitHub change.',
    );
  });
});

describe('buildWeeklySynthesisPage', () => {
  it('uses the ISO week-year across a calendar-year boundary', () => {
    const page = buildWeeklySynthesisPage({
      synthesis: {
        answer: '## Decisions\n\nKeep the bounded workflow.',
        sources: ['daily/digests/2026-12-31'],
      },
      weekStart: new Date('2026-12-28T00:00:00.000Z'),
      until: new Date('2027-01-01T06:00:00.000Z'),
    });

    expect(page.slug).toBe('weekly/summaries/2026-W53');
    expect(page.content).toContain('week: "2026-W53"');
  });
});
