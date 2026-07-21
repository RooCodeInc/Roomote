const {
  mockDbFindMany,
  mockGetBitbucketPipeline,
  mockGetBitbucketPipelineByBuildNumber,
  mockGetBitbucketPipelineFailureEvidence,
  mockGetBitbucketPipelineResultName,
  mockGetBitbucketPipelineWebUrl,
  mockLaunchCiFailureTriageForFailedRun,
} = vi.hoisted(() => ({
  mockDbFindMany: vi.fn(),
  mockGetBitbucketPipeline: vi.fn(),
  mockGetBitbucketPipelineByBuildNumber: vi.fn(),
  mockGetBitbucketPipelineFailureEvidence: vi.fn(),
  mockGetBitbucketPipelineResultName: vi.fn(),
  mockGetBitbucketPipelineWebUrl: vi.fn(),
  mockLaunchCiFailureTriageForFailedRun: vi.fn(),
}));

vi.mock('@roomote/bitbucket', () => ({
  getBitbucketPipeline: (...args: unknown[]) =>
    mockGetBitbucketPipeline(...args),
  getBitbucketPipelineByBuildNumber: (...args: unknown[]) =>
    mockGetBitbucketPipelineByBuildNumber(...args),
  getBitbucketPipelineFailureEvidence: (...args: unknown[]) =>
    mockGetBitbucketPipelineFailureEvidence(...args),
  getBitbucketPipelineResultName: (...args: unknown[]) =>
    mockGetBitbucketPipelineResultName(...args),
  getBitbucketPipelineWebUrl: (...args: unknown[]) =>
    mockGetBitbucketPipelineWebUrl(...args),
  resolveBitbucketInstanceHost: async () => 'bitbucket.org',
  stripUuidBraces: (value: string) => value.replace(/^\{|\}$/g, ''),
}));

vi.mock('@roomote/sdk/server', () => ({
  launchCiFailureTriageForFailedRun: (...args: unknown[]) =>
    mockLaunchCiFailureTriageForFailedRun(...args),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      repositories: {
        findMany: (...args: unknown[]) => mockDbFindMany(...args),
      },
    },
  },
  repositories: {
    sourceControlProvider: 'sourceControlProvider',
    isActive: 'isActive',
    externalRepoId: 'externalRepoId',
    fullName: 'fullName',
  },
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((left: unknown, right: unknown) => [left, right]),
  or: vi.fn((...args: unknown[]) => args),
}));

import {
  handleBitbucketCommitStatus,
  parseBitbucketPipelineIdentityFromUrl,
} from '../handleCommitStatus';

function buildPayload(
  overrides: {
    commit_status?: Record<string, unknown>;
    repository?: Record<string, unknown>;
  } = {},
) {
  return {
    commit_status: {
      name: 'Pipeline',
      state: 'FAILED',
      key: 'BB-PIPE',
      url: 'https://bitbucket.org/acme/api/addon/pipelines/home#!/results/42',
      refname: 'main',
      commit: { hash: 'abc123def' },
      links: {
        self: {
          href: 'https://api.bitbucket.org/2.0/repositories/acme/api/commit/abc123def/statuses/build/BB-PIPE',
        },
      },
      ...overrides.commit_status,
    },
    repository: {
      uuid: '{repo-uuid-1}',
      full_name: 'acme/api',
      name: 'api',
      links: {
        html: { href: 'https://bitbucket.org/acme/api' },
      },
      ...overrides.repository,
    },
  };
}

describe('parseBitbucketPipelineIdentityFromUrl', () => {
  it('parses build numbers from results URLs', () => {
    expect(
      parseBitbucketPipelineIdentityFromUrl(
        'https://bitbucket.org/acme/api/addon/pipelines/home#!/results/42',
      ),
    ).toEqual({ buildNumber: 42 });
  });

  it('parses bare and braced pipeline UUIDs', () => {
    expect(
      parseBitbucketPipelineIdentityFromUrl(
        'https://bitbucket.org/acme/api/pipelines/results/{01234567-89ab-cdef-0123-456789abcdef}',
      ),
    ).toEqual({ pipelineUuid: '01234567-89ab-cdef-0123-456789abcdef' });

    expect(
      parseBitbucketPipelineIdentityFromUrl(
        'https://bitbucket.org/acme/api/pipelines/results/01234567-89ab-cdef-0123-456789abcdef',
      ),
    ).toEqual({ pipelineUuid: '01234567-89ab-cdef-0123-456789abcdef' });
  });

  it('returns empty identity for unrelated URLs', () => {
    expect(
      parseBitbucketPipelineIdentityFromUrl(
        'https://bitbucket.org/acme/api/src/main/',
      ),
    ).toEqual({});
  });

  it('returns empty identity for external CI URLs that only look like results paths', () => {
    expect(
      parseBitbucketPipelineIdentityFromUrl(
        'https://ci.example.com/job/acme-api/results/42/',
        'bitbucket.org',
      ),
    ).toEqual({});
  });

  it('returns empty identity for Pipelines-shaped URLs on a non-Bitbucket host', () => {
    expect(
      parseBitbucketPipelineIdentityFromUrl(
        'https://ci.example.com/addon/pipelines/home#!/results/42',
        'bitbucket.org',
      ),
    ).toEqual({});

    expect(
      parseBitbucketPipelineIdentityFromUrl(
        'https://ci.example.com/ws/repo/pipelines/results/42',
        'bitbucket.org',
      ),
    ).toEqual({});
  });

  it('accepts Pipelines URLs on the configured Bitbucket host', () => {
    expect(
      parseBitbucketPipelineIdentityFromUrl(
        'https://bitbucket.org/acme/api/addon/pipelines/home#!/results/42',
        'bitbucket.org',
      ),
    ).toEqual({ buildNumber: 42 });
  });
});

