const {
  mockDbSelect,
  mockGetAutomationRuntime,
  mockRecordAutomationRunOutcome,
  mockEnqueueTask,
  mockResolveAutomationRuntimeDestination,
  mockListConnectedCommunicationProviders,
  mockBuildDestinationTaskPayloadFields,
  mockIsRunDue,
  mockResolveSlackWorkspaceTimezone,
  mockPostScheduledTriageRoutingDebug,
  mockExecuteFastBuiltInAutomation,
  mockRecordFastPreflightFailure,
} = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockGetAutomationRuntime: vi.fn(),
  mockRecordAutomationRunOutcome: vi.fn(),
  mockEnqueueTask: vi.fn(),
  mockResolveAutomationRuntimeDestination: vi.fn(),
  mockListConnectedCommunicationProviders: vi.fn(),
  mockBuildDestinationTaskPayloadFields: vi.fn(),
  mockIsRunDue: vi.fn(),
  mockResolveSlackWorkspaceTimezone: vi.fn(),
  mockPostScheduledTriageRoutingDebug: vi.fn(),
  mockExecuteFastBuiltInAutomation: vi.fn(),
  mockRecordFastPreflightFailure: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mockEnqueueTask,
}));

vi.mock('@roomote/db/server', () => ({
  db: { select: mockDbSelect },
  eq: vi.fn((...args: unknown[]) => args),
  getAutomationRuntime: mockGetAutomationRuntime,
  recordAutomationRunOutcome: mockRecordAutomationRunOutcome,
  slackInstallations: {
    botAccessToken: 'botAccessToken',
    teamId: 'teamId',
    isActive: 'isActive',
  },
}));

vi.mock('../destination', () => ({
  buildDestinationTaskPayloadFields: mockBuildDestinationTaskPayloadFields,
  listConnectedCommunicationProviders: mockListConnectedCommunicationProviders,
  resolveAutomationRuntimeDestination: mockResolveAutomationRuntimeDestination,
}));

vi.mock('../scheduling-utils', () => ({
  isRunDue: mockIsRunDue,
  resolveSlackWorkspaceTimezone: mockResolveSlackWorkspaceTimezone,
}));

vi.mock('../custom-automation-schedule', () => ({
  resolveDeploymentTimeZone: vi.fn(async () => ({
    timeZone: 'UTC',
    source: 'utc_fallback',
    updatedAt: null,
  })),
}));

vi.mock('../triage-routing-debug', () => ({
  postScheduledTriageRoutingDebug: mockPostScheduledTriageRoutingDebug,
}));

vi.mock('../fast-automation-runner', () => ({
  buildScheduledAutomationOccurrenceKey: vi.fn(() => 'scheduled-slot'),
  executeFastBuiltInAutomation: mockExecuteFastBuiltInAutomation,
  recordFastBuiltInAutomationPreflightFailure: mockRecordFastPreflightFailure,
}));

import { TaskPayloadKind } from '@roomote/types';

import { createScheduledTriageJob } from '../scheduled-triage-runner';

function mockSlackDeployment() {
  const chain = {
    from: () => chain,
    where: () =>
      Promise.resolve([{ botAccessToken: 'xoxb-test', teamId: 'T-1' }]),
  };
  mockDbSelect.mockReturnValue(chain);
}

