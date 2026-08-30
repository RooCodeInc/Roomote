const mocks = vi.hoisted(() => ({
  syncState: new Map<
    string,
    {
      watermark?: Date | null;
      backfillCursor?: string | null;
      backfillCompletedAt?: Date | null;
    }
  >(),
  staleItems: [] as Array<{ itemId: string; slug: string }>,
  listIssues: vi.fn(),
  findConnection: vi.fn(),
  getValidAccessToken: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  getBrainSyncState: vi.fn(async (_db: unknown, collectorId: string) =>
    mocks.syncState.has(collectorId)
      ? { collectorId, ...mocks.syncState.get(collectorId) }
      : null,
  ),
  listBrainCollectorItemsBefore: vi.fn(async () => mocks.staleItems),
}));

vi.mock('@roomote/linear', () => ({
  createLinearClient: vi.fn(() => ({
    listIssuesForBrain: mocks.listIssues,
  })),
}));

vi.mock('../mcp/data', () => ({
  getValidAccessToken: mocks.getValidAccessToken,
}));

vi.mock('../mcp/linear-connections', () => ({
  findLinearDeploymentMcpConnection: mocks.findConnection,
  getLinearDeploymentMetadata: (config: Record<string, unknown> | null) =>
    typeof config?.linearOrganizationId === 'string'
      ? {
          linearOrganizationId: config.linearOrganizationId,
          linearOrganizationName: config.linearOrganizationName ?? null,
        }
      : null,
}));

import {
  backfillBrainLinearIssuesStep,
  buildLinearIssuePage,
  collectBrainLinearIssues,
} from '../brain-linear';

