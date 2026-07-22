const {
  mockDbFindMany,
  mockGetGiteaActionRunFailureEvidence,
  mockGetGiteaActionRunWebUrl,
  mockGetGiteaWorkflowName,
  mockLaunchCiFailureTriageForFailedRun,
} = vi.hoisted(() => ({
  mockDbFindMany: vi.fn(),
  mockGetGiteaActionRunFailureEvidence: vi.fn(),
  mockGetGiteaActionRunWebUrl: vi.fn(),
  mockGetGiteaWorkflowName: vi.fn(),
  mockLaunchCiFailureTriageForFailedRun: vi.fn(),
}));

vi.mock('@roomote/gitea', () => ({
  getGiteaActionRunConclusion: (run: {
    conclusion?: string | null;
    status?: string | null;
  }) => (run.conclusion ?? run.status ?? '').trim().toLowerCase(),
  getGiteaActionRunFailureEvidence: (...args: unknown[]) =>
    mockGetGiteaActionRunFailureEvidence(...args),
  getGiteaActionRunWebUrl: (...args: unknown[]) =>
    mockGetGiteaActionRunWebUrl(...args),
  getGiteaWorkflowName: (...args: unknown[]) =>
    mockGetGiteaWorkflowName(...args),
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

import { handleGiteaWorkflowRun } from '../handleWorkflowRun';

function buildPayload(
  overrides: {
    action?: string;
    workflow_run?: Record<string, unknown>;
    workflow?: Record<string, unknown>;
    repository?: Record<string, unknown>;
  } = {},
) {
  return {
    action: overrides.action ?? 'completed',
    workflow: {
      id: 'ci.yml',
      name: 'CI',
      path: '.gitea/workflows/ci.yml',
      ...overrides.workflow,
    },
    workflow_run: {
      id: 99,
      status: 'completed',
      conclusion: 'failure',
      head_branch: 'main',
      head_sha: 'abc123def',
      html_url: 'https://git.example.com/acme/api/actions/runs/99',
      path: 'ci.yml@refs/heads/main',
      display_title: 'CI',
      ...overrides.workflow_run,
    },
    repository: {
      id: 55,
      full_name: 'acme/api',
      html_url: 'https://git.example.com/acme/api',
      default_branch: 'main',
      ...overrides.repository,
    },
  };
}

describe('handleGiteaWorkflowRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbFindMany.mockResolvedValue([
      {
        id: 'repo-row-1',
        fullName: 'acme/api',
        host: 'git.example.com',
        defaultBranch: 'main',
        externalRepoId: '55',
      },
    ]);
    mockLaunchCiFailureTriageForFailedRun.mockResolvedValue({
      status: 'ok',
      message: 'Launched CI failure triage for acme/api',
      taskId: 'task-1',
    });
    mockGetGiteaActionRunFailureEvidence.mockResolvedValue(null);
    mockGetGiteaActionRunWebUrl.mockReturnValue(
      'https://git.example.com/acme/api/actions/runs/99',
    );
    mockGetGiteaWorkflowName.mockReturnValue('ci.yml');
  });

  it('maps a failed default-branch Actions run into FailedCiRun and launches', async () => {
    const result = await handleGiteaWorkflowRun(buildPayload());

    expect(result.status).toBe('ok');
    expect(mockLaunchCiFailureTriageForFailedRun).toHaveBeenCalledWith({
      provider: 'gitea',
      repositoryId: 'repo-row-1',
      repositoryFullName: 'acme/api',
      repositoryHost: 'git.example.com',
      externalRepoId: '55',
      defaultBranch: 'main',
      headBranch: 'main',
      headSha: 'abc123def',
      workflowOrPipelineName: 'CI',
      runId: '99',
      runUrl: 'https://git.example.com/acme/api/actions/runs/99',
    });
  });

  it('ignores non-completed actions', async () => {
    const result = await handleGiteaWorkflowRun(
      buildPayload({ action: 'requested' }),
    );

    expect(result.message).toContain('non-completed');
    expect(mockLaunchCiFailureTriageForFailedRun).not.toHaveBeenCalled();
  });

  it('ignores successful conclusions', async () => {
    const result = await handleGiteaWorkflowRun(
      buildPayload({ workflow_run: { conclusion: 'success' } }),
    );

    expect(result.message).toContain('non-failure');
    expect(mockLaunchCiFailureTriageForFailedRun).not.toHaveBeenCalled();
  });

  it('ignores failures outside the default branch', async () => {
    const result = await handleGiteaWorkflowRun(
      buildPayload({ workflow_run: { head_branch: 'feature/x' } }),
    );

    expect(result.message).toContain('outside the default branch');
    expect(mockLaunchCiFailureTriageForFailedRun).not.toHaveBeenCalled();
  });

  it('injects Actions failure evidence when available', async () => {
    mockGetGiteaActionRunFailureEvidence.mockResolvedValue(
      'job="test" id=7 conclusion="failure"\nAssertionError',
    );

    await handleGiteaWorkflowRun(buildPayload());

    expect(mockGetGiteaActionRunFailureEvidence).toHaveBeenCalledWith({
      repositoryFullName: 'acme/api',
      runId: 99,
    });
    expect(mockLaunchCiFailureTriageForFailedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gitea',
        failureEvidence: 'job="test" id=7 conclusion="failure"\nAssertionError',
      }),
    );
  });

  it('skips repos that are not active in Roomote', async () => {
    mockDbFindMany.mockResolvedValue([]);

    const result = await handleGiteaWorkflowRun(buildPayload());

    expect(result.message).toContain('No active Gitea repository');
    expect(mockLaunchCiFailureTriageForFailedRun).not.toHaveBeenCalled();
  });
});
