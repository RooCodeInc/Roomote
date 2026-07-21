import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetAutomationRuntime,
  mockRecordAutomationRunOutcome,
  mockListConnectedCommunicationProviders,
  mockResolveAutomationRuntimeDestination,
  mockBuildDestinationTaskPayloadFields,
  mockGetActiveRepositoriesForProviders,
  mockFindEnvironmentIdForRepositoryId,
  mockFindEnvironmentForRepo,
  mockGetLatestGitLabPipeline,
  mockGetGitLabPipelineFailureEvidence,
  mockResolveGitLabInstanceHost,
  mockGetLatestAdoBuild,
  mockGetAdoBuildFailureEvidence,
  mockResolveAdoInstanceHost,
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
  mockFindEnvironmentIdForRepositoryId: vi.fn(),
  mockFindEnvironmentForRepo: vi.fn(),
  mockGetLatestGitLabPipeline: vi.fn(),
  mockGetGitLabPipelineFailureEvidence: vi.fn(),
  mockResolveGitLabInstanceHost: vi.fn(),
  mockGetLatestAdoBuild: vi.fn(),
  mockGetAdoBuildFailureEvidence: vi.fn(),
  mockResolveAdoInstanceHost: vi.fn(),
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
  enqueueTask: mockEnqueueTask,
  findEnvironmentForRepo: mockFindEnvironmentForRepo,
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
  findEnvironmentIdForRepositoryId: mockFindEnvironmentIdForRepositoryId,
}));

vi.mock('@roomote/gitlab', () => ({
  getLatestGitLabPipeline: mockGetLatestGitLabPipeline,
  getGitLabPipelineFailureEvidence: mockGetGitLabPipelineFailureEvidence,
  resolveGitLabInstanceHost: mockResolveGitLabInstanceHost,
  isNestedGitLabPipelineSource: (source: string | null | undefined) => {
    const normalized = source?.trim().toLowerCase();
    return (
      normalized === 'parent_pipeline' ||
      normalized === 'pipeline' ||
      normalized === 'ondemand_dast_scan' ||
      normalized === 'ondemand_dast_validation'
    );
  },
}));

