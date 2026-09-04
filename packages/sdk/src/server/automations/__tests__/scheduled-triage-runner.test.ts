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
    mockRecordAutomationRunOutcome.mockResolvedValue(undefined);
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
});
