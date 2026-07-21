const {
  mockDbFindMany,
  mockGetAdoBuildFailureEvidence,
  mockLaunchCiFailureTriageForFailedRun,
} = vi.hoisted(() => ({
  mockDbFindMany: vi.fn(),
  mockGetAdoBuildFailureEvidence: vi.fn(),
  mockLaunchCiFailureTriageForFailedRun: vi.fn(),
}));

vi.mock('@roomote/ado', () => ({
  getAdoBuildFailureEvidence: (...args: unknown[]) =>
    mockGetAdoBuildFailureEvidence(...args),
  getAdoBuildWebUrl: (build: {
    id: number;
    url?: string;
    _links?: { web?: { href?: string } };
  }) => build._links?.web?.href ?? build.url ?? `build/${build.id}`,
  stripAdoGitRef: (ref: string | null | undefined) =>
    (ref ?? '').replace(/^refs\/heads\//, '').trim() || '',
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

import { handleAdoBuild } from '../handleBuild';

function buildPayload(
  overrides: {
    resource?: Record<string, unknown>;
    resourceContainers?: Record<string, unknown>;
  } = {},
) {
  return {
    id: 'delivery-build-1',
    eventType: 'build.complete' as const,
    publisherId: 'tfs',
    resourceContainers: {
      account: {
        baseUrl: 'https://dev.azure.com/acme/',
      },
      ...overrides.resourceContainers,
    },
    resource: {
      id: 88,
      buildNumber: '20260721.3',
      status: 'completed',
      result: 'failed',
      sourceBranch: 'refs/heads/main',
      sourceVersion: 'abc123def',
      definition: {
        id: 3,
        name: 'CI',
      },
      project: {
        id: 'project-1',
        name: 'Platform',
      },
      repository: {
        id: 'repo-guid-1',
        name: 'backend',
        type: 'TfsGit',
      },
      _links: {
        web: {
          href: 'https://dev.azure.com/acme/Platform/_build/results?buildId=88',
        },
      },
      ...overrides.resource,
    },
  };
}

describe('handleAdoBuild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbFindMany.mockResolvedValue([
      {
        id: 'repo-row-1',
        fullName: 'acme/Platform/backend',
        host: 'dev.azure.com',
        defaultBranch: 'main',
      },
    ]);
    mockLaunchCiFailureTriageForFailedRun.mockResolvedValue({
      status: 'ok',
      message: 'Launched CI failure triage for acme/Platform/backend',
      taskId: 'task-1',
    });
    mockGetAdoBuildFailureEvidence.mockResolvedValue(null);
  });

  it('maps a failed default-branch build into FailedCiRun and launches', async () => {
    const result = await handleAdoBuild(buildPayload());

    expect(result.status).toBe('ok');
    expect(mockLaunchCiFailureTriageForFailedRun).toHaveBeenCalledWith({
      provider: 'ado',
      repositoryId: 'repo-row-1',
      repositoryFullName: 'acme/Platform/backend',
      repositoryHost: 'dev.azure.com',
      externalRepoId: 'repo-guid-1',
      defaultBranch: 'main',
      headBranch: 'main',
      headSha: 'abc123def',
      workflowOrPipelineName: 'CI',
      runId: '88',
      runUrl: 'https://dev.azure.com/acme/Platform/_build/results?buildId=88',
    });
  });

  it('ignores successful builds', async () => {
    const result = await handleAdoBuild(
      buildPayload({ resource: { result: 'succeeded' } }),
    );

    expect(result.message).toContain('non-failure');
    expect(mockLaunchCiFailureTriageForFailedRun).not.toHaveBeenCalled();
  });

  it('injects failed-task evidence fetched with the deployment credential', async () => {
    mockGetAdoBuildFailureEvidence.mockResolvedValue(
      'task="Test" result="failed"\nAssertionError: expected true',
    );

    await handleAdoBuild(buildPayload());

    expect(mockGetAdoBuildFailureEvidence).toHaveBeenCalledWith({
      repositoryFullName: 'acme/Platform/backend',
      buildId: 88,
    });
    expect(mockLaunchCiFailureTriageForFailedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'ado',
        failureEvidence:
          'task="Test" result="failed"\nAssertionError: expected true',
      }),
    );
  });

  it('ignores failures outside the default branch', async () => {
    const result = await handleAdoBuild(
      buildPayload({ resource: { sourceBranch: 'refs/heads/feature/x' } }),
    );

    expect(result.message).toContain('outside the default branch');
    expect(mockLaunchCiFailureTriageForFailedRun).not.toHaveBeenCalled();
  });

  it('skips repos that are not active in Roomote', async () => {
    mockDbFindMany.mockResolvedValue([]);

    const result = await handleAdoBuild(buildPayload());

    expect(result.message).toContain('No active Azure DevOps repository');
    expect(mockLaunchCiFailureTriageForFailedRun).not.toHaveBeenCalled();
  });
});
