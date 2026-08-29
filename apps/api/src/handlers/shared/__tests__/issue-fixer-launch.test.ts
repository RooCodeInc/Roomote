import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockBuildIssueFixerFixPrompt,
  mockEnqueueTask,
  mockGetBackgroundAgentSettings,
  mockRecordAutomationRunOutcome,
  mockResolveMappedEnvironmentId,
} = vi.hoisted(() => ({
  mockBuildIssueFixerFixPrompt: vi.fn(),
  mockEnqueueTask: vi.fn(),
  mockGetBackgroundAgentSettings: vi.fn(),
  mockRecordAutomationRunOutcome: vi.fn(),
  mockResolveMappedEnvironmentId: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildIssueFixerFixPrompt: mockBuildIssueFixerFixPrompt,
  enqueueTask: mockEnqueueTask,
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  getBackgroundAgentSettingsForDeployment: mockGetBackgroundAgentSettings,
  recordAutomationRunOutcome: mockRecordAutomationRunOutcome,
}));

vi.mock('../repository-environment', () => ({
  resolveMappedEnvironmentId: mockResolveMappedEnvironmentId,
}));

import { launchIssueFixerTriage } from '../issue-fixer-launch';

describe('launchIssueFixerTriage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBackgroundAgentSettings.mockResolvedValue({
      issueFixerFrequency: 'daily',
      issueFixerInstructions: 'Focus on acceptance criteria first.',
    });
    mockResolveMappedEnvironmentId.mockResolvedValue('env-host-scoped');
    mockBuildIssueFixerFixPrompt.mockReturnValue('$issue-fixer\n<context />');
    mockEnqueueTask.mockResolvedValue({ taskId: 'task-1' });
    mockRecordAutomationRunOutcome.mockResolvedValue(undefined);
  });

  it('preserves the resolved repository id, provider, and host through launch', async () => {
    await expect(
      launchIssueFixerTriage({
        sourceControlProvider: 'gitlab',
        repositoryId: 'repo-host-scoped',
        repositoryFullName: 'acme/backend',
        sourceControlHost: 'git.example.com',
        continueMention: '@roomote',
        issue: {
          number: 9,
          title: 'Broken checkout',
          url: 'https://git.example.com/acme/backend/-/issues/9',
        },
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      metadata: { taskId: 'task-1' },
    });

    expect(mockResolveMappedEnvironmentId).toHaveBeenCalledWith(
      'repo-host-scoped',
    );
    expect(mockBuildIssueFixerFixPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalInstructions: 'Focus on acceptance criteria first.',
        repositoryFullName: 'acme/backend',
        sourceControlProvider: 'gitlab',
      }),
    );
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            repo: 'acme/backend',
            environmentId: 'env-host-scoped',
            sourceControlProvider: 'gitlab',
            sourceControlHost: 'git.example.com',
            sourceEventUrl: 'https://git.example.com/acme/backend/-/issues/9',
          }),
        }),
        surface: 'gitlab',
      }),
      { launchClass: 'automation' },
    );
  });

  it('skips launch when the repository has no mapped environment', async () => {
    mockResolveMappedEnvironmentId.mockResolvedValue(null);

    await expect(
      launchIssueFixerTriage({
        sourceControlProvider: 'gitea',
        repositoryId: 'repo-gitea-id',
        repositoryFullName: 'acme/backend',
        issue: {
          number: 4,
          title: 'Broken',
          url: 'https://git.example.com/acme/backend/issues/4',
        },
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      message: 'Repository has no configured environment for Triage Issues',
    });

    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });
});