describe('createScheduledTriageJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSlackDeployment();
    mockGetAutomationRuntime.mockResolvedValue({
      enabled: true,
      scheduleMode: 'daily',
      lastRunAt: null,
      destination: { provider: 'slack', channelId: 'C123MANAGER' },
      instructions: null,
      settings: {},
    });
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'slack',
      channelId: 'C123MANAGER',
    });
    mockBuildDestinationTaskPayloadFields.mockReturnValue({});
    mockIsRunDue.mockReturnValue(true);
    mockResolveSlackWorkspaceTimezone.mockResolvedValue('UTC');
    mockPostScheduledTriageRoutingDebug.mockResolvedValue(undefined);
    mockRecordAutomationRunOutcome.mockResolvedValue(undefined);
    mockExecuteFastBuiltInAutomation.mockResolvedValue({
      acquired: true,
      status: 'skipped',
      automationRunId: 'run-1',
    });
  });

  it('launches one task run per scan payload and reports the first task id', async () => {
    mockEnqueueTask
      .mockResolvedValueOnce({ id: 1, taskId: 'task-ado' })
      .mockResolvedValueOnce({ id: 2, taskId: 'task-bitbucket' });

    const job = createScheduledTriageJob({
      automationKey: 'sentry_triage',
      buildScanTask: async () => ({
        kind: 'scan',
        payloads: [
          { repo: '__all_repositories__', sourceControlProvider: 'ado' },
          { repo: '__all_repositories__', sourceControlProvider: 'bitbucket' },
        ],
      }),
    });

    const result = await job();

    expect(mockEnqueueTask).toHaveBeenCalledTimes(2);
    expect(mockEnqueueTask.mock.calls[0]![0]).toMatchObject({
      task: {
        type: TaskPayloadKind.Scan,
        payload: { sourceControlProvider: 'ado' },
      },
    });
    expect(mockEnqueueTask.mock.calls[1]![0]).toMatchObject({
      task: {
        type: TaskPayloadKind.Scan,
        payload: { sourceControlProvider: 'bitbucket' },
      },
    });
    expect(result.launchedTaskId).toBe('task-ado');
    expect(result.errors).toEqual([]);
    expect(mockRecordAutomationRunOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ key: 'sentry_triage', status: 'succeeded' }),
    );
  });

  it('skips the deployment when the builder returns no payloads', async () => {
    const job = createScheduledTriageJob({
      automationKey: 'sentry_triage',
      buildScanTask: async () => ({ kind: 'scan', payloads: [] }),
    });

    const result = await job();

    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(result.launchedTaskId).toBeNull();
    expect(result.skippedReason).toBe('No scan payloads to launch.');
  });

  it('routes configured read-only pilots through Fast without scan tasks', async () => {
    mockGetAutomationRuntime.mockResolvedValue({
      enabled: true,
      scheduleMode: 'daily',
      lastRunAt: null,
      destination: { provider: 'slack', channelId: 'C123MANAGER' },
      instructions: null,
      settings: {},
      executionRoute: 'fast',
    });
    const fastPolicy = {
      version: 1,
      allowedToolsByIntegration: { sentry: ['search_issues'] },
      maxIntegrationCalls: 5,
      maxIntegrationResponseBytes: 100_000,
      maxChildTasks: 1,
      allowedEnvironmentIds: [],
      reporting: 'on_findings' as const,
      childKickoff: 'silent_allowed' as const,
    };
    const job = createScheduledTriageJob({
      automationKey: 'sentry_triage',
      fastPolicy,
      buildScanTask: async () => ({
        kind: 'scan',
        payloads: [
          {
            repo: '__all_repositories__',
            description: 'Inspect Sentry through Fast.',
          },
        ],
      }),
    });

    const result = await job();

    expect(result.completed).toBe(true);
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockExecuteFastBuiltInAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        automationKey: 'sentry_triage',
        prompt: 'Inspect Sentry through Fast.',
        policy: fastPolicy,
      }),
    );
  });

  it('records Fast preflight failures before execution starts', async () => {
    mockGetAutomationRuntime.mockResolvedValue({
      enabled: true,
      scheduleMode: 'daily',
      lastRunAt: null,
      destination: { provider: 'slack', channelId: 'C123MANAGER' },
      instructions: null,
      settings: {},
      executionRoute: 'fast',
    });
    const fastPolicy = {
      version: 1,
      allowedToolsByIntegration: { sentry: ['search_issues'] },
      maxIntegrationCalls: 5,
      maxIntegrationResponseBytes: 100_000,
      maxChildTasks: 1,
      allowedEnvironmentIds: [],
      reporting: 'on_findings' as const,
      childKickoff: 'silent_allowed' as const,
    };
    const job = createScheduledTriageJob({
      automationKey: 'sentry_triage',
      fastPolicy,
      buildScanTask: async () => {
        throw new Error('scope collector failed');
      },
    });

    const result = await job({ manualTrigger: true });

    expect(result.errors).toEqual(['scope collector failed']);
    expect(mockRecordFastPreflightFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        automationKey: 'sentry_triage',
        error: 'scope collector failed',
      }),
    );
  });

  it('records and reports a missing Sentry connection as a durable blocker', async () => {
    mockGetAutomationRuntime.mockResolvedValue({
      enabled: true,
      scheduleMode: 'daily',
      lastRunAt: null,
      destination: { provider: 'slack', channelId: 'C123MANAGER' },
      instructions: null,
      settings: {},
      executionRoute: 'fast',
    });
    const fastPolicy = {
      version: 1,
      allowedToolsByIntegration: { sentry: ['search_issues'] },
      maxIntegrationCalls: 5,
      maxIntegrationResponseBytes: 100_000,
      maxChildTasks: 1,
      allowedEnvironmentIds: [],
      reporting: 'on_findings' as const,
      childKickoff: 'silent_allowed' as const,
    };
    const job = createScheduledTriageJob({
      automationKey: 'sentry_triage',
      fastPolicy,
      buildScanTask: async () => ({
        kind: 'skip',
        reason: 'Sentry MCP is not configured',
      }),
    });

    const result = await job({ manualTrigger: true });

    expect(result.errors).toEqual(['Sentry MCP is not configured']);
    expect(mockRecordFastPreflightFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Sentry MCP is not configured',
        reportMessage: expect.stringContaining('is not configured'),
      }),
    );
  });
});
