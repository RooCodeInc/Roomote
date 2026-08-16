const {
  mockGetBrainSyncState,
  mockPostToBrain,
  mockResolveConnection,
  mockResolveProvider,
  mockUpsertBrainSyncState,
} = vi.hoisted(() => ({
  mockGetBrainSyncState: vi.fn(),
  mockPostToBrain: vi.fn(),
  mockResolveConnection: vi.fn(),
  mockResolveProvider: vi.fn(),
  mockUpsertBrainSyncState: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  resolveBrainConnection: mockResolveConnection,
  resolveBrainInferenceProvider: mockResolveProvider,
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  getBrainSyncState: mockGetBrainSyncState,
  upsertBrainSyncState: mockUpsertBrainSyncState,
}));

vi.mock('../brain-outbox-drain', () => ({
  postToBrain: mockPostToBrain,
}));

import {
  brainMaintenanceJob,
  buildDailyDigestPage,
  runBrainDailyDigest,
} from '../brain-maintenance';

function synthesisResponse(input?: {
  answer?: string;
  sources?: string[];
}): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              answer: input?.answer ?? '## Key decisions\n\nUse one digest.',
              sources: input?.sources ?? ['slack/general/2026-08-16'],
              gaps: [],
              synthesis_status: 'ok',
            }),
          },
        ],
      },
    }),
    { status: 200 },
  );
}

function searchResponse(input?: {
  results?: Array<{ slug: string; title: string }>;
}): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              results: input?.results ?? [
                {
                  slug: 'slack/general/2026-08-16',
                  title: 'Slack general — 2026-08-16',
                },
              ],
            }),
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

describe('brainMaintenanceJob', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockGetBrainSyncState.mockReset();
    mockGetBrainSyncState.mockResolvedValue(null);
    mockPostToBrain.mockReset();
    mockResolveConnection.mockReset();
    mockResolveProvider.mockReset();
    mockUpsertBrainSyncState.mockReset();
  });

  it('does nothing when the Brain provider is disabled', async () => {
    mockResolveProvider.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await brainMaintenanceJob();

    expect(mockResolveConnection).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('submits the built-in autopilot cycle with the maintenance credential', async () => {
    mockResolveProvider.mockResolvedValue({ providerId: 'openrouter' });
    mockResolveConnection.mockImplementation(async (credential: string) => ({
      baseUrl: 'http://gbrain.test/',
      token: `${credential}-token`,
    }));
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(synthesisResponse())
      .mockResolvedValueOnce(submitResponse());

    await brainMaintenanceJob();

    expect(mockResolveConnection).toHaveBeenCalledWith('maintenance');
    expect(mockResolveConnection).toHaveBeenCalledWith('ingest');
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      'http://gbrain.test/mcp',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer maintenance-token',
        }),
      }),
    );
    const request = fetchSpy.mock.calls[2]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      params: {
        name: 'submit_job',
        arguments: {
          name: 'autopilot-cycle',
          data: { pull: false },
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
    mockResolveProvider.mockResolvedValue({ providerId: 'openrouter' });
    mockResolveConnection.mockResolvedValue({
      baseUrl: 'http://gbrain.test',
      token: 'maintenance-token',
    });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(synthesisResponse())
      .mockResolvedValueOnce(new Response('{"error":"nope"}', { status: 500 }));

    await expect(brainMaintenanceJob()).rejects.toThrow(
      'gbrain submit_job failed: 500',
    );
  });

  it('still submits maintenance when daily synthesis fails', async () => {
    mockResolveProvider.mockResolvedValue({ providerId: 'openrouter' });
    mockResolveConnection.mockImplementation(async (credential: string) => ({
      baseUrl: 'http://gbrain.test',
      token: `${credential}-token`,
    }));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(
        new Response('{"error":"unavailable"}', { status: 500 }),
      )
      .mockResolvedValueOnce(submitResponse());

    await expect(brainMaintenanceJob()).rejects.toThrow(
      'gbrain synthesize failed: 500',
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });
});

