const mocks = vi.hoisted(() => ({
  checksGet: vi.fn(),
  pullsGet: vi.fn(),
  handlePrOpen: vi.fn(),
  resolveConfiguredGitHubAppSlug: vi.fn(),
  select: vi.fn(),
  queryRows: [] as Array<{ prNumber: number | null; prSha: string | null }>,
}));

vi.mock('@roomote/db/server', () => {
  const query = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(() => Promise.resolve(mocks.queryRows)),
  };
  query.from.mockReturnValue(query);
  query.innerJoin.mockReturnValue(query);
  query.where.mockReturnValue(query);

  return {
    and: vi.fn((...args: unknown[]) => args),
    db: { select: mocks.select.mockReturnValue(query) },
    eq: vi.fn((...args: unknown[]) => args),
    taskPullRequests: {
      githubCheckRunId: 'githubCheckRunId',
      prNumber: 'prNumber',
      prSha: 'prSha',
      repository: 'repository',
      sourceControlProvider: 'sourceControlProvider',
      taskId: 'taskId',
    },
    taskRuns: { id: 'runId', taskId: 'runTaskId' },
    tasks: { id: 'taskId', workflow: 'workflow' },
  };
});

vi.mock('@roomote/github', () => ({
  getInstallationOctokit: vi.fn(async () => ({
    rest: {
      checks: { get: mocks.checksGet },
      pulls: { get: mocks.pullsGet },
    },
  })),
  resolveConfiguredGitHubAppSlug: mocks.resolveConfiguredGitHubAppSlug,
}));

vi.mock('@roomote/sdk/server', () => ({
  GITHUB_PR_REVIEW_CHECK_NAME: 'Roomote code review',
}));

vi.mock('../handlePrOpen', () => ({
  handlePrOpen: mocks.handlePrOpen,
}));

import { handleCheckRunRerequested } from '../handleCheckRunRerequested';

const headSha = 'a'.repeat(40);
const payload = {
  action: 'rerequested',
  installation: { id: 123 },
  repository: { id: 456, full_name: 'acme/widgets' },
  sender: { id: 789, login: 'maintainer' },
  check_run: {
    id: 9001,
    name: 'Roomote code review',
    app: { slug: 'roomote' },
    head_sha: headSha,
  },
};

describe('handleCheckRunRerequested', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryRows = [{ prNumber: 42, prSha: headSha }];
    mocks.resolveConfiguredGitHubAppSlug.mockResolvedValue('roomote');
    mocks.checksGet.mockResolvedValue({
      data: {
        id: 9001,
        name: 'Roomote code review',
        app: { slug: 'roomote' },
        external_id: 'roomote-review:77',
        head_sha: headSha,
        status: 'completed',
      },
    });
    mocks.pullsGet.mockResolvedValue({
      data: {
        number: 42,
        title: 'Improve widgets',
        body: null,
        html_url: 'https://github.com/acme/widgets/pull/42',
        state: 'open',
        locked: false,
        draft: false,
        user: { login: 'author' },
        head: { ref: 'feature/widgets', sha: headSha },
        base: { ref: 'main', sha: 'b'.repeat(40) },
      },
    });
    mocks.handlePrOpen.mockResolvedValue({
      status: 'ok',
      metadata: { ids: [78] },
    });
  });

  it('launches an explicit review from authoritative linked PR context', async () => {
    await expect(
      handleCheckRunRerequested(payload as never),
    ).resolves.toMatchObject({ status: 'ok', metadata: { ids: [78] } });

    expect(mocks.checksGet).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      check_run_id: 9001,
    });
    expect(mocks.pullsGet).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      pull_number: 42,
    });
    expect(mocks.handlePrOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        installation: payload.installation,
        repository: payload.repository,
        sender: payload.sender,
        pull_request: expect.objectContaining({
          number: 42,
          head: expect.objectContaining({ sha: headSha }),
        }),
      }),
      {
        isExplicitReviewRequest: true,
        expectedGithubCheckRunId: 9001,
        expectedHeadSha: headSha,
      },
    );
  });

  it.each([
    ['foreign name', { name: 'CI / Tests' }],
    ['foreign app', { app: { slug: 'other-app' } }],
  ])(
    'ignores a %s without fetching GitHub context',
    async (_label, override) => {
      const result = await handleCheckRunRerequested({
        ...payload,
        check_run: { ...payload.check_run, ...override },
      } as never);

      expect(result).toMatchObject({ status: 'ok' });
      expect(mocks.checksGet).not.toHaveBeenCalled();
      expect(mocks.handlePrOpen).not.toHaveBeenCalled();
    },
  );

  it('ignores a check with malformed ownership metadata', async () => {
    mocks.checksGet.mockResolvedValue({
      data: {
        id: 9001,
        name: 'Roomote code review',
        app: { slug: 'roomote' },
        external_id: 'not-a-roomote-run',
        head_sha: headSha,
        status: 'completed',
      },
    });

    const result = await handleCheckRunRerequested(payload as never);

    expect(result).toMatchObject({ status: 'ok' });
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.handlePrOpen).not.toHaveBeenCalled();
  });

  it('ignores a check without current PR linkage', async () => {
    mocks.queryRows = [];

    const result = await handleCheckRunRerequested(payload as never);

    expect(result).toMatchObject({ status: 'ok' });
    expect(mocks.pullsGet).not.toHaveBeenCalled();
    expect(mocks.handlePrOpen).not.toHaveBeenCalled();
  });

  it.each([
    ['closed PR', { state: 'closed', head: { sha: headSha } }],
    ['stale head', { state: 'open', head: { sha: 'new-head' } }],
  ])('ignores %s context', async (_label, pullRequest) => {
    mocks.pullsGet.mockResolvedValue({ data: pullRequest });

    const result = await handleCheckRunRerequested(payload as never);

    expect(result).toMatchObject({ status: 'ok' });
    expect(mocks.handlePrOpen).not.toHaveBeenCalled();
  });
});
