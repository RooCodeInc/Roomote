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

function mockSlackDeployment(
  rows = [{ botAccessToken: 'xoxb-test', teamId: 'T-1' }],
) {
  const chain = {
    from: () => chain,
    where: () => Promise.resolve(rows),
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
    mockBuildDestinationTaskPayloadFields.mockImplementation(
      (destination: { provider: string; teamId?: string }) =>
        destination.provider === 'slack' && destination.teamId
          ? { teamId: destination.teamId }
          : {},
    );
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

  it.each([false, true])(
    'builds only for the bound Slack owner (manual=%s)',
    async (manualTrigger) => {
      const destination = {
        provider: 'slack' as const,
        channelId: 'C123MANAGER',
        teamId: 'T-2',
        source: 'automation_target' as const,
      };
      mockSlackDeployment([
        { botAccessToken: 'xoxb-wrong', teamId: 'T-1' },
        { botAccessToken: 'xoxb-owner', teamId: 'T-2' },
      ]);
      mockResolveAutomationRuntimeDestination.mockResolvedValue(destination);
      mockEnqueueTask.mockResolvedValue({ taskId: 'task-owner' });
      const buildScanTask = vi.fn(async () => ({
        kind: 'scan' as const,
        payloads: [{ repo: '__all_repositories__' }],
      }));
      const job = createScheduledTriageJob({
        automationKey: 'sentry_triage',
        buildScanTask,
      });

      const result = await job(
        manualTrigger ? { manualTrigger, destination } : {},
      );

      expect(result.errors).toEqual([]);
      expect(result.launchedTaskId).toBe('task-owner');
      expect(mockIsRunDue).toHaveBeenCalledTimes(manualTrigger ? 0 : 1);
      expect(buildScanTask).toHaveBeenCalledTimes(1);
      expect(buildScanTask).toHaveBeenCalledWith(
        expect.objectContaining({
          deployment: { slackBotToken: 'xoxb-owner', slackTeamId: 'T-2' },
          destination,
          manualTrigger,
        }),
      );
      expect(mockEnqueueTask).toHaveBeenCalledTimes(1);
      expect(mockEnqueueTask).toHaveBeenCalledWith(
        expect.objectContaining({
          task: expect.objectContaining({
            payload: expect.objectContaining({ teamId: 'T-2' }),
          }),
          trigger: manualTrigger ? 'manual' : 'schedule',
        }),
      );
      expect(mockRecordAutomationRunOutcome).toHaveBeenCalledTimes(1);
      expect(mockRecordAutomationRunOutcome).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ key: 'sentry_triage', status: 'succeeded' }),
      );
      if (manualTrigger)
        expect(mockResolveAutomationRuntimeDestination).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'skips a missing bound Slack owner before work (manual=%s)',
    async (manualTrigger) => {
      const destination = {
        provider: 'slack' as const,
        channelId: 'C123MANAGER',
        teamId: 'T-2',
        source: 'automation_target' as const,
      };
      mockResolveAutomationRuntimeDestination.mockResolvedValue(destination);
      const buildScanTask = vi.fn(async () => ({
        kind: 'scan' as const,
        payloads: [{ repo: '__all_repositories__' }],
      }));
      const job = createScheduledTriageJob({
        automationKey: 'sentry_triage',
        buildScanTask,
      });

      const result = await job(
        manualTrigger ? { manualTrigger, destination } : {},
      );

      expect(result.errors).toEqual([]);
      expect(result.launchedTaskId).toBeNull();
      expect(mockIsRunDue).not.toHaveBeenCalled();
      expect(buildScanTask).not.toHaveBeenCalled();
      expect(mockBuildDestinationTaskPayloadFields).not.toHaveBeenCalled();
      expect(mockEnqueueTask).not.toHaveBeenCalled();
      expect(mockRecordAutomationRunOutcome).not.toHaveBeenCalled();
    },
  );

  it.each(['slack', 'telegram'] as const)(
    'preserves multi-install behavior for unbound %s destinations',
    async (provider) => {
      mockSlackDeployment([
        { botAccessToken: 'xoxb-first', teamId: 'T-1' },
        { botAccessToken: 'xoxb-second', teamId: 'T-2' },
      ]);
      mockResolveAutomationRuntimeDestination.mockResolvedValue({
        provider,
        channelId: 'channel-1',
      });
      mockEnqueueTask.mockResolvedValue({ taskId: 'task-legacy' });
      const buildScanTask = vi.fn(async () => ({
        kind: 'scan' as const,
        payloads: [{ repo: '__all_repositories__' }],
      }));
      const job = createScheduledTriageJob({
        automationKey: 'sentry_triage',
        buildScanTask,
      });

      await job();

      expect(mockIsRunDue).toHaveBeenCalledTimes(2);
      expect(buildScanTask).toHaveBeenCalledTimes(2);
      expect(mockEnqueueTask).toHaveBeenCalledTimes(2);
      expect(mockRecordAutomationRunOutcome).toHaveBeenCalledTimes(2);
    },
  );
});
