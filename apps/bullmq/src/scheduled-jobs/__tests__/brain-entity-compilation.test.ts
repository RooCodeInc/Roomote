import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCallBrainWriteTool,
  mockGetBrainSyncState,
  mockListCanonicalPersonReferences,
  mockUpsertBrainSyncState,
  state,
  testEnv,
} = vi.hoisted(() => ({
  mockCallBrainWriteTool: vi.fn(),
  mockGetBrainSyncState: vi.fn(),
  mockListCanonicalPersonReferences: vi.fn(),
  mockUpsertBrainSyncState: vi.fn(),
  state: new Map<
    string,
    { watermark: Date | null; backfillCursor: string | null }
  >(),
  testEnv: {
    TRPC_URL: 'http://api.test:3001',
    R_BRAIN_ENTITY_COMPILATION_SCAN_LIMIT: 100,
    R_BRAIN_ENTITY_COMPILATION_BATCH_SIZE: 10,
    R_BRAIN_ENTITY_COMPILATION_TIMELINE_LIMIT: 100,
    R_BRAIN_ENTITY_COMPILATION_MAX_EVIDENCE_CHARS: 30_000,
  },
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  getBrainSyncState: mockGetBrainSyncState,
  upsertBrainSyncState: mockUpsertBrainSyncState,
}));

vi.mock('@roomote/env', () => ({ Env: testEnv }));

vi.mock('@roomote/sdk/server', () => ({
  getBrainGatewayToken: () => 'gateway-token',
}));

vi.mock('../brain-collectors', () => ({
  listCanonicalPersonReferences: mockListCanonicalPersonReferences,
}));

vi.mock('../brain-outbox-drain', () => ({
  callBrainWriteTool: mockCallBrainWriteTool,
}));

import {
  runBrainEntityCompilation,
  selectEntityCompilationBatch,
} from '../brain-entity-compilation';

const readConnection = { baseUrl: 'http://brain.test', token: 'read-token' };
const writeConnection = {
  baseUrl: 'http://brain.test',
  token: 'write-token',
};

function timelineResponse(
  source = 'meetings/2026-08-17-product-sync',
): Response {
  return Response.json({
    jsonrpc: '2.0',
    id: 1,
    result: {
      structuredContent: [
        {
          date: '2026-08-17',
          source,
          summary: 'Attended Product Sync',
          detail: 'Discussed a concrete launch decision.',
        },
      ],
    },
  });
}

