const {
  mockDbSelect,
  mockEnqueueTask,
  mockBuildRepositoryCoverage,
  mockGetBackgroundAgentSettingsForOrg,
  mockEvaluateFeatureFlag,
  mockRecordAutomationRunOutcome,
  mockUpsertBackgroundAutomationSlackThread,
  mockResolveAutomationSlackTarget,
  mockPostMessage,
  mockUpdateMessage,
  mockRedisSet,
} = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockEnqueueTask: vi.fn(),
  mockBuildRepositoryCoverage: vi.fn(),
  mockGetBackgroundAgentSettingsForOrg: vi.fn(),
  mockEvaluateFeatureFlag: vi.fn(),
  mockRecordAutomationRunOutcome: vi.fn(),
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
    automationKey: 'ci_failure_triage',
  })),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    set: (...args: unknown[]) => mockRedisSet(...args),
  }),
}));

const mockTryClaimCiFailureTriageInvestigation = vi.hoisted(() => vi.fn());
const mockReleaseCiFailureTriageInvestigation = vi.hoisted(() => vi.fn());

vi.mock('@roomote/cloud-agents/server', () => ({
  buildCiFailureTriagePrompt: (params: {
    trigger: string;
    triggeringRun?: { runUrl: string } | null;
    hasAnnouncementThread?: boolean;
  }) =>
    `$ci-failure-triage trigger=${params.trigger} run=${params.triggeringRun?.runUrl ?? 'none'} announced=${params.hasAnnouncementThread === true}`,
  buildRepositoryCoverage: (...args: unknown[]) =>
    mockBuildRepositoryCoverage(...args),
  enqueueTask: (...args: unknown[]) => mockEnqueueTask(...args),
  getTaskUrl: ({ taskId }: { taskId: string }) =>
    `https://app.example.com/task/${taskId}?utm_source=slack&utm_medium=link&utm_campaign=slack.thread_reply`,
  buildCiFailureTriageFingerprint: (params: {
    repositoryFullName: string;
    workflowName: string;
    headBranch: string;
  }) =>
    `${params.repositoryFullName}::${params.workflowName}::${params.headBranch}`,
  tryClaimCiFailureTriageInvestigation: (...args: unknown[]) =>
    mockTryClaimCiFailureTriageInvestigation(...args),
  releaseCiFailureTriageInvestigation: (...args: unknown[]) =>
    mockReleaseCiFailureTriageInvestigation(...args),
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
  recordAutomationRunOutcome: (...args: unknown[]) =>
    mockRecordAutomationRunOutcome(...args),
  upsertBackgroundAutomationSlackThread: (...args: unknown[]) =>
    mockUpsertBackgroundAutomationSlackThread(...args),
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((left: unknown, right: unknown) => [left, right]),
}));