vi.mock('@roomote/ado', () => ({
  getLatestAdoBuild: mockGetLatestAdoBuild,
  getAdoBuildFailureEvidence: mockGetAdoBuildFailureEvidence,
  resolveAdoInstanceHost: mockResolveAdoInstanceHost,
  getAdoBuildWebUrl: (build: {
    id: number;
    url?: string;
    _links?: { web?: { href?: string } };
  }) => build._links?.web?.href ?? build.url ?? `build/${build.id}`,
  stripAdoGitRef: (ref: string | null | undefined) =>
    (ref ?? '').replace(/^refs\/heads\//, '').trim() || '',
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
      {
        id: 'repo-gh-1',
        fullName: 'acme/api',
        sourceControlProvider: 'github',
        externalRepoId: null,
        host: 'github.com',
        defaultBranch: 'main',
      },
    ]);
    mockFindEnvironmentIdForRepositoryId.mockImplementation(
      async (repositoryId: string) => {
        if (repositoryId === 'repo-gh-1') return 'env-api';
        if (repositoryId === 'repo-gl-cloud') return 'env-gl-cloud';
        if (repositoryId === 'repo-gl-self') return 'env-gl-self';
        if (repositoryId === 'repo-gl-1') return 'env-gl';
        if (repositoryId === 'repo-ado-1') return 'env-ado';
        return undefined;
      },
    );
    mockFindEnvironmentForRepo.mockResolvedValue(undefined);
    mockGetLatestGitLabPipeline.mockResolvedValue({
      id: 77,
      name: 'default',
      ref: 'main',
      sha: 'abc123',
      status: 'failed',
      source: 'push',
      web_url: 'https://gitlab.com/acme/gitlab-api/-/pipelines/77',
    });
    mockGetGitLabPipelineFailureEvidence.mockResolvedValue(
      'job="test" id=21\nAssertionError',
    );
    mockResolveGitLabInstanceHost.mockResolvedValue('gitlab.com');
    mockGetLatestAdoBuild.mockResolvedValue({
      id: 88,
      result: 'failed',
      sourceBranch: 'refs/heads/main',
      sourceVersion: 'ado-sha',
      definition: { name: 'CI' },
      _links: {
        web: {
          href: 'https://dev.azure.com/acme/Platform/_build/results?buildId=88',
        },
      },
    });
    mockGetAdoBuildFailureEvidence.mockResolvedValue(
      'task="Test"\nAssertionError',
    );
    mockResolveAdoInstanceHost.mockResolvedValue('dev.azure.com');
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
    expect(mockFindEnvironmentIdForRepositoryId).toHaveBeenCalledWith(
      'repo-gh-1',
    );
    expect(mockTryClaimCiFailureTriageInvestigation).toHaveBeenCalledWith({
      provider: 'github',
      repositoryFullName: 'acme/api',
      repositoryHost: 'github.com',
      fingerprint: 'fp-manual',
      marker: 'manual:acme/api',
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
  });

  it('stamps GitLab provider on the payload for GitLab repos', async () => {
    mockGetActiveRepositoriesForProviders.mockResolvedValue([
      {
        id: 'repo-gl-1',
        fullName: 'acme/gitlab-api',
        sourceControlProvider: 'gitlab',
        externalRepoId: '9001',
        host: 'gitlab.com',
        defaultBranch: 'main',
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
    expect(mockFindEnvironmentIdForRepositoryId).toHaveBeenCalledWith(
      'repo-gl-1',
    );
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            repo: 'acme/gitlab-api',
            environmentId: 'env-gl',
            sourceControlProvider: 'gitlab',
            sourceControlHost: 'gitlab.com',
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it('only inspects GitLab repos on the deployment instance host', async () => {
    // Same-path projects on two instances: the deployment credential belongs
    // to gitlab.example.com, so the gitlab.com row must never be queried with
    // it (project ids are only unique per instance).
    mockResolveGitLabInstanceHost.mockResolvedValue('gitlab.example.com');
    mockGetActiveRepositoriesForProviders.mockResolvedValue([
      {
        id: 'repo-gl-cloud',
        fullName: 'acme/api',
        sourceControlProvider: 'gitlab',
        externalRepoId: '11',
        host: 'gitlab.com',
        defaultBranch: 'main',
      },
      {
        id: 'repo-gl-self',
        fullName: 'acme/api',
        sourceControlProvider: 'gitlab',
        externalRepoId: '22',
        host: 'gitlab.example.com',
        defaultBranch: 'main',
      },
    ]);
    mockGetLatestGitLabPipeline.mockResolvedValueOnce({
      id: 2,
      name: 'default',
      ref: 'main',
      sha: 'self-sha',
      status: 'failed',
      source: 'push',
      web_url: 'https://gitlab.example.com/acme/api/-/pipelines/2',
    });
    mockGetGitLabPipelineFailureEvidence.mockResolvedValue('fail-self');
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'slack',
      channelId: 'C123MANAGER',
      source: 'manager_channel',
    });
    mockBuildDestinationTaskPayloadFields.mockReturnValue({});

    const result = await ciFailureTriageJob({ manualTrigger: true });

    expect(result.launchedTaskId).toBe('task-1');
    expect(mockGetLatestGitLabPipeline).toHaveBeenCalledTimes(1);
    expect(mockGetLatestGitLabPipeline).toHaveBeenCalledWith({
      projectId: '22',
      ref: 'main',
    });
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            repo: 'acme/api',
            environmentId: 'env-gl-self',
            sourceControlProvider: 'gitlab',
            sourceControlHost: 'gitlab.example.com',
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it('skips hostless legacy GitLab rows instead of querying the deployment instance', async () => {
    mockGetActiveRepositoriesForProviders.mockResolvedValue([
      {
        id: 'repo-gl-legacy',
        fullName: 'acme/legacy-api',
        sourceControlProvider: 'gitlab',
        externalRepoId: '33',
        host: null,
        defaultBranch: 'main',
      },
    ]);
    mockFindEnvironmentIdForRepositoryId.mockResolvedValue('env-gl-legacy');
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'slack',
      channelId: 'C123MANAGER',
      source: 'manager_channel',
    });

    const result = await ciFailureTriageJob({ manualTrigger: true });

    expect(result.launchedTaskId).toBeNull();
    expect(mockGetLatestGitLabPipeline).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('skips GitLab manual Run now when the latest pipeline is green', async () => {
    mockGetActiveRepositoriesForProviders.mockResolvedValue([
      {
        id: 'repo-gl-1',
        fullName: 'acme/gitlab-api',
        sourceControlProvider: 'gitlab',
        externalRepoId: '9001',
        host: 'gitlab.com',
        defaultBranch: 'main',
      },
    ]);
    mockGetLatestGitLabPipeline.mockResolvedValue({
      id: 77,
      name: 'default',
      ref: 'main',
      sha: 'abc123',
      status: 'success',
      source: 'push',
      web_url: 'https://gitlab.com/acme/gitlab-api/-/pipelines/77',
    });
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'slack',
      channelId: 'C123MANAGER',
      source: 'manager_channel',
    });

    const result = await ciFailureTriageJob({ manualTrigger: true });

    expect(result.launchedTaskId).toBeNull();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('skips GitLab manual Run now when the latest failed pipeline is nested/child', async () => {
    mockGetActiveRepositoriesForProviders.mockResolvedValue([
      {
        id: 'repo-gl-1',
        fullName: 'acme/gitlab-api',
        sourceControlProvider: 'gitlab',
        externalRepoId: '9001',
        host: 'gitlab.com',
        defaultBranch: 'main',
      },
    ]);
    mockGetLatestGitLabPipeline.mockResolvedValue({
      id: 88,
      name: 'child',
      ref: 'main',
      sha: 'def456',
      status: 'failed',
      source: 'parent_pipeline',
      web_url: 'https://gitlab.com/acme/gitlab-api/-/pipelines/88',
    });
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'slack',
      channelId: 'C123MANAGER',
      source: 'manager_channel',
    });

    const result = await ciFailureTriageJob({ manualTrigger: true });

    expect(result.launchedTaskId).toBeNull();
    expect(mockGetGitLabPipelineFailureEvidence).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
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
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: { slackChannelId: 'C123MANAGER' },
      }),
      { launchClass: 'automation' },
    );
  });

  it('falls back to fullName environment lookup for GitHub when mapping rows are missing', async () => {
    mockFindEnvironmentIdForRepositoryId.mockResolvedValue(undefined);
    mockFindEnvironmentForRepo.mockResolvedValue('env-from-config');
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'slack',
      channelId: 'C123MANAGER',
      source: 'manager_channel',
    });
    mockBuildDestinationTaskPayloadFields.mockReturnValue({});

    const result = await ciFailureTriageJob({ manualTrigger: true });

    expect(result.launchedTaskId).toBe('task-1');
    expect(mockFindEnvironmentIdForRepositoryId).toHaveBeenCalledWith(
      'repo-gh-1',
    );
    expect(mockFindEnvironmentForRepo).toHaveBeenCalledWith(
      'acme/api',
      undefined,
      'github',
    );
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            repo: 'acme/api',
            environmentId: 'env-from-config',
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it('does not path-fallback for GitLab when repository mapping is missing', async () => {
    mockGetActiveRepositoriesForProviders.mockResolvedValue([
      {
        id: 'repo-gl-1',
        fullName: 'acme/api',
        sourceControlProvider: 'gitlab',
        externalRepoId: '9001',
        host: 'gitlab.example.com',
        defaultBranch: 'main',
      },
    ]);
    mockFindEnvironmentIdForRepositoryId.mockResolvedValue(undefined);
    mockFindEnvironmentForRepo.mockResolvedValue('env-wrong-host');
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'slack',
      channelId: 'C123MANAGER',
      source: 'manager_channel',
    });

    const result = await ciFailureTriageJob({ manualTrigger: true });

    expect(result.launchedTaskId).toBeNull();
    expect(result.skippedReason).toContain('no repositories are covered');
    expect(mockFindEnvironmentForRepo).not.toHaveBeenCalled();
    expect(mockGetLatestGitLabPipeline).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('stamps Azure DevOps provider on the payload for ADO repos with failed builds', async () => {
    mockGetActiveRepositoriesForProviders.mockResolvedValue([
      {
        id: 'repo-ado-1',
        fullName: 'acme/Platform/backend',
        sourceControlProvider: 'ado',
        externalRepoId: 'repo-guid-1',
        host: 'dev.azure.com',
        defaultBranch: 'main',
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
    expect(mockGetLatestAdoBuild).toHaveBeenCalledWith({
      repositoryFullName: 'acme/Platform/backend',
      repositoryId: 'repo-guid-1',
      branch: 'main',
    });
    expect(mockBuildCiFailureTriagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceControlProvider: 'ado',
        triggeringRun: expect.objectContaining({
          provider: 'ado',
          workflowName: 'CI',
          headSha: 'ado-sha',
          failureEvidence: 'task="Test"\nAssertionError',
        }),
      }),
    );
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            repo: 'acme/Platform/backend',
            environmentId: 'env-ado',
            sourceControlProvider: 'ado',
            sourceControlHost: 'dev.azure.com',
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it('skips Azure DevOps manual Run now when the latest build is green', async () => {
    mockGetActiveRepositoriesForProviders.mockResolvedValue([
      {
        id: 'repo-ado-1',
        fullName: 'acme/Platform/backend',
        sourceControlProvider: 'ado',
        externalRepoId: 'repo-guid-1',
        host: 'dev.azure.com',
        defaultBranch: 'main',
      },
    ]);
    mockGetLatestAdoBuild.mockResolvedValue({
      id: 88,
      result: 'succeeded',
      sourceBranch: 'refs/heads/main',
      sourceVersion: 'ado-sha',
      definition: { name: 'CI' },
    });
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'slack',
      channelId: 'C123MANAGER',
      source: 'manager_channel',
    });

    const result = await ciFailureTriageJob({ manualTrigger: true });

    expect(result.launchedTaskId).toBeNull();
    expect(mockGetAdoBuildFailureEvidence).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('skips Azure DevOps repos whose host does not match the deployment instance', async () => {
    mockResolveAdoInstanceHost.mockResolvedValue('dev.azure.com');
    mockGetActiveRepositoriesForProviders.mockResolvedValue([
      {
        id: 'repo-ado-1',
        fullName: 'acme/Platform/backend',
        sourceControlProvider: 'ado',
        externalRepoId: 'repo-guid-1',
        host: 'ado.example.com',
        defaultBranch: 'main',
      },
      {
        id: 'repo-ado-legacy',
        fullName: 'acme/Platform/legacy',
        sourceControlProvider: 'ado',
        externalRepoId: 'repo-guid-legacy',
        host: null,
        defaultBranch: 'main',
      },
    ]);
    mockFindEnvironmentIdForRepositoryId.mockImplementation(
      async (repositoryId: string) => {
        if (repositoryId === 'repo-ado-1') return 'env-ado';
        if (repositoryId === 'repo-ado-legacy') return 'env-ado-legacy';
        return undefined;
      },
    );
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'slack',
      channelId: 'C123MANAGER',
      source: 'manager_channel',
    });

    const result = await ciFailureTriageJob({ manualTrigger: true });

    expect(result.launchedTaskId).toBeNull();
    expect(mockGetLatestAdoBuild).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });
});