function synthesisResponse(
  source = 'meetings/2026-08-17-product-sync',
): Response {
  return Response.json({
    choices: [
      {
        message: {
          content: JSON.stringify({
            answer: `Participated in the launch decision [${source}].`,
            sources: [source],
          }),
        },
      },
    ],
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  state.clear();
  testEnv.R_BRAIN_ENTITY_COMPILATION_SCAN_LIMIT = 100;
  testEnv.R_BRAIN_ENTITY_COMPILATION_BATCH_SIZE = 10;
  mockCallBrainWriteTool.mockReset();
  mockCallBrainWriteTool.mockResolvedValue('{}');
  mockListCanonicalPersonReferences.mockReset();
  mockListCanonicalPersonReferences.mockResolvedValue([
    { slug: 'people/roomote-member-a', title: 'Alice' },
  ]);
  mockGetBrainSyncState.mockReset();
  mockGetBrainSyncState.mockImplementation(
    async (_db: unknown, id: string) => state.get(id) ?? null,
  );
  mockUpsertBrainSyncState.mockReset();
  mockUpsertBrainSyncState.mockImplementation(
    async (
      _db: unknown,
      id: string,
      patch: { watermark?: Date | null; backfillCursor?: string | null },
    ) => {
      state.set(id, {
        watermark: patch.watermark ?? state.get(id)?.watermark ?? null,
        backfillCursor:
          patch.backfillCursor ?? state.get(id)?.backfillCursor ?? null,
      });
    },
  );
});

describe('selectEntityCompilationBatch', () => {
  it('selects a stable bounded slice after the durable cursor', () => {
    expect(
      selectEntityCompilationBatch(
        [
          { slug: 'people/c', title: 'C' },
          { slug: 'people/a', title: 'A' },
          { slug: 'people/b', title: 'B' },
        ],
        'people/a',
        1,
      ),
    ).toEqual([{ slug: 'people/b', title: 'B' }]);
  });
});

describe('runBrainEntityCompilation', () => {
  it('replaces only generated prose, then skips the unchanged entity next run', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(timelineResponse())
      .mockResolvedValueOnce(synthesisResponse())
      .mockResolvedValueOnce(timelineResponse());

    const first = await runBrainEntityCompilation(
      readConnection,
      writeConnection,
      new Date('2026-08-18T07:00:00Z'),
    );
    const second = await runBrainEntityCompilation(
      readConnection,
      writeConnection,
      new Date('2026-08-19T07:00:00Z'),
    );

    expect(first).toEqual({ scanned: 1, compiled: 1, unchanged: 0 });
    expect(second).toEqual({ scanned: 1, compiled: 0, unchanged: 1 });
    expect(mockCallBrainWriteTool).toHaveBeenCalledTimes(1);
    expect(mockCallBrainWriteTool).toHaveBeenCalledWith(
      writeConnection,
      'replace_compiled_section',
      {
        slug: 'people/roomote-member-a',
        start_marker: '<!-- roomote:compiled-activity:start -->',
        end_marker: '<!-- roomote:compiled-activity:end -->',
        content:
          '## Activity summary\n\nParticipated in the launch decision [meetings/2026-08-17-product-sync].\n\n### Sources\n\n- [[meetings/2026-08-17-product-sync]]',
      },
    );
  });

  it('bounds changed compilation independently from the scan cap', async () => {
    testEnv.R_BRAIN_ENTITY_COMPILATION_BATCH_SIZE = 1;
    mockListCanonicalPersonReferences.mockResolvedValue([
      { slug: 'people/roomote-member-a', title: 'Alice' },
      { slug: 'people/roomote-member-b', title: 'Bob' },
    ]);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(timelineResponse('meetings/alice'))
      .mockResolvedValueOnce(synthesisResponse('meetings/alice'))
      .mockResolvedValueOnce(timelineResponse('meetings/bob'));

    const result = await runBrainEntityCompilation(
      readConnection,
      writeConnection,
    );

    expect(result).toEqual({ scanned: 2, compiled: 1, unchanged: 0 });
    expect(mockCallBrainWriteTool).toHaveBeenCalledTimes(1);
    expect(state.get('roomote-entity-compilation')?.backfillCursor).toBe(
      'people/roomote-member-a',
    );
  });

  it('rejects uncited prose without advancing successful compilation state', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(timelineResponse())
      .mockResolvedValueOnce(
        synthesisResponse('meetings/outside-the-entity-timeline'),
      );

    await expect(
      runBrainEntityCompilation(readConnection, writeConnection),
    ).rejects.toThrow('outside its timeline');
    expect(mockCallBrainWriteTool).not.toHaveBeenCalled();
    expect(state.size).toBe(0);
  });

  it.each([
    '<!-- roomote:compiled-activity:start -->',
    '<!-- roomote:compiled-activity:end -->',
    '<!-- roomote:identity:start -->',
    '<!-- roomote:identity:end -->',
  ])(
    'rejects generated boundary marker %s before it can poison later retries',
    async (marker) => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(timelineResponse())
        .mockResolvedValueOnce(
          Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    answer: `Supported claim [meetings/2026-08-17-product-sync].\n${marker}`,
                    sources: ['meetings/2026-08-17-product-sync'],
                  }),
                },
              },
            ],
          }),
        );

      await expect(
        runBrainEntityCompilation(readConnection, writeConnection),
      ).rejects.toThrow('reserved section markers');
      expect(mockCallBrainWriteTool).not.toHaveBeenCalled();
      expect(state.size).toBe(0);
    },
  );

  it('retries a failed replacement and checkpoints only after it succeeds', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(timelineResponse())
      .mockResolvedValueOnce(synthesisResponse())
      .mockResolvedValueOnce(timelineResponse())
      .mockResolvedValueOnce(synthesisResponse());
    mockCallBrainWriteTool
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce('{}');

    await expect(
      runBrainEntityCompilation(readConnection, writeConnection),
    ).rejects.toThrow('write failed');
    expect(state.size).toBe(0);

    await expect(
      runBrainEntityCompilation(readConnection, writeConnection),
    ).resolves.toEqual({ scanned: 1, compiled: 1, unchanged: 0 });
    expect(mockCallBrainWriteTool).toHaveBeenCalledTimes(2);
    expect(state.size).toBe(2);
  });
});
