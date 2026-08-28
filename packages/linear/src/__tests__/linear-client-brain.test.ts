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
              createdAt: '2026-08-01T00:00:00.000Z',
              updatedAt: '2026-08-02T00:00:00.000Z',
              labels: { nodes: [{ name: 'brain' }] },
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
          labels: ['brain'],
          comments: [expect.objectContaining({ author: 'External author' })],
        }),
      ],
      pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
    });
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
        },
      }),
    );
  });
});