describe('runBrainDailyDigest', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockGetBrainSyncState.mockReset();
    mockPostToBrain.mockReset();
    mockUpsertBrainSyncState.mockReset();
  });

  it('synthesizes only the window after the durable watermark', async () => {
    const since = new Date('2026-08-15T07:00:00.000Z');
    const until = new Date('2026-08-16T07:00:00.000Z');
    mockGetBrainSyncState.mockResolvedValue({ watermark: since });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      searchResponse({
        results: [
          { slug: 'prs/example/42', title: 'Ship a specific change' },
          {
            slug: 'slack/general/2026-08-16',
            title: 'Slack general',
          },
        ],
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      searchResponse({
        results: [
          { slug: 'prs/example/42', title: 'Ship a specific change' },
          {
            slug: 'slack/general/2026-08-16',
            title: 'Slack general',
          },
        ],
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      synthesisResponse({
        answer: '## Work shipped\n\nA specific change shipped.',
        sources: ['prs/example/42', 'slack/general/2026-08-16'],
      }),
    );

    await runBrainDailyDigest(
      { baseUrl: 'http://gbrain.test', token: 'read-token' },
      { baseUrl: 'http://gbrain.test', token: 'write-token' },
      until,
    );

    const searchRequest = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(searchRequest.body))).toMatchObject({
      params: {
        name: 'search',
        arguments: {
          since: since.toISOString(),
          until: until.toISOString(),
        },
      },
    });
    const synthesisRequest = fetchSpy.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(synthesisRequest.body))).toMatchObject({
      params: {
        name: 'synthesize',
        arguments: {
          since: since.toISOString(),
          until: until.toISOString(),
        },
      },
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
      { watermark: until },
    );
  });

  it('does not advance the watermark when the digest write fails', async () => {
    mockGetBrainSyncState.mockResolvedValue(null);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(synthesisResponse());
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

  it('rejects synthesis that cites a page outside the effective-date window', async () => {
    mockGetBrainSyncState.mockResolvedValue(null);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(
        synthesisResponse({
          answer: 'An older item was important.',
          sources: ['notion/older-page'],
        }),
      );

    await expect(
      runBrainDailyDigest(
        { baseUrl: 'http://gbrain.test', token: 'read-token' },
        { baseUrl: 'http://gbrain.test', token: 'write-token' },
        new Date('2026-08-16T07:00:00.000Z'),
      ),
    ).rejects.toThrow('outside its effective-date window');
    expect(mockPostToBrain).not.toHaveBeenCalled();
    expect(mockUpsertBrainSyncState).not.toHaveBeenCalled();
  });

  it('advances the watermark without synthesis when nothing changed', async () => {
    const until = new Date('2026-08-16T07:00:00.000Z');
    mockGetBrainSyncState.mockResolvedValue(null);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(searchResponse({ results: [] }));

    await runBrainDailyDigest(
      { baseUrl: 'http://gbrain.test', token: 'read-token' },
      { baseUrl: 'http://gbrain.test', token: 'write-token' },
      until,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockPostToBrain).not.toHaveBeenCalled();
    expect(mockUpsertBrainSyncState).toHaveBeenCalledWith(
      {},
      'roomote-daily-digest',
      { watermark: until },
    );
  });

  it('does not synthesize prior generated synthesis pages', async () => {
    const until = new Date('2026-08-16T07:00:00.000Z');
    mockGetBrainSyncState.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      searchResponse({
        results: [
          {
            slug: 'wiki/personal/reflections/task-1',
            title: 'Prior reflection',
          },
          {
            slug: 'wiki/personal/patterns/pattern-1',
            title: 'Prior pattern',
          },
          {
            slug: 'daily/digests/2026-08-15',
            title: 'Prior digest',
          },
        ],
      }),
    );

    await runBrainDailyDigest(
      { baseUrl: 'http://gbrain.test', token: 'read-token' },
      { baseUrl: 'http://gbrain.test', token: 'write-token' },
      until,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockPostToBrain).not.toHaveBeenCalled();
    expect(mockUpsertBrainSyncState).toHaveBeenCalledWith(
      {},
      'roomote-daily-digest',
      { watermark: until },
    );
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
    });

    expect(page.slug).toBe('daily/digests/2026-08-16');
    expect(page.content).toContain('## Key decisions');
    expect(page.content.match(/\[\[notion\/decision\]\]/g)).toHaveLength(1);
    expect(page.content).toContain('[[slack/general]]');
  });
});