describe('handleBitbucketCommitStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbFindMany.mockResolvedValue([
      {
        id: 'repo-row-1',
        fullName: 'acme/api',
        host: 'bitbucket.org',
        defaultBranch: 'main',
        externalRepoId: 'repo-uuid-1',
      },
    ]);
    mockLaunchCiFailureTriageForFailedRun.mockResolvedValue({
      status: 'ok',
      message: 'Launched CI failure triage for acme/api',
      taskId: 'task-1',
    });
    mockGetBitbucketPipelineFailureEvidence.mockResolvedValue(null);
    mockGetBitbucketPipelineByBuildNumber.mockResolvedValue({
      uuid: '{pipe-1}',
      build_number: 42,
      target: {
        ref_name: 'main',
        commit: { hash: 'abc123def' },
        selector: { type: 'branches', pattern: 'main' },
      },
      state: { result: { name: 'FAILED' } },
    });
    mockGetBitbucketPipelineResultName.mockReturnValue('FAILED');
    mockGetBitbucketPipelineWebUrl.mockReturnValue(
      'https://bitbucket.org/acme/api/addon/pipelines/home#!/results/42',
    );
  });

  it('maps a failed default-branch commit status into FailedCiRun and launches', async () => {
    const result = await handleBitbucketCommitStatus(buildPayload());

    expect(result.status).toBe('ok');
    expect(mockGetBitbucketPipelineByBuildNumber).toHaveBeenCalledWith({
      repositoryFullName: 'acme/api',
      branch: 'main',
      buildNumber: 42,
    });
    expect(mockLaunchCiFailureTriageForFailedRun).toHaveBeenCalledWith({
      provider: 'bitbucket',
      repositoryId: 'repo-row-1',
      repositoryFullName: 'acme/api',
      repositoryHost: 'bitbucket.org',
      externalRepoId: 'repo-uuid-1',
      defaultBranch: 'main',
      headBranch: 'main',
      headSha: 'abc123def',
      workflowOrPipelineName: 'main',
      runId: 'pipe-1',
      runUrl:
        'https://bitbucket.org/acme/api/addon/pipelines/home#!/results/42',
    });
  });

  it('ignores successful commit statuses', async () => {
    const result = await handleBitbucketCommitStatus(
      buildPayload({ commit_status: { state: 'SUCCESSFUL' } }),
    );

    expect(result.message).toContain('non-failure');
    expect(mockLaunchCiFailureTriageForFailedRun).not.toHaveBeenCalled();
  });

  it('ignores failures outside the default branch', async () => {
    mockGetBitbucketPipelineByBuildNumber.mockResolvedValue({
      uuid: '{pipe-1}',
      build_number: 42,
      target: {
        ref_name: 'feature/x',
        commit: { hash: 'abc123def' },
      },
      state: { result: { name: 'FAILED' } },
    });

    const result = await handleBitbucketCommitStatus(
      buildPayload({ commit_status: { refname: 'feature/x' } }),
    );

    expect(result.message).toContain('outside the default branch');
    expect(mockLaunchCiFailureTriageForFailedRun).not.toHaveBeenCalled();
  });

  it('injects pipeline failure evidence when available', async () => {
    mockGetBitbucketPipelineFailureEvidence.mockResolvedValue(
      'step="test" result="FAILED"\nAssertionError: expected true',
    );

    await handleBitbucketCommitStatus(buildPayload());

    expect(mockGetBitbucketPipelineFailureEvidence).toHaveBeenCalledWith({
      repositoryFullName: 'acme/api',
      pipelineUuid: 'pipe-1',
    });
    expect(mockLaunchCiFailureTriageForFailedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'bitbucket',
        failureEvidence:
          'step="test" result="FAILED"\nAssertionError: expected true',
      }),
    );
  });

  it('skips repos that are not active in Roomote', async () => {
    mockDbFindMany.mockResolvedValue([]);

    const result = await handleBitbucketCommitStatus(buildPayload());

    expect(result.message).toContain('No active Bitbucket repository');
    expect(mockLaunchCiFailureTriageForFailedRun).not.toHaveBeenCalled();
  });

  it('ignores failed external commit statuses that are not Pipelines result URLs', async () => {
    const result = await handleBitbucketCommitStatus(
      buildPayload({
        commit_status: {
          name: 'Jenkins',
          key: 'jenkins-build',
          url: 'https://ci.example.com/job/acme-api/123/',
        },
      }),
    );

    expect(result.message).toContain('not a Pipelines result URL');
    expect(mockGetBitbucketPipelineByBuildNumber).not.toHaveBeenCalled();
    expect(mockLaunchCiFailureTriageForFailedRun).not.toHaveBeenCalled();
  });

  it('ignores Pipelines URLs that do not resolve to a pipeline run', async () => {
    mockGetBitbucketPipelineByBuildNumber.mockResolvedValue(null);

    const result = await handleBitbucketCommitStatus(buildPayload());

    expect(result.message).toContain('could not be resolved to a Pipeline');
    expect(mockLaunchCiFailureTriageForFailedRun).not.toHaveBeenCalled();
  });
});
