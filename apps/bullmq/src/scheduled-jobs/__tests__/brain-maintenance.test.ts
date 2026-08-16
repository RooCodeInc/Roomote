const {
  mockEnv,
  mockGetBrainSyncState,
  mockPostToBrain,
  mockResolveConnection,
  mockResolveProvider,
  mockUpsertBrainSyncState,
} = vi.hoisted(() => ({
  mockEnv: { TRPC_URL: 'http://api.test:3001' },
  mockGetBrainSyncState: vi.fn(),
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

import {
  brainMaintenanceJob,
  buildDailyDigestPage,
  runBrainDailyDigest,
} from '../brain-maintenance';

const TEST_PROVIDER = {
  providerId: 'openrouter' as const,
  apiKey: 'brain-provider-key',
};

function synthesisResponse(input?: {
  answer?: string;
  sources?: string[];
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
    mockResolveProvider.mockResolvedValue(TEST_PROVIDER);
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
    mockResolveProvider.mockResolvedValue(TEST_PROVIDER);
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
    mockResolveProvider.mockResolvedValue(TEST_PROVIDER);
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
      'Brain daily digest inference failed: 500',
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
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
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(synthesisResponse());

    await runBrainDailyDigest(
      { baseUrl: 'http://gbrain.test', token: 'read-token' },
      { baseUrl: 'http://gbrain.test', token: 'write-token' },
      new Date('2026-08-16T07:00:00.000Z'),
    );

    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
      'https://roomote.test/_roomote-api/api/brain/inference/v1/chat/completions',
    );
  });

  it('includes date-only pages on the timestamp watermark boundary', async () => {
    const watermark = new Date('2026-08-15T07:00:00.000Z');
    const runAt = new Date('2026-08-16T07:00:00.000Z');
    const expectedUntil = new Date('2026-08-16T06:00:00.000Z');
    mockGetBrainSyncState.mockResolvedValue({ watermark });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      searchResponse({
        results: [
          {
            slug: 'prs/example/42',
            title: 'Ship a specific change',
            effective_date: '2026-08-15',
          },
          {
            slug: 'slack/general/2026-08-16',
            title: 'Slack general',
            effective_date: '2026-08-16',
          },
        ],
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      searchResponse({
        results: [
          {
            slug: 'prs/example/42',
            title: 'Ship a specific change',
            effective_date: '2026-08-15',
          },
          {
            slug: 'slack/general/2026-08-16',
            title: 'Slack general',
            effective_date: '2026-08-16',
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
    const synthesisRequest = fetchSpy.mock.calls[1]?.[1] as RequestInit;
    const synthesisBody = JSON.parse(String(synthesisRequest.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
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
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(await asServerSentEvent(searchResponse()))
      .mockResolvedValueOnce(synthesisResponse());

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

  it('rejects synthesis that cites a page outside the bounded evidence', async () => {
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
    ).rejects.toThrow('outside its evidence window');
    expect(mockPostToBrain).not.toHaveBeenCalled();
    expect(mockUpsertBrainSyncState).not.toHaveBeenCalled();
  });

  it('advances the watermark without synthesis when nothing changed', async () => {
    const runAt = new Date('2026-08-16T07:00:00.000Z');
    const expectedUntil = new Date('2026-08-16T06:00:00.000Z');
    mockGetBrainSyncState.mockResolvedValue(null);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(searchResponse({ results: [] }));

    await runBrainDailyDigest(
      { baseUrl: 'http://gbrain.test', token: 'read-token' },
      { baseUrl: 'http://gbrain.test', token: 'write-token' },
      runAt,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
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
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
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
    );

    await runBrainDailyDigest(
      { baseUrl: 'http://gbrain.test', token: 'read-token' },
      { baseUrl: 'http://gbrain.test', token: 'write-token' },
      runAt,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
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
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
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
    );

    await runBrainDailyDigest(
      { baseUrl: 'http://gbrain.test', token: 'read-token' },
      { baseUrl: 'http://gbrain.test', token: 'write-token' },
      runAt,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockPostToBrain).not.toHaveBeenCalled();
    expect(mockUpsertBrainSyncState).toHaveBeenCalledWith(
      {},
      'roomote-daily-digest',
      { watermark: expectedUntil },
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
