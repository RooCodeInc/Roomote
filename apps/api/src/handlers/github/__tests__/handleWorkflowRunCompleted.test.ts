const {
  mockDbSelect,
  mockDeploymentHasActiveCredentialUser,
  mockEnqueueCloudTask,
  mockBuildRepositoryCoverage,
  mockGetBackgroundAgentSettingsForOrg,
  mockEvaluateFeatureFlag,
  mockStartBackgroundAutomationRun,
  mockCompleteBackgroundAutomationRun,
  mockUpsertBackgroundAutomationSlackThread,
  mockResolveAutomationSlackTarget,
  mockPostMessage,
  mockUpdateMessage,
  mockRedisSet,
} = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDeploymentHasActiveCredentialUser: vi.fn(),
  mockEnqueueCloudTask: vi.fn(),
  mockBuildRepositoryCoverage: vi.fn(),
  mockGetBackgroundAgentSettingsForOrg: vi.fn(),
  mockEvaluateFeatureFlag: vi.fn(),
  mockStartBackgroundAutomationRun: vi.fn(),
  mockCompleteBackgroundAutomationRun: vi.fn(),
  mockUpsertBackgroundAutomationSlackThread: vi.fn(),
  mockResolveAutomationSlackTarget: vi.fn(),
  mockPostMessage: vi.fn(),
  mockUpdateMessage: vi.fn(),
  mockRedisSet: vi.fn(),
}));

vi.mock('../../tasks/automation-work-items/slack.js', () => ({
  resolveAutomationSlackTarget: (...args: unknown[]) =>
    mockResolveAutomationSlackTarget(...args),
}));

vi.mock('../../tasks/background-automation-slack.js', () => ({
  resolveScheduledSuggestionSlackConfig: vi.fn(() => ({
    managerChannelKind: 'ciFailureTriage',
  })),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    set: (...args: unknown[]) => mockRedisSet(...args),
  }),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildCiFailureTriagePrompt: (params: {
    trigger: string;
    triggeringRun?: { runUrl: string } | null;
    hasAnnouncementThread?: boolean;
  }) =>
    `$ci-failure-triage trigger=${params.trigger} run=${params.triggeringRun?.runUrl ?? 'none'} announced=${params.hasAnnouncementThread === true}`,
  buildRepositoryCoverage: (...args: unknown[]) =>
    mockBuildRepositoryCoverage(...args),
  deploymentHasActiveCredentialUser: (...args: unknown[]) =>
    mockDeploymentHasActiveCredentialUser(...args),
  enqueueCloudTask: (...args: unknown[]) => mockEnqueueCloudTask(...args),
  getTaskUrl: ({ taskId }: { taskId: string }) =>
    `https://app.example.com/task/${taskId}?utm_source=slack&utm_medium=link&utm_campaign=slack.thread_reply`,
}));

vi.mock('@roomote/feature-flags/server', () => ({
  FeatureFlag: {
    BetaAutomations: 'BetaAutomations',
  },
  getFeatureFlagEvaluator: vi.fn(() => ({
    evaluate: mockEvaluateFeatureFlag,
  })),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: mockDbSelect,
    query: {
      taskPullRequests: { findFirst: vi.fn() },
    },
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
  taskPullRequests: { taskId: 'taskPullRequests.taskId' },
  getBackgroundAgentSettingsForDeployment: (...args: unknown[]) =>
    mockGetBackgroundAgentSettingsForOrg(...args),
  startBackgroundAutomationRun: (...args: unknown[]) =>
    mockStartBackgroundAutomationRun(...args),
  completeBackgroundAutomationRun: (...args: unknown[]) =>
    mockCompleteBackgroundAutomationRun(...args),
  upsertBackgroundAutomationSlackThread: (...args: unknown[]) =>
    mockUpsertBackgroundAutomationSlackThread(...args),
  resolveManagerSlackChannelId: vi.fn(
    (settings: { managerSlackChannelId?: string | null }) =>
      settings.managerSlackChannelId ?? null,
  ),
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((left: unknown, right: unknown) => [left, right]),
}));

