import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetAutomationRuntime,
  mockRecordAutomationRunOutcome,
  mockListConnectedCommunicationProviders,
  mockResolveAutomationRuntimeDestination,
  mockBuildDestinationTaskPayloadFields,
  mockGetActiveRepositoriesForProviders,
  mockBuildRepositoryCoverage,
  mockGetEnvironmentBackedCoverage,
  mockTryClaimCiFailureTriageInvestigation,
  mockReleaseCiFailureTriageInvestigation,
  mockBuildCiFailureTriageFingerprint,
  mockBuildCiFailureTriagePrompt,
  mockEnqueueTask,
} = vi.hoisted(() => ({
  mockGetAutomationRuntime: vi.fn(),
  mockRecordAutomationRunOutcome: vi.fn(),
  mockListConnectedCommunicationProviders: vi.fn(),
  mockResolveAutomationRuntimeDestination: vi.fn(),
  mockBuildDestinationTaskPayloadFields: vi.fn(),
  mockGetActiveRepositoriesForProviders: vi.fn(),
  mockBuildRepositoryCoverage: vi.fn(),
  mockGetEnvironmentBackedCoverage: vi.fn(),
  mockTryClaimCiFailureTriageInvestigation: vi.fn(),
  mockReleaseCiFailureTriageInvestigation: vi.fn(),
  mockBuildCiFailureTriageFingerprint: vi.fn(),
  mockBuildCiFailureTriagePrompt: vi.fn(),
  mockEnqueueTask: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  getAutomationRuntime: mockGetAutomationRuntime,
  recordAutomationRunOutcome: mockRecordAutomationRunOutcome,
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildCiFailureTriageFingerprint: mockBuildCiFailureTriageFingerprint,
  buildCiFailureTriagePrompt: mockBuildCiFailureTriagePrompt,
  buildRepositoryCoverage: mockBuildRepositoryCoverage,
  enqueueTask: mockEnqueueTask,
  getEnvironmentBackedCoverage: mockGetEnvironmentBackedCoverage,
  releaseCiFailureTriageInvestigation: mockReleaseCiFailureTriageInvestigation,
  tryClaimCiFailureTriageInvestigation:
    mockTryClaimCiFailureTriageInvestigation,
}));

vi.mock('../destination', () => ({
  buildDestinationTaskPayloadFields: mockBuildDestinationTaskPayloadFields,
  listConnectedCommunicationProviders: mockListConnectedCommunicationProviders,
  resolveAutomationRuntimeDestination: mockResolveAutomationRuntimeDestination,
}));

vi.mock('../github-deployment-scope', () => ({
  getActiveRepositoriesForProviders: mockGetActiveRepositoriesForProviders,
}));

import { ciFailureTriageJob } from '../ci-failure-triage';

