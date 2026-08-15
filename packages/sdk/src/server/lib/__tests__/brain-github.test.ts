const githubMocks = vi.hoisted(() => ({
  repositories: [] as Array<{ fullName: string; installationId: number }>,
  syncState: new Map<
    string,
    { watermark: Date | null; backfillCursor?: string | null }
  >(),
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
      async ({
        repo,
        page = 1,
        per_page,
      }: {
        repo: string;
        page?: number;
        per_page: number;
      }) => {
        const issues =
          repo === 'a'
            ? Array.from({ length: 100 }, (_, index) =>
                makeIssue(
                  index + 1,
                  new Date(
                    start.getTime() + (index + 1) * 60_000,
                  ).toISOString(),
                ),
              )
            : [makeIssue(500, '2026-08-01T00:30:00Z')];
        const offset = (page - 1) * per_page;

        return { data: issues.slice(offset, offset + per_page) };
      },
    );

    const first = await collectBrainGithubIssues({ now, limit: 100 });
    expect(first.pages).toHaveLength(100);
    expect(first.stateUpdates.map((update) => update.collectorId)).toEqual([
      'github-issues:acme/a',
    ]);
    for (const update of first.stateUpdates) {
      githubMocks.syncState.set(update.collectorId, {
        watermark: update.watermark,
        backfillCursor: update.cursor,
      });
    }

    const second = await collectBrainGithubIssues({ now, limit: 100 });
    expect(second.pages).toHaveLength(1);
    expect(second.pages[0]?.slug).toBe('github/acme/b/issues/500');
    expect(githubMocks.listForRepo.mock.calls[1]?.[0]).toMatchObject({
      repo: 'b',
      since: start.toISOString(),
    });
  });

  it('resumes a full page without skipping issues tied at its boundary', async () => {
    const start = new Date('2026-08-01T00:00:00Z');
    const tiedAt = '2026-08-02T00:00:00Z';
    const now = new Date('2026-08-15T00:00:00Z');
    githubMocks.repositories = [{ fullName: 'acme/a', installationId: 1 }];
    githubMocks.syncState.set('github-issues:acme/a', { watermark: start });
    githubMocks.listForRepo.mockImplementation(
      async ({ page = 1 }: { page?: number }) => ({
        data:
          page === 1
            ? Array.from({ length: 100 }, (_, index) =>
                makeIssue(index + 1, tiedAt),
              )
            : [makeIssue(101, tiedAt)],
      }),
    );

    const first = await collectBrainGithubIssues({ now, limit: 100 });
    expect(first.stateUpdates[0]).toMatchObject({
      collectorId: 'github-issues:acme/a',
      watermark: new Date(tiedAt),
    });
    const firstCursor = JSON.parse(first.stateUpdates[0]!.cursor!) as {
      boundary: string;
      seen: Array<[number, string]>;
    };
    expect(firstCursor.boundary).toBe(new Date(tiedAt).toISOString());
    expect(firstCursor.seen.map(([number]) => number)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    githubMocks.syncState.set('github-issues:acme/a', {
      watermark: first.stateUpdates[0]!.watermark,
      backfillCursor: first.stateUpdates[0]!.cursor,
    });

    const second = await collectBrainGithubIssues({ now, limit: 100 });
    expect(second.pages.map((page) => page.slug)).toEqual([
      'github/acme/a/issues/101',
    ]);
    expect(githubMocks.listForRepo.mock.calls[1]?.[0]).toMatchObject({
      since: '2026-08-01T23:59:59.999Z',
      page: 1,
    });
    expect(githubMocks.listForRepo.mock.calls[2]?.[0]).toMatchObject({
      page: 2,
    });
    expect(second.stateUpdates[0]).toMatchObject({
      collectorId: 'github-issues:acme/a',
      watermark: new Date(now.getTime() - 1000),
    });
    expect(second.stateUpdates[0]?.cursor).not.toBeNull();
  });

  it('replays the keyset boundary when an earlier issue moves between ticks', async () => {
    const start = new Date('2026-08-01T00:00:00Z');
    const now = new Date('2026-08-15T00:00:00Z');
    const issueTimes = Array.from({ length: 101 }, (_, index) =>
      new Date(start.getTime() + (index + 1) * 60_000).toISOString(),
    );
    githubMocks.repositories = [{ fullName: 'acme/a', installationId: 1 }];
    githubMocks.syncState.set('github-issues:acme/a', { watermark: start });
    githubMocks.listForRepo
      .mockResolvedValueOnce({
        data: Array.from({ length: 100 }, (_, index) =>
          makeIssue(index + 1, issueTimes[index]!),
        ),
      })
      .mockResolvedValueOnce({
        data: [
          makeIssue(100, issueTimes[99]!),
          makeIssue(101, issueTimes[100]!),
          makeIssue(1, '2026-08-03T00:00:00Z'),
        ],
      })
      .mockResolvedValueOnce({
        data: [makeIssue(1, '2026-08-03T00:00:00Z')],
      });

    const first = await collectBrainGithubIssues({ now, limit: 100 });
    githubMocks.syncState.set('github-issues:acme/a', {
      watermark: first.stateUpdates[0]!.watermark,
      backfillCursor: first.stateUpdates[0]!.cursor,
    });

    const second = await collectBrainGithubIssues({ now, limit: 100 });
    expect(second.pages.map((page) => page.slug)).toEqual([
      'github/acme/a/issues/101',
      'github/acme/a/issues/1',
    ]);
    expect(githubMocks.listForRepo.mock.calls[1]?.[0]).toMatchObject({
      since: new Date(new Date(issueTimes[99]!).getTime() - 1).toISOString(),
      page: 1,
    });
  });

  it('keeps the keyset when a local offset scan misses a shifted issue', async () => {
    const start = new Date('2026-08-01T00:00:00Z');
    const tiedAt = '2026-08-02T00:00:00Z';
    const now = new Date('2026-08-15T00:00:00Z');
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      makeIssue(index + 1, tiedAt),
    );
    const shiftedPage = Array.from({ length: 100 }, (_, index) =>
      makeIssue(index + 2, tiedAt),
    );
    githubMocks.repositories = [{ fullName: 'acme/a', installationId: 1 }];
    githubMocks.syncState.set('github-issues:acme/a', { watermark: start });
    githubMocks.listForRepo
      .mockResolvedValueOnce({ data: firstPage })
      // The mutation occurs after this replay: issue 101 shifts into page 1,
      // while the now-short page 2 incorrectly looks exhausted.
      .mockResolvedValueOnce({ data: firstPage })
      .mockResolvedValueOnce({ data: [] })
      // The durable keyset makes the next tick restart at page 1 and find it.
      .mockResolvedValueOnce({ data: shiftedPage })
      .mockResolvedValueOnce({ data: shiftedPage })
      .mockResolvedValueOnce({ data: [] });

    const first = await collectBrainGithubIssues({ now, limit: 100 });
    githubMocks.syncState.set('github-issues:acme/a', {
      watermark: first.stateUpdates[0]!.watermark,
      backfillCursor: first.stateUpdates[0]!.cursor,
    });

    const missed = await collectBrainGithubIssues({ now, limit: 100 });
    expect(missed.pages).toEqual([]);
    expect(missed.stateUpdates[0]?.cursor).not.toBeNull();
    githubMocks.syncState.set('github-issues:acme/a', {
      watermark: missed.stateUpdates[0]!.watermark,
      backfillCursor: missed.stateUpdates[0]!.cursor,
    });

    const recovered = await collectBrainGithubIssues({ now, limit: 100 });
    expect(recovered.pages.map((page) => page.slug)).toEqual([
      'github/acme/a/issues/101',
    ]);
  });

  it('reprocesses a tied issue when its visible revision changes', async () => {
    const boundary = new Date('2026-08-02T12:00:00Z');
    const now = new Date('2026-08-15T00:00:00Z');
    const original = makeIssue(7, boundary.toISOString());
    const changed = { ...original, comments: 1 };
    githubMocks.repositories = [{ fullName: 'acme/a', installationId: 1 }];
    githubMocks.syncState.set('github-issues:acme/a', {
      watermark: boundary,
      backfillCursor: JSON.stringify({
        boundary: boundary.toISOString(),
        seen: [
          [
            7,
            JSON.stringify([
              original.updated_at,
              original.title,
              undefined,
              undefined,
              original.comments,
              undefined,
              undefined,
              [],
            ]),
          ],
        ],
      }),
    });
    githubMocks.listForRepo
      .mockResolvedValueOnce({ data: [changed] })
      .mockResolvedValueOnce({ data: [changed] });

    const result = await collectBrainGithubIssues({ now, limit: 100 });
    expect(result.pages.map((page) => page.slug)).toEqual([
      'github/acme/a/issues/7',
    ]);
    expect(result.stateUpdates[0]).toMatchObject({
      collectorId: 'github-issues:acme/a',
      watermark: new Date(now.getTime() - 1000),
    });
    expect(result.stateUpdates[0]?.cursor).not.toBeNull();
  });

  it('reprocesses a tied issue when an existing comment is edited', async () => {
    const boundary = new Date('2026-08-02T12:00:00Z');
    const now = new Date('2026-08-15T00:00:00Z');
    const tiedIssue = { ...makeIssue(7, boundary.toISOString()), comments: 1 };
    const oldComments = [
      {
        author: 'ada',
        body: 'Original comment',
        createdAt: '2026-08-02T12:00:00Z',
      },
    ];
    const issueFingerprint = JSON.stringify([
      tiedIssue.updated_at,
      tiedIssue.title,
      undefined,
      undefined,
      tiedIssue.comments,
      undefined,
      undefined,
      [],
    ]);
    githubMocks.repositories = [{ fullName: 'acme/a', installationId: 1 }];
    githubMocks.syncState.set('github-issues:acme/a', {
      watermark: boundary,
      backfillCursor: JSON.stringify({
        boundary: boundary.toISOString(),
        seen: [[7, JSON.stringify([issueFingerprint, oldComments])]],
      }),
    });
    githubMocks.listForRepo
      .mockResolvedValueOnce({ data: [tiedIssue] })
      .mockResolvedValueOnce({ data: [tiedIssue] });
    githubMocks.listComments.mockResolvedValue({
      data: [
        {
          user: { login: 'ada' },
          body: 'Edited comment',
          created_at: '2026-08-02T12:00:00Z',
        },
      ],
    });

    const result = await collectBrainGithubIssues({ now, limit: 100 });
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.content).toContain('Edited comment');
    expect(result.pages[0]?.content).not.toContain('Original comment');
    expect(githubMocks.listComments).toHaveBeenCalledTimes(1);
  });

  it('bounds tied comment revision probes and rotates the next batch', async () => {
    const boundary = new Date('2026-08-02T12:00:00Z');
    const now = new Date('2026-08-15T00:00:00Z');
    const tiedIssues = Array.from({ length: 31 }, (_, index) => ({
      ...makeIssue(index + 1, boundary.toISOString()),
      comments: 1,
    }));
    githubMocks.repositories = [{ fullName: 'acme/a', installationId: 1 }];
    githubMocks.syncState.set('github-issues:acme/a', {
      watermark: boundary,
      backfillCursor: JSON.stringify({
        boundary: boundary.toISOString(),
        seen: tiedIssues.map((tiedIssue) => [tiedIssue.number, 'stale']),
        commentProbeOffset: 0,
      }),
    });
    githubMocks.listForRepo.mockResolvedValue({ data: tiedIssues });
    githubMocks.listComments.mockResolvedValue({ data: [] });

    const result = await collectBrainGithubIssues({ now, limit: 100 });
    expect(result.pages).toHaveLength(30);
    expect(githubMocks.listComments).toHaveBeenCalledTimes(30);
    expect(JSON.parse(result.stateUpdates[0]!.cursor!)).toMatchObject({
      commentProbeOffset: 30,
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