import { CloudTaskType } from '@roomote/types';
import { db } from '@roomote/db/server';

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
    mockEvaluateFeatureFlag.mockResolvedValue(true);
    mockDeploymentHasActiveCredentialUser.mockResolvedValue(true);
    mockGetBackgroundAgentSettingsForOrg.mockResolvedValue({
      ciFailureTriageFrequency: 'daily',
      managerSlackChannelId: 'C123MANAGER',
    });
    mockBuildRepositoryCoverage.mockResolvedValue([
      { repositoryFullName: 'acme/api', targetEnvironmentId: 'env-api' },
    ]);
    mockRedisSet.mockResolvedValue('OK');
    mockResolveAutomationSlackTarget.mockResolvedValue({
      channelId: 'C123MANAGER',
      slack: {
        postMessage: (...args: unknown[]) => mockPostMessage(...args),
        getMessageBlocks: vi.fn().mockResolvedValue([
          {
            type: 'markdown',
            text: 'I noticed a CI failure on `main` in acme/api.',
          },
          {
            type: 'context',
            block_id: 'roomote_late_bound_automation_context',
            elements: [
              {
                type: 'plain_text',
                text: 'Created via the CI Failure Triage automation',
                emoji: false,
              },
            ],
          },
        ]),
        updateMessage: (...args: unknown[]) => mockUpdateMessage(...args),
      },
    });
    mockPostMessage.mockResolvedValue('1781300000.000100');
    mockUpdateMessage.mockResolvedValue(true);
    vi.mocked(db.query.taskPullRequests.findFirst).mockResolvedValue(
      undefined as never,
    );
    mockUpsertBackgroundAutomationSlackThread.mockResolvedValue(undefined);
    mockStartBackgroundAutomationRun.mockResolvedValue({ id: 'run-1' });
    mockCompleteBackgroundAutomationRun.mockResolvedValue(undefined);
    mockEnqueueCloudTask.mockResolvedValue({
      success: true,
      cloudJobId: 7,
      taskId: 'task-scan-1',
    });
  });

  it('launches an immediate triage scan for a default-branch failure', async () => {
    const result = await handleWorkflowRunCompleted(buildPayload());

    expect(result.status).toBe('ok');
    expect(mockStartBackgroundAutomationRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        automationKey: 'ci_failure_triage',
        triggerKind: 'webhook',
      }),
    );
    expect(mockEnqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        type: CloudTaskType.SuggestedTasks,
        payload: expect.objectContaining({
          repo: 'acme/api',
          selectedRepositories: ['acme/api'],
          suggestionSource: 'ci_failure_triage',
          channel: 'C123MANAGER',
          slackChannel: 'C123MANAGER',
          thread_ts: '1781300000.000100',
          slackThreadTs: '1781300000.000100',
          description: expect.stringContaining(
            'run=https://github.com/acme/api/actions/runs/42',
          ),
        }),
      }),
      expect.objectContaining({
        launchClass: 'automation',
      }),
    );
    expect(mockCompleteBackgroundAutomationRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'succeeded',
        taskId: 'task-scan-1',
        slackChannelId: 'C123MANAGER',
        threadTs: '1781300000.000100',
        metadata: expect.objectContaining({
          triggeringRunUrl: 'https://github.com/acme/api/actions/runs/42',
        }),
      }),
    );
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123MANAGER',
        text: expect.stringContaining(
          'I noticed a CI failure on `main` in acme/api.',
        ),
        blocks: expect.arrayContaining([
          {
            type: 'context',
            block_id: 'roomote_late_bound_automation_context',
            elements: [
              {
                type: 'plain_text',
                text: 'Created via the CI Failure Triage automation',
                emoji: false,
              },
            ],
          },
        ]),
      }),
    );
    expect(mockUpdateMessage).toHaveBeenCalledWith({
      channel: 'C123MANAGER',
      ts: '1781300000.000100',
      message: {
        blocks: [
          {
            type: 'markdown',
            text: 'I noticed a CI failure on `main` in acme/api.',
          },
          {
            type: 'context',
            block_id: 'roomote_late_bound_automation_context',
            elements: [
              {
                type: 'plain_text',
                text: 'Created via the CI Failure Triage automation',
                emoji: false,
              },
            ],
          },
          {
            type: 'actions',
            block_id: 'roomote_late_bound_automation_actions',
            elements: [
              {
                type: 'button',
                action_id: 'late_bound_automation_view_task',
                text: {
                  type: 'plain_text',
                  text: 'Go to task',
                  emoji: false,
                },
                url: 'https://app.example.com/task/task-scan-1?utm_source=slack&utm_medium=link&utm_campaign=slack.thread_reply',
              },
            ],
          },
        ],
      },
    });
    expect(mockUpsertBackgroundAutomationSlackThread).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        automationKey: 'ci_failure_triage',
        slackChannelId: 'C123MANAGER',
        threadTs: '1781300000.000100',
      }),
    );
  });

  it('still launches the scan without a thread when the announcement fails', async () => {
    mockPostMessage.mockRejectedValue(new Error('slack down'));

    const result = await handleWorkflowRunCompleted(buildPayload());

    expect(result.status).toBe('ok');
    const payload = mockEnqueueCloudTask.mock.calls[0]?.[0].payload;
    expect(payload.thread_ts).toBeUndefined();
    expect(payload.slackChannel).toBeUndefined();
    expect(payload.description).toContain('announced=false');
    expect(mockUpsertBackgroundAutomationSlackThread).not.toHaveBeenCalled();
    expect(mockUpdateMessage).not.toHaveBeenCalled();
  });

  it('ignores successful workflow runs', async () => {
    const result = await handleWorkflowRunCompleted(
      buildPayload({ workflow_run: { conclusion: 'success' } }),
    );

    expect(result.message).toContain('non-failure');
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
  });

  it('ignores failures outside the default branch', async () => {
    const result = await handleWorkflowRunCompleted(
      buildPayload({ workflow_run: { head_branch: 'feature/x' } }),
    );

    expect(result.message).toContain('outside the default branch');
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
  });

  it('skips orgs with the automation disabled', async () => {
    mockGetBackgroundAgentSettingsForOrg.mockResolvedValue({
      ciFailureTriageFrequency: 'off',
      managerSlackChannelId: 'C123MANAGER',
    });

    const result = await handleWorkflowRunCompleted(buildPayload());

    expect(result.message).toContain('disabled');
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
  });

  it('skips repositories without a configured environment', async () => {
    mockBuildRepositoryCoverage.mockResolvedValue([
      { repositoryFullName: 'acme/api' },
    ]);

    const result = await handleWorkflowRunCompleted(buildPayload());

    expect(result.message).toContain('no configured environment');
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
  });

  it('debounces repeated failures for the same repository', async () => {
    mockRedisSet.mockResolvedValue(null);

    const result = await handleWorkflowRunCompleted(buildPayload());

    expect(result.message).toContain('debounced');
    expect(mockStartBackgroundAutomationRun).not.toHaveBeenCalled();
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
  });

  it('skips the launch when no active user can resolve credentials', async () => {
    mockDeploymentHasActiveCredentialUser.mockResolvedValue(false);

    const result = await handleWorkflowRunCompleted(buildPayload());

    expect(result.status).toBe('ok');
    expect(result.message).toContain('No active user');
    expect(mockStartBackgroundAutomationRun).not.toHaveBeenCalled();
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
  });

  it('resolves the announcement thread when starting the run record throws', async () => {
    mockStartBackgroundAutomationRun.mockRejectedValue(new Error('db down'));

    const result = await handleWorkflowRunCompleted(buildPayload());

    expect(result.status).toBe('error');
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
    expect(mockCompleteBackgroundAutomationRun).not.toHaveBeenCalled();
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123MANAGER',
        thread_ts: '1781300000.000100',
        text: expect.stringContaining(
          "I couldn't start the investigation for this failure.",
        ),
      }),
    );
  });

  it('records a failed run and resolves the announcement thread when the launch throws', async () => {
    mockEnqueueCloudTask.mockRejectedValue(new Error('enqueue failed'));

    const result = await handleWorkflowRunCompleted(buildPayload());

    expect(result.status).toBe('error');
    expect(mockCompleteBackgroundAutomationRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'failed',
        error: 'enqueue failed',
      }),
    );
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123MANAGER',
        thread_ts: '1781300000.000100',
        text: expect.stringContaining(
          "I couldn't start the investigation for this failure.",
        ),
      }),
    );
  });
});
