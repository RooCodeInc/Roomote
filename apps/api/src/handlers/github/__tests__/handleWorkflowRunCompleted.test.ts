const { mockDbSelect, mockLaunchCiFailureTriageForFailedRun } = vi.hoisted(
  () => ({
    mockDbSelect: vi.fn(),
    mockLaunchCiFailureTriageForFailedRun: vi.fn(),
  }),
);

vi.mock('@roomote/sdk/server', () => ({
  launchCiFailureTriageForFailedRun: (...args: unknown[]) =>
    mockLaunchCiFailureTriageForFailedRun(...args),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: mockDbSelect,
  },
  githubInstallations: {
    id: 'githubInstallations.id',
    installationId: 'githubInstallations.installationId',
  },
  repositories: {
    id: 'repositories.id',
    fullName: 'repositories.fullName',
    githubRepoId: 'repositories.githubRepoId',
    installationId: 'repositories.installationId',
    isActive: 'repositories.isActive',
  },
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((left: unknown, right: unknown) => [left, right]),
}));

import { handleWorkflowRunCompleted } from '../handleWorkflowRunCompleted';

function buildPayload(
  overrides: {
    workflow_run?: Record<string, unknown>;
    repository?: Record<string, unknown>;
    installation?: { id: number } | null;
  } = {},
) {
  return {
    action: 'completed',
    workflow_run: {
      id: 42,
      name: 'CI',
      conclusion: 'failure',
      head_branch: 'main',
      head_sha: 'abc123',
      html_url: 'https://github.com/acme/api/actions/runs/42',
      event: 'push',
      ...overrides.workflow_run,
    },
    repository: {
      id: 9001,
      full_name: 'acme/api',
      default_branch: 'main',
      ...overrides.repository,
    },
    installation:
      'installation' in overrides ? overrides.installation : { id: 555 },
  } as never;
}

describe('handleWorkflowRunCompleted', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockDbSelect.mockImplementation(() => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => [
              {
                repositoryId: 'repo-row-1',
                repositoryFullName: 'acme/api',
              },
            ],
          }),
        }),
      }),
    }));
    mockLaunchCiFailureTriageForFailedRun.mockResolvedValue({
      status: 'ok',
      message: 'Launched CI failure triage for acme/api',
      taskId: 'task-1',
    });
  });

  it('maps a failed default-branch workflow into FailedCiRun and launches', async () => {
    const result = await handleWorkflowRunCompleted(buildPayload());

    expect(result.status).toBe('ok');
    expect(mockLaunchCiFailureTriageForFailedRun).toHaveBeenCalledWith({
      provider: 'github',
      repositoryId: 'repo-row-1',
      repositoryFullName: 'acme/api',
      externalRepoId: '9001',
      defaultBranch: 'main',
      headBranch: 'main',
      headSha: 'abc123',
      workflowOrPipelineName: 'CI',
      runId: '42',
      runUrl: 'https://github.com/acme/api/actions/runs/42',
    });
  });

  it('ignores successful workflow runs', async () => {
    const result = await handleWorkflowRunCompleted(
      buildPayload({ workflow_run: { conclusion: 'success' } }),
    );

    expect(result.message).toContain('non-failure');
    expect(mockLaunchCiFailureTriageForFailedRun).not.toHaveBeenCalled();
  });

  it('ignores failures outside the default branch', async () => {
    const result = await handleWorkflowRunCompleted(
      buildPayload({ workflow_run: { head_branch: 'feature/x' } }),
    );

    expect(result.message).toContain('outside the default branch');
    expect(mockLaunchCiFailureTriageForFailedRun).not.toHaveBeenCalled();
  });

  it('skips repos that are not active in Roomote', async () => {
    mockDbSelect.mockImplementation(() => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    }));

    const result = await handleWorkflowRunCompleted(buildPayload());

    expect(result.message).toContain('not active');
    expect(mockLaunchCiFailureTriageForFailedRun).not.toHaveBeenCalled();
  });

  it('skips when installation id is missing', async () => {
    const result = await handleWorkflowRunCompleted(
      buildPayload({ installation: null }),
    );

    expect(result.message).toContain('Missing installation id');
    expect(mockLaunchCiFailureTriageForFailedRun).not.toHaveBeenCalled();
  });
});
