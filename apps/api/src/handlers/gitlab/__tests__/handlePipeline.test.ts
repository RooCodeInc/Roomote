const { mockDbFindMany, mockLaunchCiFailureTriageForFailedRun } = vi.hoisted(
  () => ({
    mockDbFindMany: vi.fn(),
    mockLaunchCiFailureTriageForFailedRun: vi.fn(),
  }),
);

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

import { handleGitLabPipeline } from '../handlePipeline';

function buildPayload(
  overrides: {
    object_attributes?: Record<string, unknown>;
    project?: Record<string, unknown>;
    commit?: Record<string, unknown> | null;
  } = {},
) {
  return {
    object_kind: 'pipeline' as const,
    object_attributes: {
      id: 77,
      name: 'default',
      ref: 'main',
      sha: 'abc123def',
      status: 'failed',
      source: 'push',
      url: 'https://gitlab.com/acme/api/-/pipelines/77',
      ...overrides.object_attributes,
    },
    project: {
      id: 9001,
      path_with_namespace: 'acme/api',
      web_url: 'https://gitlab.com/acme/api',
      default_branch: 'main',
      ...overrides.project,
    },
    commit:
      overrides.commit === null
        ? undefined
        : {
            id: 'abc123def',
            ...overrides.commit,
          },
  };
}

describe('handleGitLabPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbFindMany.mockResolvedValue([
      {
        id: 'repo-row-1',
        fullName: 'acme/api',
        host: 'gitlab.com',
        defaultBranch: 'main',
      },
    ]);
    mockLaunchCiFailureTriageForFailedRun.mockResolvedValue({
      status: 'ok',
      message: 'Launched CI failure triage for acme/api',
      taskId: 'task-1',
    });
  });

  it('maps a failed default-branch pipeline into FailedCiRun and launches', async () => {
    const result = await handleGitLabPipeline(buildPayload());

    expect(result.status).toBe('ok');
    expect(mockLaunchCiFailureTriageForFailedRun).toHaveBeenCalledWith({
      provider: 'gitlab',
      repositoryId: 'repo-row-1',
      repositoryFullName: 'acme/api',
      repositoryHost: 'gitlab.com',
      externalRepoId: '9001',
      defaultBranch: 'main',
      headBranch: 'main',
      headSha: 'abc123def',
      workflowOrPipelineName: 'default',
      runId: '77',
      runUrl: 'https://gitlab.com/acme/api/-/pipelines/77',
    });
  });

  it('ignores successful pipelines', async () => {
    const result = await handleGitLabPipeline(
      buildPayload({ object_attributes: { status: 'success' } }),
    );

    expect(result.message).toContain('non-failure');
    expect(mockLaunchCiFailureTriageForFailedRun).not.toHaveBeenCalled();
  });

  it('ignores failures outside the default branch', async () => {
    const result = await handleGitLabPipeline(
      buildPayload({ object_attributes: { ref: 'feature/x' } }),
    );

    expect(result.message).toContain('outside the default branch');
    expect(mockLaunchCiFailureTriageForFailedRun).not.toHaveBeenCalled();
  });

  it('skips nested/child pipeline sources', async () => {
    const result = await handleGitLabPipeline(
      buildPayload({ object_attributes: { source: 'parent_pipeline' } }),
    );

    expect(result.message).toContain('nested/child');
    expect(mockLaunchCiFailureTriageForFailedRun).not.toHaveBeenCalled();
  });

  it('skips repos that are not active in Roomote', async () => {
    mockDbFindMany.mockResolvedValue([]);

    const result = await handleGitLabPipeline(buildPayload());

    expect(result.message).toContain('No active GitLab repository');
    expect(mockLaunchCiFailureTriageForFailedRun).not.toHaveBeenCalled();
  });
});
