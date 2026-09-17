const { mockScoreTypeSafeRelevance } = vi.hoisted(() => ({
  mockScoreTypeSafeRelevance: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server/typesafe-judgment', () => ({
  scoreTypeSafeRelevance: mockScoreTypeSafeRelevance,
}));

import { rerankBrainQueryResult } from '../gbrain-rerank';

type Passage = { slug: string; title: string; chunk_text: string };

function passages(count: number): Passage[] {
  return Array.from({ length: count }, (_, index) => ({
    slug: `page-${index}`,
    title: `Page ${index}`,
    chunk_text: `Passage ${index}`,
  }));
}

function queryResult(items: unknown[]) {
  return {
    content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
    _meta: { retrieval: { mode: 'hybrid' } },
  };
}

function scoresFor(probabilities: number[]): Map<string, number> {
  return new Map(probabilities.map((p, index) => [String(index), p]));
}

function slugsOf(result: unknown): string[] {
  const { content } = result as { content: Array<{ text: string }> };
  return (JSON.parse(content[0]!.text) as Passage[]).map((item) => item.slug);
}

describe('rerankBrainQueryResult', () => {
  beforeEach(() => {
    mockScoreTypeSafeRelevance.mockReset();
    mockScoreTypeSafeRelevance.mockResolvedValue(null);
  });

  it('passes results through when no judgment model is configured', async () => {
    const result = await rerankBrainQueryResult({
      toolName: 'query',
      arguments: { query: 'billing sync' },
      result: queryResult(passages(3)),
    });

    expect(result).toBeUndefined();
    expect(mockScoreTypeSafeRelevance).toHaveBeenCalledTimes(1);
  });

  it('moves confidently relevant passages up and irrelevant ones down, keeping gbrain order otherwise', async () => {
    mockScoreTypeSafeRelevance.mockResolvedValue(
      scoresFor([0.05, 0.5, 0.95, 0.4, 0.85, 0.1]),
    );

    const original = queryResult(passages(6));
    const result = await rerankBrainQueryResult({
      toolName: 'query',
      arguments: { query: 'why did billing switch to polling?' },
      result: original,
    });

    expect(slugsOf(result)).toEqual([
      'page-2',
      'page-4',
      'page-1',
      'page-3',
      'page-0',
      'page-5',
    ]);
    // Items are moved, never edited, so citations stay intact.
    const reordered = JSON.parse(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as Passage[];
    expect(reordered).toEqual(
      expect.arrayContaining(JSON.parse(original.content[0]!.text)),
    );
    expect((result as { _meta: unknown })._meta).toEqual(original._meta);
  });

  it('keeps gbrain order when every judgment is unsure', async () => {
    mockScoreTypeSafeRelevance.mockResolvedValue(scoresFor([0.3, 0.6, 0.7]));

    const result = await rerankBrainQueryResult({
      toolName: 'query',
      arguments: { query: 'release owner' },
      result: queryResult(passages(3)),
    });

    expect(result).toBeUndefined();
  });

  it('keeps gbrain order when the judgment fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockScoreTypeSafeRelevance.mockRejectedValue(new Error('HTTP 503'));

    const result = await rerankBrainQueryResult({
      toolName: 'query',
      arguments: { query: 'release owner' },
      result: queryResult(passages(3)),
    });

    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[Brain Rerank]'),
    );
    warn.mockRestore();
  });

  it.each([
    ['another tool', 'search', { query: 'x' }, queryResult(passages(3))],
    ['a missing query', 'query', {}, queryResult(passages(3))],
    ['a single passage', 'query', { query: 'x' }, queryResult(passages(1))],
    [
      'an error result',
      'query',
      { query: 'x' },
      { ...queryResult(passages(3)), isError: true },
    ],
    [
      'a non-array body',
      'query',
      { query: 'x' },
      { content: [{ type: 'text', text: '{"error":"nope"}' }] },
    ],
  ])('does not judge %s', async (_label, toolName, args, result) => {
    await expect(
      rerankBrainQueryResult({ toolName, arguments: args, result }),
    ).resolves.toBeUndefined();
    expect(mockScoreTypeSafeRelevance).not.toHaveBeenCalled();
  });

  it('judges only the head of a long page, with bounded passage text', async () => {
    const items = passages(45).map((item) => ({
      ...item,
      chunk_text: 'x'.repeat(5_000),
    }));
    mockScoreTypeSafeRelevance.mockResolvedValue(new Map([['39', 0.9]]));

    const result = await rerankBrainQueryResult({
      toolName: 'query',
      arguments: { query: 'q' },
      result: queryResult(items),
    });

    const call = mockScoreTypeSafeRelevance.mock.calls[0]![0] as {
      query: string;
      candidates: Array<{ id: string; text: string }>;
    };
    expect(call.query).toBe('q');
    expect(call.candidates).toHaveLength(40);
    expect(
      call.candidates.every((candidate) => candidate.text.length <= 1_401),
    ).toBe(true);
    expect(call.candidates[0]!.text.startsWith('Title: Page 0')).toBe(true);

    const slugs = slugsOf(result);
    expect(slugs[0]).toBe('page-39');
    expect(slugs.slice(40)).toEqual([
      'page-40',
      'page-41',
      'page-42',
      'page-43',
      'page-44',
    ]);
  });
});