describe('ciFailureTriageJob multi-comms destinations', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetAutomationRuntime.mockResolvedValue({
      enabled: true,
      scheduleMode: 'daily',
      destination: null,
    });
    mockListConnectedCommunicationProviders.mockResolvedValue(['teams']);
    mockGetActiveRepositoriesForProviders.mockResolvedValue([
      { fullName: 'acme/api', sourceControlProvider: 'github' },
    ]);
    mockBuildRepositoryCoverage.mockResolvedValue([
      {
        repositoryFullName: 'acme/api',
        targetEnvironmentId: 'env-api',
      },
    ]);
    mockGetEnvironmentBackedCoverage.mockReturnValue([
      {
        repositoryFullName: 'acme/api',
        targetEnvironmentId: 'env-api',
      },
    ]);
    mockBuildCiFailureTriageFingerprint.mockReturnValue('fp-manual');
    mockTryClaimCiFailureTriageInvestigation.mockResolvedValue(true);
    mockBuildCiFailureTriagePrompt.mockReturnValue('$ci-failure-triage prompt');
    mockBuildDestinationTaskPayloadFields.mockReturnValue({
      communicationProvider: 'teams',
      communicationChannelId: '19:teams-channel@thread.tacv2',
      communicationServiceUrl: 'https://smba.trafficmanager.net/amer/',
    });
    mockEnqueueTask.mockResolvedValue({ taskId: 'task-1' });
    mockRecordAutomationRunOutcome.mockResolvedValue(undefined);
  });

  it('resolves a Teams destination without skipping and launches with destination payload fields', async () => {
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'teams',
      channelId: '19:teams-channel@thread.tacv2',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      source: 'manager_channel',
    });

    const result = await ciFailureTriageJob({ manualTrigger: true });

    expect(result.skippedReason).toBeNull();
    expect(result.launchedTaskId).toBe('task-1');
    expect(result.errors).toEqual([]);

    expect(mockListConnectedCommunicationProviders).toHaveBeenCalled();
    expect(mockGetActiveRepositoriesForProviders).toHaveBeenCalledWith([
      'github',
      'gitlab',
    ]);
    expect(mockResolveAutomationRuntimeDestination).toHaveBeenCalledWith({
      runtime: expect.objectContaining({ enabled: true }),
      slackConnected: false,
    });
    expect(mockBuildDestinationTaskPayloadFields).toHaveBeenCalledWith({
      provider: 'teams',
      channelId: '19:teams-channel@thread.tacv2',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      source: 'manager_channel',
    });
    expect(mockTryClaimCiFailureTriageInvestigation).toHaveBeenCalledWith({
      provider: 'github',
      repositoryFullName: 'acme/api',
      fingerprint: 'fp-manual',
      marker: 'manual:acme/api',
    });
    expect(mockBuildCiFailureTriagePrompt).toHaveBeenCalledWith({
      channelId: '19:teams-channel@thread.tacv2',
      repositoryFullNames: ['acme/api'],
      repositoryCoverage: [
        {
          repositoryFullName: 'acme/api',
          targetEnvironmentId: 'env-api',
        },
      ],
      trigger: 'manual',
      destinationProvider: 'teams',
      sourceControlProvider: 'github',
    });
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      {
        task: {
          type: 'standard',
          payload: {
            repo: 'acme/api',
            environmentId: 'env-api',
            selectedRepositories: ['acme/api'],
            description: '$ci-failure-triage prompt',
            communicationProvider: 'teams',
            communicationChannelId: '19:teams-channel@thread.tacv2',
            communicationServiceUrl: 'https://smba.trafficmanager.net/amer/',
            visibleInTranscript: false,
          },
        },
        initiator: { kind: 'automation', key: 'ci_failure_triage' },
        workflow: 'standard',
        surface: 'system',
        trigger: 'manual',
        visibility: 'hidden',
      },
      { launchClass: 'automation' },
    );
    expect(mockEnqueueTask.mock.calls[0]?.[0]).not.toHaveProperty('channels');
  });

  it('stamps GitLab provider on the payload for GitLab repos', async () => {
    mockGetActiveRepositoriesForProviders.mockResolvedValue([
      { fullName: 'acme/gitlab-api', sourceControlProvider: 'gitlab' },
    ]);
    mockBuildRepositoryCoverage.mockResolvedValue([
      {
        repositoryFullName: 'acme/gitlab-api',
        targetEnvironmentId: 'env-gl',
      },
    ]);
    mockGetEnvironmentBackedCoverage.mockReturnValue([
      {
        repositoryFullName: 'acme/gitlab-api',
        targetEnvironmentId: 'env-gl',
      },
    ]);
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'slack',
      channelId: 'C123MANAGER',
      source: 'manager_channel',
    });
    mockBuildDestinationTaskPayloadFields.mockReturnValue({});

    const result = await ciFailureTriageJob({ manualTrigger: true });

    expect(result.launchedTaskId).toBe('task-1');
    expect(mockTryClaimCiFailureTriageInvestigation).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gitlab',
        repositoryFullName: 'acme/gitlab-api',
      }),
    );
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            repo: 'acme/gitlab-api',
            sourceControlProvider: 'gitlab',
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it('still stamps channels.slackChannelId for Slack destinations', async () => {
    mockListConnectedCommunicationProviders.mockResolvedValue(['slack']);
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'slack',
      channelId: 'C123MANAGER',
      source: 'manager_channel',
    });
    mockBuildDestinationTaskPayloadFields.mockReturnValue({});

    const result = await ciFailureTriageJob({ manualTrigger: true });

    expect(result.launchedTaskId).toBe('task-1');
    expect(mockResolveAutomationRuntimeDestination).toHaveBeenCalledWith({
      runtime: expect.objectContaining({ enabled: true }),
      slackConnected: true,
    });
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: { slackChannelId: 'C123MANAGER' },
      }),
      { launchClass: 'automation' },
    );
  });

  it('keeps the Slack-only skip path removed (does not use the old reason string)', async () => {
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'telegram',
      channelId: '-100123',
      source: 'primary_conversation',
    });
    mockBuildDestinationTaskPayloadFields.mockReturnValue({
      communicationProvider: 'telegram',
      communicationChannelId: '-100123',
    });

    const result = await ciFailureTriageJob({ manualTrigger: true });

    expect(result.skippedReason).not.toBe(
      'CI failure triage reports to Slack only for now.',
    );
    expect(result.launchedTaskId).toBe('task-1');
    expect(mockEnqueueTask).toHaveBeenCalled();
  });
});
