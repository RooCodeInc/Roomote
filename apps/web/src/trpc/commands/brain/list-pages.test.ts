import type { BrainCorpusSnapshot } from '@roomote/sdk/server';

import { paginateBrainCorpus } from './index';

function snapshot(): BrainCorpusSnapshot {
  return {
    pages: [
      {
        slug: 'tasks/run-2',
        title: 'Fixed the drainer',
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
      {
        slug: 'slack/channel/day-1',
        title: 'Support notes',
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        slug: 'tasks/run-1',
        title: 'Investigated support issue',
        updatedAt: new Date('2025-12-31T00:00:00Z'),
      },
    ],
  };
}

describe('paginateBrainCorpus', () => {
  it('searches titles and slugs across the full snapshot', () => {
    const result = paginateBrainCorpus(snapshot(), {
      search: 'support',
      offset: 0,
      limit: 100,
    });

    expect(result.total).toBe(2);
    expect(result.pages.map((page) => page.slug)).toEqual([
      'slack/channel/day-1',
      'tasks/run-1',
    ]);
  });

  it('filters namespaces before paginating', () => {
    const result = paginateBrainCorpus(snapshot(), {
      namespaceId: 'tasks',
      offset: 1,
      limit: 1,
    });

    expect(result.total).toBe(2);
    expect(result.pages[0]?.slug).toBe('tasks/run-1');
    expect(result.nextOffset).toBeNull();
  });

  it('returns a continuation offset for bounded pages', () => {
    const result = paginateBrainCorpus(snapshot(), { offset: 0, limit: 2 });

    expect(result.pages).toHaveLength(2);
    expect(result.total).toBe(3);
    expect(result.nextOffset).toBe(2);
  });
});
