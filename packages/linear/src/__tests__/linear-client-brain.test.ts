const rawRequest = vi.hoisted(() => vi.fn());

vi.mock('@linear/sdk', () => ({
  AgentActivitySignal: { Select: 'select', Auth: 'auth' },
  LinearClient: class {
    client = { rawRequest };
  },
}));

import { createLinearClient } from '../linear-client';

describe('LinearClient.listIssuesForBrain', () => {
  it('normalizes a bounded issue page and comment authors', async () => {
    rawRequest.mockResolvedValue({
      data: {
        issues: {
          nodes: [
            {
              id: 'issue-1',
              identifier: 'ENG-1',
              title: 'Collect Linear issues',
              description: null,
              url: 'https://linear.app/acme/issue/ENG-1',
              estimate: 3,
              createdAt: '2026-08-01T00:00:00.000Z',
              updatedAt: '2026-08-02T00:00:00.000Z',
              startedAt: '2026-08-01T12:00:00.000Z',
              cycle: { name: 'August', number: 12 },
              team: { key: 'ENG', name: 'Engineering', private: false },
              parent: {
                id: 'parent-1',
                identifier: 'ENG-0',
                title: 'Brain ingestion',
              },
              labels: { nodes: [{ name: 'memory' }, { name: 'brain' }] },
              relations: {
                nodes: [
                  {
                    type: 'blocks',
                    relatedIssue: {
                      id: 'issue-2',
                      identifier: 'ENG-2',
                      title: 'Search Linear issues',
                    },
                  },
                ],
                pageInfo: { hasNextPage: true },
              },
              inverseRelations: {
                nodes: [
                  {
                    type: 'duplicate',
                    issue: {
                      id: 'issue-3',
                      identifier: 'ENG-3',
                      title: 'Index Linear issues',
                    },
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
              comments: {
                nodes: [
                  {
                    id: 'comment-1',
                    body: 'Use the existing OAuth connection.',
                    createdAt: '2026-08-01T01:00:00.000Z',
                    updatedAt: '2026-08-01T01:00:00.000Z',
                    externalUser: { name: 'External author' },
                  },
                ],
              },
            },
          ],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
        },
      },
    });

    const result = await createLinearClient('token').listIssuesForBrain({
      first: 500,
      after: 'cursor-1',
      updatedAfter: '2026-08-01T00:00:00.000Z',
      updatedBefore: '2026-08-03T00:00:00.000Z',
    });

    expect(rawRequest).toHaveBeenCalledWith(
      expect.stringContaining('comments(last: 20'),
      {
        first: 100,
        after: 'cursor-1',
        filter: {
          team: { private: { eq: false } },
          updatedAt: {
            gte: '2026-08-01T00:00:00.000Z',
            lte: '2026-08-03T00:00:00.000Z',
          },
        },
      },
    );
    expect(result).toEqual({
      issues: [
        expect.objectContaining({
          id: 'issue-1',
          estimate: 3,
          startedAt: '2026-08-01T12:00:00.000Z',
          cycle: { name: 'August', number: 12 },
          parent: expect.objectContaining({ identifier: 'ENG-0' }),
          labels: ['brain', 'memory'],
          relationships: [
            expect.objectContaining({
              type: 'blocks',
              direction: 'outbound',
            }),
            expect.objectContaining({
              type: 'duplicate',
              direction: 'inbound',
            }),
          ],
          relationshipsTruncated: true,
          comments: [expect.objectContaining({ author: 'External author' })],
        }),
      ],
      pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
    });
    expect(rawRequest.mock.calls[0]?.[0]).toContain(
      'team { key name private }',
    );
  });

  it('drops private-team issues even if Linear returns one', async () => {
    rawRequest.mockResolvedValue({
      data: {
        issues: {
          nodes: [
            {
              id: 'private-issue',
              identifier: 'SEC-1',
              title: 'Private incident',
              url: 'https://linear.app/acme/issue/SEC-1',
              createdAt: '2026-08-01T00:00:00.000Z',
              updatedAt: '2026-08-02T00:00:00.000Z',
              team: { key: 'SEC', name: 'Security', private: true },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });

    const result = await createLinearClient('token').listIssuesForBrain({
      first: 50,
    });

    expect(result.issues).toEqual([]);
    expect(rawRequest).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        filter: { team: { private: { eq: false } } },
      }),
    );
  });

  it('supports stable creation-time pagination for visibility censuses', async () => {
    rawRequest.mockResolvedValue({
      data: {
        issues: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });

    await createLinearClient('token').listIssuesForBrain({
      first: 50,
      orderBy: 'createdAt',
      createdBefore: '2026-08-20T12:00:00.000Z',
    });

    expect(rawRequest).toHaveBeenCalledWith(
      expect.stringContaining('orderBy: createdAt'),
      expect.objectContaining({
        filter: {
          createdAt: { lte: '2026-08-20T12:00:00.000Z' },
          team: { private: { eq: false } },
        },
      }),
    );
  });
});