const issue = {
  id: 'Issue-UUID',
  identifier: 'ENG-42',
  title: 'Keep preview sessions alive',
  description: 'A preview should remain reachable while a task is active.',
  url: 'https://linear.app/acme/issue/ENG-42',
  priority: 2,
  priorityLabel: 'High',
  estimate: 3,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-03T12:00:00.000Z',
  startedAt: '2026-08-02T08:00:00.000Z',
  completedAt: '2026-08-03T12:00:00.000Z',
  canceledAt: null,
  archivedAt: null,
  dueDate: '2026-08-10',
  state: { name: 'Done', type: 'completed' },
  team: { key: 'ENG', name: 'Engineering' },
  project: { name: 'Previews' },
  cycle: { name: 'August', number: 12 },
  parent: {
    id: 'parent-uuid',
    identifier: 'ENG-40',
    title: 'Preview reliability',
  },
  creator: { name: 'Ada' },
  assignee: { name: 'Grace' },
  labels: ['bug', 'customer'],
  relationships: [
    {
      type: 'related',
      direction: 'outbound' as const,
      issue: {
        id: 'related-z',
        identifier: 'ENG-44',
        title: 'Track preview health',
      },
    },
    {
      type: 'blocks',
      direction: 'inbound' as const,
      issue: {
        id: 'related-a',
        identifier: 'ENG-41',
        title: 'Renew preview leases',
      },
    },
    {
      type: 'related',
      direction: 'inbound' as const,
      issue: {
        id: 'related-b',
        identifier: 'ENG-43',
        title: 'Report preview status',
      },
    },
  ],
  relationshipsTruncated: true,
  comments: [
    {
      id: 'comment-1',
      body: 'The controller must renew the lease.',
      createdAt: '2026-08-02T09:00:00.000Z',
      updatedAt: '2026-08-02T09:00:00.000Z',
      author: 'Linus',
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.syncState.clear();
  mocks.staleItems = [];
  mocks.findConnection.mockResolvedValue({
    id: 'connection-1',
    authConfig: {
      linearOrganizationId: 'Org-UUID',
      linearOrganizationName: 'Acme',
    },
  });
  mocks.getValidAccessToken.mockResolvedValue('access-token');
});

describe('buildLinearIssuePage', () => {
  it('builds a stable canonical issue page without email metadata', () => {
    const page = buildLinearIssuePage({
      organizationId: 'Org-UUID',
      organizationName: 'Acme',
      issue,
    });

    expect(page?.slug).toBe('linear/org-uuid/issues/issue-uuid');
    expect(page?.title).toBe('ENG-42: Keep preview sessions alive');
    expect(page?.content).toContain('type: linear-issue');
    expect(page?.content).toContain('event_date: 2026-08-03');
    expect(page?.content).toContain('team: "Engineering"');
    expect(page?.content).toContain('project: "Previews"');
    expect(page?.content).toContain('state: "Done"');
    expect(page?.content).not.toContain('**Status**');
    expect(page?.content).not.toContain('**Priority**');
    expect(page?.content).not.toContain('**Assignee**');
    expect(page?.content).toContain(
      '## Metadata\n\n- **Started**: 2026-08-02T08:00:00.000Z\n- **Estimate**: 3\n- **Cycle**: August (#12)\n- **Parent**: [ENG-40: Preview reliability](linear/org-uuid/issues/parent-uuid)\n- **Blocked by**: [ENG-41: Renew preview leases](linear/org-uuid/issues/related-a)\n- **Related issues**: [ENG-43: Report preview status](linear/org-uuid/issues/related-b), [ENG-44: Track preview health](linear/org-uuid/issues/related-z)\n_Linear truncated the relationship list; open the source issue for the rest._',
    );
    expect(page?.content).toContain('## Discussion');
    expect(page?.content).toContain('The controller must renew the lease.');
    expect(page?.content).toContain('provenance: roomote-linear-issues');
    expect(page?.content).not.toContain('@');
  });

  it('omits metadata when the issue has no additional values', () => {
    const page = buildLinearIssuePage({
      organizationId: 'org',
      organizationName: null,
      issue: {
        ...issue,
        estimate: null,
        startedAt: null,
        cycle: null,
        parent: null,
        relationships: [],
        relationshipsTruncated: false,
      },
    });

    expect(page?.content).not.toContain('## Metadata');
  });

  it('bounds issue and comment text', () => {
    const page = buildLinearIssuePage({
      organizationId: 'org',
      organizationName: null,
      issue: {
        ...issue,
        description: 'x'.repeat(9_000),
        comments: [{ ...issue.comments[0]!, body: 'y'.repeat(2_000) }],
      },
    });

    expect(page?.content).toContain('x'.repeat(8_000));
    expect(page?.content).not.toContain('x'.repeat(8_001));
    expect(page?.content).toContain('y'.repeat(800));
    expect(page?.content).not.toContain('y'.repeat(801));
  });
});

describe('Linear issue collection', () => {
  it('persists the upstream cursor inside a frozen incremental window', async () => {
    mocks.listIssues.mockResolvedValue({
      issues: [issue],
      pageInfo: { hasNextPage: true, endCursor: 'next-page' },
    });
    const now = new Date('2026-08-20T12:00:00.000Z');

    const result = await collectBrainLinearIssues({ now, limit: 25 });

    expect(result.pages).toHaveLength(1);
    expect(result.itemUpdates).toEqual([
      expect.objectContaining({
        collectorId: 'linear-issues:entity-census-v1',
        itemId: 'Issue-UUID',
      }),
    ]);
    expect(mocks.listIssues).toHaveBeenCalledWith({
      first: 25,
      after: undefined,
      updatedAfter: '2026-07-21T12:00:00.000Z',
      updatedBefore: '2026-08-20T11:59:59.000Z',
    });
    const cursor = JSON.parse(result.stateUpdates[0]!.cursor!);
    expect(cursor).toEqual({
      after: 'next-page',
      lowerBound: '2026-07-21T12:00:00.000Z',
      upperBound: '2026-08-20T11:59:59.000Z',
    });
  });

  it('advances the watermark only when the frozen window is exhausted', async () => {
    mocks.listIssues.mockResolvedValue({
      issues: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    const now = new Date('2026-08-20T12:00:00.000Z');

    const result = await collectBrainLinearIssues({ now, limit: 100 });

    expect(result.stateUpdates[0]).toEqual({
      collectorId: 'linear-issues:entity-census-v1:incremental',
      watermark: new Date('2026-08-20T11:59:59.000Z'),
      cursor: null,
    });
  });

  it('re-arms a completed census after one day', async () => {
    mocks.syncState.set('linear-issues:entity-census-v1', {
      backfillCompletedAt: new Date('2026-08-19T11:00:00.000Z'),
    });
    mocks.listIssues.mockResolvedValue({
      issues: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    const result = await collectBrainLinearIssues({
      now: new Date('2026-08-20T12:00:00.000Z'),
      limit: 100,
    });

    expect(result.stateUpdates).toContainEqual({
      collectorId: 'linear-issues:entity-census-v1',
      cursor: null,
      backfillCompletedAt: null,
    });
  });

  it('holds all progress when Linear fails', async () => {
    mocks.listIssues.mockRejectedValue(new Error('Linear unavailable'));

    await expect(
      collectBrainLinearIssues({
        now: new Date('2026-08-20T12:00:00.000Z'),
        limit: 100,
      }),
    ).resolves.toEqual({
      pages: [],
      nextSince: null,
      stateUpdates: [],
      itemUpdates: [],
    });
  });
});

describe('Linear issue census', () => {
  it('keeps an issue updated during a creation-ordered census visible', async () => {
    mocks.listIssues.mockResolvedValue({
      issues: [{ ...issue, updatedAt: '2026-08-21T12:00:00.000Z' }],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    const result = await backfillBrainLinearIssuesStep({
      cursor: null,
      limit: 100,
      now: new Date('2026-08-20T12:00:00.000Z'),
    });

    expect(result.done).toBe(false);
    expect(result.pages).toHaveLength(1);
    expect(result.itemUpdates).toHaveLength(1);
    expect(mocks.listIssues).toHaveBeenCalledWith({
      first: 50,
      after: null,
      orderBy: 'createdAt',
      createdBefore: '2026-08-20T12:00:00.000Z',
    });
    expect(JSON.parse(result.nextCursor!)).toEqual({
      phase: 'retire',
      sweepStartedAt: '2026-08-20T12:00:00.000Z',
    });
  });

  it('retires only inventory unseen by a completed census', async () => {
    mocks.staleItems = [
      { itemId: 'deleted-issue', slug: 'linear/org/issues/deleted-issue' },
    ];
    const cursor = JSON.stringify({
      phase: 'retire',
      sweepStartedAt: '2026-08-20T12:00:00.000Z',
    });

    const retirement = await backfillBrainLinearIssuesStep({
      cursor,
      limit: 100,
    });
    expect(retirement).toMatchObject({
      pages: [],
      done: false,
      pageRetirements: [
        {
          collectorId: 'linear-issues:entity-census-v1',
          itemId: 'deleted-issue',
          slug: 'linear/org/issues/deleted-issue',
        },
      ],
    });

    mocks.staleItems = [];
    await expect(
      backfillBrainLinearIssuesStep({ cursor, limit: 100 }),
    ).resolves.toMatchObject({ pages: [], done: true });
  });
});