import { TaskPayloadKind } from '@roomote/types';
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
    mockGetBackgroundAgentSettingsForOrg.mockResolvedValue({
      ciFailureTriageFrequency: 'daily',
      ciFailureTriageSlackChannelId: 'C123MANAGER',
    });
    mockBuildRepositoryCoverage.mockResolvedValue([
      { repositoryFullName: 'acme/api', targetEnvironmentId: 'env-api' },
    ]);
    mockRedisSet.mockResolvedValue('OK');
    mockTryClaimCiFailureTriageInvestigation.mockResolvedValue(true);
    mockReleaseCiFailureTriageInvestigation.mockResolvedValue(undefined);
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
    mockRecordAutomationRunOutcome.mockResolvedValue(undefined);
    mockEnqueueTask.mockResolvedValue({
      success: true,
      runId: 7,
      taskId: 'task-scan-1',
    });
  });

  it('launches one environment-backed investigate-and-fix task for a default-branch failure', async () => {
    const result = await handleWorkflowRunCompleted(buildPayload());

    expect(result.status).toBe('ok');
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
          payload: expect.objectContaining({
            repo: 'acme/api',
            environmentId: 'env-api',
            selectedRepositories: ['acme/api'],
            channel: 'C123MANAGER',
            slackChannel: 'C123MANAGER',
            thread_ts: '1781300000.000100',
            slackThreadTs: '1781300000.000100',
            description: expect.stringContaining(
              'run=https://github.com/acme/api/actions/runs/42',
            ),
          }),
        }),
        initiator: { kind: 'automation', key: 'ci_failure_triage' },
        workflow: 'standard',
        surface: 'github',
        trigger: 'webhook',
        visibility: 'hidden',
        channels: {
          slackChannelId: 'C123MANAGER',
          slackThreadTs: '1781300000.000100',
        },
      }),
      expect.objectContaining({
        launchClass: 'automation',
      }),
    );
    expect(mockRecordAutomationRunOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        key: 'ci_failure_triage',
        status: 'succeeded',
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

  it('still launches the task without a thread when the announcement fails', async () => {
    mockPostMessage.mockRejectedValue(new Error('slack down'));

    const result = await handleWorkflowRunCompleted(buildPayload());

    expect(result.status).toBe('ok');
    const payload = mockEnqueueTask.mock.calls[0]?.[0].task.payload;
    expect(payload.thread_ts).toBeUndefined();
    expect(payload.slackChannel).toBeUndefined();
    expect(payload.environmentId).toBe('env-api');
    expect(payload.description).toContain('announced=false');
    expect(mockUpsertBackgroundAutomationSlackThread).not.toHaveBeenCalled();
    expect(mockUpdateMessage).not.toHaveBeenCalled();
  });

  it('skips silently when the investigation claim is held', async () => {
    mockTryClaimCiFailureTriageInvestigation.mockResolvedValue(false);

    const result = await handleWorkflowRunCompleted(buildPayload());

    expect(result.status).toBe('ok');
    expect(result.message).toContain('already has an active task');
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('releases investigation claims when enqueue fails so retries are not blocked', async () => {
    mockEnqueueTask.mockRejectedValue(new Error('enqueue failed'));

    await handleWorkflowRunCompleted(buildPayload());

    expect(mockReleaseCiFailureTriageInvestigation).toHaveBeenCalledWith({
      repositoryFullName: 'acme/api',
      fingerprint: 'acme/api::CI::main',
    });
  });

  it('ignores successful workflow runs', async () => {
    const result = await handleWorkflowRunCompleted(
      buildPayload({ workflow_run: { conclusion: 'success' } }),
    );

    expect(result.message).toContain('non-failure');
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('ignores failures outside the default branch', async () => {
    const result = await handleWorkflowRunCompleted(
      buildPayload({ workflow_run: { head_branch: 'feature/x' } }),
    );

    expect(result.message).toContain('outside the default branch');
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('skips orgs with the automation disabled', async () => {
    mockGetBackgroundAgentSettingsForOrg.mockResolvedValue({
      ciFailureTriageFrequency: 'off',
      ciFailureTriageSlackChannelId: 'C123MANAGER',
    });

    const result = await handleWorkflowRunCompleted(buildPayload());

    expect(result.message).toContain('disabled');
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('skips repositories without a configured environment', async () => {
    mockBuildRepositoryCoverage.mockResolvedValue([
      { repositoryFullName: 'acme/api' },
    ]);

    const result = await handleWorkflowRunCompleted(buildPayload());

    expect(result.message).toContain('no configured environment');
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('debounces repeated failures for the same repository', async () => {
    mockRedisSet.mockResolvedValue(null);

    const result = await handleWorkflowRunCompleted(buildPayload());

    expect(result.message).toContain('debounced');
    expect(mockRecordAutomationRunOutcome).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('records the failure on the automations row and resolves the announcement thread when the launch throws', async () => {
    mockEnqueueTask.mockRejectedValue(new Error('enqueue failed'));

    const result = await handleWorkflowRunCompleted(buildPayload());

    expect(result.status).toBe('error');
    expect(mockRecordAutomationRunOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        key: 'ci_failure_triage',
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
