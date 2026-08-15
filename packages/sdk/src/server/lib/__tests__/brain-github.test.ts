const githubMocks = vi.hoisted(() => ({
  repositories: [] as Array<{ fullName: string; installationId: number }>,
  syncState: new Map<string, { watermark: Date | null }>(),
  listForRepo: vi.fn(),
  listComments: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            orderBy: async () => githubMocks.repositories,
          }),
        }),
      }),
    }),
  },
  and: vi.fn(),
  asc: vi.fn(),
  eq: vi.fn(),
  getBrainSyncState: vi.fn(async (_db: unknown, collectorId: string) => {
    const state = githubMocks.syncState.get(collectorId);
    return state ? { ...state, collectorId } : null;
  }),
  isNotNull: vi.fn(),
  isNull: vi.fn(),
  githubInstallations: {},
  repositories: {},
}));

vi.mock('@roomote/github', () => ({
  getInstallationOctokit: vi.fn(async () => ({
    rest: {
      issues: {
        listForRepo: githubMocks.listForRepo,
        listComments: githubMocks.listComments,
      },
    },
  })),
}));

import {
  backfillBrainGithubIssuesStep,
  buildGithubIssuePage,
  collectBrainGithubIssues,
} from '../brain-github';

const issue = {
  number: 42,
  title: 'Sandbox boots without the preview proxy',
  body: 'Steps to reproduce: launch a task with previews enabled.',
  state: 'closed',
  html_url: 'https://github.com/acme/widgets/issues/42',
  comments: 2,
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-03T12:00:00Z',
  closed_at: '2026-08-03T12:00:00Z',
  user: { login: 'ada' },
  labels: ['bug', { name: 'previews' }],
};

describe('buildGithubIssuePage', () => {
  it('maps an issue with discussion into a slugged page', () => {
    const page = buildGithubIssuePage({
      fullName: 'acme/widgets',
      issue,
      comments: [
        {
          author: 'grace',
          body: 'Reproduced on the docker provider.',
          createdAt: '2026-08-02T09:00:00Z',
        },
      ],
    });

    expect(page?.slug).toBe('github/acme/widgets/issues/42');
    expect(page?.title).toBe(
      'acme/widgets#42: Sandbox boots without the preview proxy',
    );
    expect(page?.content).toContain('repository: acme/widgets');
    expect(page?.content).toContain('state: closed');
    expect(page?.content).toContain('labels: bug, previews');
    expect(page?.content).toContain('author: ada');
    expect(page?.content).toContain('provenance: roomote-github-issues');
    expect(page?.content).toContain('Steps to reproduce');
    expect(page?.content).toContain('## Discussion');
    expect(page?.content).toContain('**grace**');
    expect(page?.content).toContain('Reproduced on the docker provider.');
    expect(page?.content).toContain(
      'https://github.com/acme/widgets/issues/42',
    );
  });

  it('omits the discussion section when there are no comments', () => {
    const page = buildGithubIssuePage({
      fullName: 'acme/widgets',
      issue: { ...issue, comments: 0 },
      comments: [],
    });

    expect(page?.content).not.toContain('## Discussion');
  });

  it('caps long bodies and comment bodies', () => {
    const page = buildGithubIssuePage({
      fullName: 'acme/widgets',
      issue: { ...issue, body: 'x'.repeat(9000) },
      comments: [
        { author: 'ada', body: 'y'.repeat(9000), createdAt: '2026-08-02' },
      ],
    });

    expect(page?.content).toContain('x'.repeat(4000));
    expect(page?.content).not.toContain('x'.repeat(4001));
    expect(page?.content).toContain('y'.repeat(600));
    expect(page?.content).not.toContain('y'.repeat(601));
  });

  it('returns null for unusable payloads', () => {
    expect(
      buildGithubIssuePage({
        fullName: 'acme/widgets',
        issue: { number: 1, title: '' },
        comments: [],
      }),
    ).toBeNull();
  });
});

describe('GitHub issue collector progress', () => {
  beforeEach(() => {
    githubMocks.repositories = [];
    githubMocks.syncState.clear();
    githubMocks.listForRepo.mockReset();
    githubMocks.listComments.mockReset().mockResolvedValue({ data: [] });
  });

  const makeIssue = (number: number, updatedAt: string) => ({
    number,
    title: `Issue ${number}`,
    updated_at: updatedAt,
    comments: 0,
  });

  it('lets a later repository run before an earlier repository advances again', async () => {
    const start = new Date('2026-08-01T00:00:00Z');
    const now = new Date('2026-08-15T00:00:00Z');
    githubMocks.repositories = [
      { fullName: 'acme/a', installationId: 1 },
      { fullName: 'acme/b', installationId: 2 },
    ];
    githubMocks.syncState.set('github-issues:acme/a', { watermark: start });
    githubMocks.syncState.set('github-issues:acme/b', { watermark: start });
    githubMocks.listForRepo.mockImplementation(
      async ({ repo, per_page }: { repo: string; per_page: number }) => ({
        data: (repo === 'a'
          ? Array.from({ length: 100 }, (_, index) =>
              makeIssue(
                index + 1,
                new Date(start.getTime() + (index + 1) * 60_000).toISOString(),
              ),
            )
          : [makeIssue(500, '2026-08-01T00:30:00Z')]
        ).slice(0, per_page),
      }),
    );

    const first = await collectBrainGithubIssues({ now, limit: 100 });
    expect(first.pages).toHaveLength(100);
    expect(first.stateUpdates.map((update) => update.collectorId)).toEqual([
      'github-issues:acme/a',
    ]);
    for (const update of first.stateUpdates) {
      githubMocks.syncState.set(update.collectorId, {
        watermark: update.watermark,
      });
    }

    const second = await collectBrainGithubIssues({ now, limit: 100 });
    expect(second.pages).toHaveLength(100);
    expect(second.pages[0]?.slug).toBe('github/acme/b/issues/500');
    expect(githubMocks.listForRepo.mock.calls[1]?.[0]).toMatchObject({
      repo: 'b',
      since: start.toISOString(),
    });
  });

  it('backfills a repository connected after the earlier set completed', async () => {
    githubMocks.repositories = [{ fullName: 'acme/a', installationId: 1 }];
    githubMocks.listForRepo.mockResolvedValueOnce({ data: [] });

    const first = await backfillBrainGithubIssuesStep({ cursor: null });
    expect(first.done).toBe(false);
    expect(first.nextCursor).toContain('acme/a');

    githubMocks.repositories.push({ fullName: 'acme/b', installationId: 2 });
    githubMocks.listForRepo.mockResolvedValueOnce({
      data: [makeIssue(7, '2026-07-01T00:00:00Z')],
    });

    const second = await backfillBrainGithubIssuesStep({
      cursor: first.nextCursor,
    });
    expect(second.pages[0]?.slug).toBe('github/acme/b/issues/7');
    expect(second.done).toBe(false);
  });
});
