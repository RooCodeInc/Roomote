const {
  mockGetAutomationRuntime,
  mockListConnectedCommunicationProviders,
  mockResolveAutomationRuntimeDestination,
  mockBuildDestinationTaskPayloadFields,
  mockBuildCiFailureTriagePrompt,
  mockBuildRepositoryCoverage,
  mockFindEnvironmentIdForRepositoryId,
  mockFindEnvironmentForRepo,
  mockEnqueueTask,
  mockGetTaskUrl,
  mockRecordAutomationRunOutcome,
  mockUpsertBackgroundAutomationSlackThread,
  mockUpdateBackgroundAutomationSlackThreadMetadata,
  mockTryClaimCiFailureTriageInvestigation,
  mockReleaseCiFailureTriageInvestigation,
  mockRedisSet,
  mockPostMessage,
  mockUpdateMessage,
  mockDbSelect,
} = vi.hoisted(() => ({
  mockGetAutomationRuntime: vi.fn(),
  mockListConnectedCommunicationProviders: vi.fn(),
  mockResolveAutomationRuntimeDestination: vi.fn(),
  mockBuildDestinationTaskPayloadFields: vi.fn(() => ({})),
  mockBuildCiFailureTriagePrompt: vi.fn(),
  mockBuildRepositoryCoverage: vi.fn(),
  mockFindEnvironmentIdForRepositoryId: vi.fn(),
  mockFindEnvironmentForRepo: vi.fn(),
  mockEnqueueTask: vi.fn(),
  mockGetTaskUrl: vi.fn(
    ({ taskId }: { taskId: string }) =>
      `https://app.example.com/task/${taskId}?utm_source=slack&utm_medium=link&utm_campaign=slack.thread_reply`,
  ),
  mockRecordAutomationRunOutcome: vi.fn(),
  mockUpsertBackgroundAutomationSlackThread: vi.fn(),
  mockUpdateBackgroundAutomationSlackThreadMetadata: vi.fn(),
  mockTryClaimCiFailureTriageInvestigation: vi.fn(),
  mockReleaseCiFailureTriageInvestigation: vi.fn(),
  mockRedisSet: vi.fn(),
  mockPostMessage: vi.fn(),
  mockUpdateMessage: vi.fn(),
  mockDbSelect: vi.fn(),
}));

vi.mock('../destination', () => ({
  listConnectedCommunicationProviders: mockListConnectedCommunicationProviders,
  resolveAutomationRuntimeDestination: mockResolveAutomationRuntimeDestination,
  buildDestinationTaskPayloadFields: mockBuildDestinationTaskPayloadFields,
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    set: mockRedisSet,
  }),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildCiFailureTriagePrompt: (...args: unknown[]) =>
    mockBuildCiFailureTriagePrompt(...args),
  enqueueTask: mockEnqueueTask,
  findEnvironmentForRepo: mockFindEnvironmentForRepo,
  getTaskUrl: mockGetTaskUrl,
  buildCiFailureTriageFingerprint: (params: {
    repositoryFullName: string;
    workflowName: string;
    headBranch: string;
    repositoryHost?: string | null;
    provider?: string;
  }) =>
    [
      params.provider !== 'github'
        ? params.repositoryHost?.trim().toLowerCase()
        : undefined,
      params.repositoryFullName,
      params.workflowName,
      params.headBranch,
    ]
      .filter(Boolean)
      .join('::'),
  buildCiFailureTriageDebounceKey: (params: {
    provider: string;
    repositoryId: string;
  }) => `ci-failure-triage:${params.provider}:debounce:${params.repositoryId}`,
  tryClaimCiFailureTriageInvestigation:
    mockTryClaimCiFailureTriageInvestigation,
  releaseCiFailureTriageInvestigation: mockReleaseCiFailureTriageInvestigation,
}));

vi.mock('../github-deployment-scope', () => ({
  findEnvironmentIdForRepositoryId: mockFindEnvironmentIdForRepositoryId,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: mockDbSelect,
  },
  eq: vi.fn((left: unknown, right: unknown) => [left, right]),
  getAutomationRuntime: mockGetAutomationRuntime,
  recordAutomationRunOutcome: mockRecordAutomationRunOutcome,
  upsertBackgroundAutomationSlackThread:
    mockUpsertBackgroundAutomationSlackThread,
  updateBackgroundAutomationSlackThreadMetadata:
    mockUpdateBackgroundAutomationSlackThreadMetadata,
  slackInstallations: {
    botAccessToken: 'slackInstallations.botAccessToken',
    isActive: 'slackInstallations.isActive',
  },
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: class {
    postMessage = (...args: unknown[]) => mockPostMessage(...args);
    getMessageBlocks = vi.fn().mockResolvedValue([
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
    ]);
    updateMessage = (...args: unknown[]) => mockUpdateMessage(...args);
  },
  buildAutomationRootFooterBlocks: () => [
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
  ],
  refreshAutomationRootFooter: async (params: {
    slack: { updateMessage: (...args: unknown[]) => unknown };
    channelId: string;
    messageTs: string;
    automationLabel: string;
    taskUrl: string;
  }) => {
    await params.slack.updateMessage({
      channel: params.channelId,
      ts: params.messageTs,
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
                url: params.taskUrl,
              },
            ],
          },
        ],
      },
    });
  },
}));

const mockGetCommunicationProviderAdapter = vi.hoisted(() => vi.fn());

vi.mock('../../lib/communication-providers', () => ({
  getCommunicationProviderAdapter: mockGetCommunicationProviderAdapter,
}));

import { TaskPayloadKind } from '@roomote/types';

import { launchCiFailureTriageForFailedRun } from '../ci-failure-triage-launch';

const failedRun = {
  provider: 'github' as const,
  repositoryId: 'repo-row-1',
  repositoryFullName: 'acme/api',
  externalRepoId: '9001',
  defaultBranch: 'main',
  headBranch: 'main',
  headSha: 'abc123',
  workflowOrPipelineName: 'CI',
  runId: '42',
  runUrl: 'https://github.com/acme/api/actions/runs/42',
};

describe('launchCiFailureTriageForFailedRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetAutomationRuntime.mockResolvedValue({
      enabled: true,
      scheduleMode: 'daily',
      destination: {
        provider: 'slack',
        channelId: 'C123MANAGER',
        source: 'automation_target',
      },
    });
    mockListConnectedCommunicationProviders.mockResolvedValue(['slack']);
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'slack',
      channelId: 'C123MANAGER',
      source: 'automation_target',
    });
    mockBuildRepositoryCoverage.mockResolvedValue([
      { repositoryFullName: 'acme/api', targetEnvironmentId: 'env-api' },
    ]);
    mockFindEnvironmentIdForRepositoryId.mockResolvedValue(undefined);
    mockFindEnvironmentForRepo.mockResolvedValue('env-api');
    mockRedisSet.mockResolvedValue('OK');
    mockTryClaimCiFailureTriageInvestigation.mockResolvedValue(true);
    mockReleaseCiFailureTriageInvestigation.mockResolvedValue(undefined);
    mockDbSelect.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ botAccessToken: 'xoxb-test' }],
        }),
      }),
    }));
    mockPostMessage.mockResolvedValue('1781300000.000100');
    mockUpdateMessage.mockResolvedValue(true);
    mockUpsertBackgroundAutomationSlackThread.mockResolvedValue(undefined);
    mockUpdateBackgroundAutomationSlackThreadMetadata.mockResolvedValue(true);
    mockRecordAutomationRunOutcome.mockResolvedValue(undefined);
    mockEnqueueTask.mockResolvedValue({
      success: true,
      runId: 7,
      taskId: 'task-scan-1',
    });
    mockGetCommunicationProviderAdapter.mockResolvedValue(null);
    mockBuildCiFailureTriagePrompt.mockImplementation(
      (params: {
        trigger: string;
        triggeringRun?: { runUrl: string } | null;
        hasAnnouncementThread?: boolean;
      }) =>
        `$ci-failure-triage trigger=${params.trigger} run=${params.triggeringRun?.runUrl ?? 'none'} announced=${params.hasAnnouncementThread === true}`,
    );
  });

  it('launches one environment-backed investigate-and-fix task', async () => {
    const result = await launchCiFailureTriageForFailedRun(failedRun);

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
    expect(mockTryClaimCiFailureTriageInvestigation).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'github',
        repositoryFullName: 'acme/api',
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
      }),
    );
    expect(mockUpdateMessage).toHaveBeenCalled();
    expect(mockUpsertBackgroundAutomationSlackThread).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        automationKey: 'ci_failure_triage',
        slackChannelId: 'C123MANAGER',
        threadTs: '1781300000.000100',
      }),
    );
    expect(
      mockUpdateBackgroundAutomationSlackThreadMetadata,
    ).toHaveBeenCalledWith(expect.anything(), {
      surface: 'slack',
      slackChannelId: 'C123MANAGER',
      threadTs: '1781300000.000100',
      metadata: { sourceTaskId: 'task-scan-1' },
    });
  });

  it('still launches without a thread when the announcement fails', async () => {
    mockPostMessage.mockRejectedValue(new Error('slack down'));

    const result = await launchCiFailureTriageForFailedRun(failedRun);

    expect(result.status).toBe('ok');
    const payload = mockEnqueueTask.mock.calls[0]?.[0].task.payload;
    expect(payload.thread_ts).toBeUndefined();
    expect(payload.slackChannel).toBeUndefined();
    expect(payload.environmentId).toBe('env-api');
    expect(payload.description).toContain('announced=false');
    expect(mockUpsertBackgroundAutomationSlackThread).not.toHaveBeenCalled();
    expect(mockUpdateMessage).not.toHaveBeenCalled();
  });

  it.each([
    [
      'returns false',
      () =>
        mockUpdateBackgroundAutomationSlackThreadMetadata.mockResolvedValue(
          false,
        ),
    ],
    [
      'throws',
      () =>
        mockUpdateBackgroundAutomationSlackThreadMetadata.mockRejectedValue(
          new Error('metadata unavailable'),
        ),
    ],
  ])(
    'keeps the launched investigation active when metadata linking %s',
    async (_scenario, arrange) => {
      arrange();

      await expect(
        launchCiFailureTriageForFailedRun(failedRun),
      ).resolves.toEqual(
        expect.objectContaining({ status: 'ok', taskId: 'task-scan-1' }),
      );

      expect(mockReleaseCiFailureTriageInvestigation).not.toHaveBeenCalled();
      expect(mockRecordAutomationRunOutcome).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: 'succeeded' }),
      );
      expect(mockRecordAutomationRunOutcome).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: 'failed' }),
      );
    },
  );

  it('preserves GitLab host and failure evidence in the launched task', async () => {
    mockFindEnvironmentIdForRepositoryId.mockResolvedValue('env-gl');

    await launchCiFailureTriageForFailedRun({
      ...failedRun,
      provider: 'gitlab',
      repositoryHost: 'gitlab.example.com',
      runUrl: 'https://gitlab.example.com/acme/api/-/pipelines/42',
      failureEvidence: 'job="test" id=21\nAssertionError',
    });

    const payload = mockEnqueueTask.mock.calls[0]?.[0].task.payload;
    expect(payload.sourceControlProvider).toBe('gitlab');
    expect(payload.sourceControlHost).toBe('gitlab.example.com');
    expect(payload.environmentId).toBe('env-gl');
    expect(mockFindEnvironmentForRepo).not.toHaveBeenCalled();
    expect(mockBuildCiFailureTriagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        triggeringRun: expect.objectContaining({
          provider: 'gitlab',
          failureEvidence: 'job="test" id=21\nAssertionError',
        }),
      }),
    );
  });

  it('skips when the investigation claim is held', async () => {
    mockTryClaimCiFailureTriageInvestigation.mockResolvedValue(false);

    const result = await launchCiFailureTriageForFailedRun(failedRun);

    expect(result.status).toBe('ok');
    expect(result.message).toContain('already has an active task');
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('releases investigation claims when enqueue fails', async () => {
    mockEnqueueTask.mockRejectedValue(new Error('enqueue failed'));

    await launchCiFailureTriageForFailedRun(failedRun);

    expect(mockReleaseCiFailureTriageInvestigation).toHaveBeenCalledWith({
      provider: 'github',
      repositoryFullName: 'acme/api',
      repositoryHost: undefined,
      fingerprint: 'acme/api::CI::main',
    });
  });

  it('skips when automation is disabled', async () => {
    mockGetAutomationRuntime.mockResolvedValue({
      enabled: false,
      scheduleMode: 'off',
      destination: null,
    });

    const result = await launchCiFailureTriageForFailedRun(failedRun);

    expect(result.message).toContain('disabled');
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('skips repositories without a configured environment', async () => {
    mockBuildRepositoryCoverage.mockResolvedValue([
      { repositoryFullName: 'acme/api' },
    ]);
    mockFindEnvironmentIdForRepositoryId.mockResolvedValue(undefined);
    mockFindEnvironmentForRepo.mockResolvedValue(undefined);

    const result = await launchCiFailureTriageForFailedRun(failedRun);

    expect(result.message).toContain('no configured environment');
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('prefers repository-id environment mapping over fullName lookup', async () => {
    mockFindEnvironmentIdForRepositoryId.mockResolvedValue('env-from-mapping');
    mockFindEnvironmentForRepo.mockResolvedValue('env-from-fullname');

    const result = await launchCiFailureTriageForFailedRun(failedRun);

    expect(result.status).toBe('ok');
    expect(mockFindEnvironmentIdForRepositoryId).toHaveBeenCalledWith(
      'repo-row-1',
    );
    expect(mockFindEnvironmentForRepo).not.toHaveBeenCalled();
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            environmentId: 'env-from-mapping',
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it('falls back to fullName environment lookup when mapping is missing', async () => {
    mockFindEnvironmentIdForRepositoryId.mockResolvedValue(undefined);
    mockFindEnvironmentForRepo.mockResolvedValue('env-from-config');

    const result = await launchCiFailureTriageForFailedRun(failedRun);

    expect(result.status).toBe('ok');
    expect(mockFindEnvironmentForRepo).toHaveBeenCalledWith(
      'acme/api',
      undefined,
      'github',
    );
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            environmentId: 'env-from-config',
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it('does not path-fallback for GitLab when repository mapping is missing', async () => {
    mockFindEnvironmentIdForRepositoryId.mockResolvedValue(undefined);
    mockFindEnvironmentForRepo.mockResolvedValue('env-wrong-host');

    const result = await launchCiFailureTriageForFailedRun({
      ...failedRun,
      provider: 'gitlab',
      repositoryHost: 'gitlab.example.com',
    });

    expect(result.message).toContain('no configured environment');
    expect(mockFindEnvironmentForRepo).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('debounces repeated failures for the same repository', async () => {
    mockRedisSet.mockResolvedValue(null);

    const result = await launchCiFailureTriageForFailedRun(failedRun);

    expect(result.message).toContain('debounced');
    expect(mockRecordAutomationRunOutcome).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('records failure and resolves announcement thread when launch throws', async () => {
    mockEnqueueTask.mockRejectedValue(new Error('enqueue failed'));

    const result = await launchCiFailureTriageForFailedRun(failedRun);

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

  it('uses multi-comms destination fields for non-Slack destinations', async () => {
    mockListConnectedCommunicationProviders.mockResolvedValue(['discord']);
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'discord',
      channelId: 'D999',
      source: 'primary_conversation',
    });
    mockBuildDestinationTaskPayloadFields.mockReturnValue({
      communicationProvider: 'discord',
      communicationChannelId: 'D999',
    });

    const postMessage = vi.fn().mockResolvedValue({ messageId: 'msg-1' });
    mockGetCommunicationProviderAdapter.mockResolvedValue({
      provider: 'discord',
      postMessage,
    });

    const result = await launchCiFailureTriageForFailedRun(failedRun);

    expect(result.status).toBe('ok');
    const payload = mockEnqueueTask.mock.calls[0]?.[0].task.payload;
    expect(payload.communicationProvider).toBe('discord');
    expect(payload.communicationChannelId).toBe('D999');
    expect(payload.communicationMessageId).toBe('msg-1');
    expect(payload.communicationThreadId).toBeUndefined();
    expect(payload.channel).toBeUndefined();
    expect(payload.description).toContain('announced=true');
  });

  it('stamps Teams announcement ids on the payload for reply routing', async () => {
    mockListConnectedCommunicationProviders.mockResolvedValue(['teams']);
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'teams',
      channelId: '19:teams@thread.tacv2',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      source: 'primary_conversation',
    });
    mockBuildDestinationTaskPayloadFields.mockReturnValue({
      communicationProvider: 'teams',
      communicationChannelId: '19:teams@thread.tacv2',
      communicationServiceUrl: 'https://smba.trafficmanager.net/amer/',
    });

    mockGetCommunicationProviderAdapter.mockResolvedValue({
      provider: 'teams',
      postMessage: vi.fn().mockResolvedValue({ messageId: 'activity-root' }),
    });

    await launchCiFailureTriageForFailedRun(failedRun);

    const payload = mockEnqueueTask.mock.calls[0]?.[0].task.payload;
    expect(payload.communicationMessageId).toBe('activity-root');
    expect(payload.communicationThreadId).toBe('activity-root');
  });

  it('replies to Discord announcements with replyToMessageId, not threadId', async () => {
    mockListConnectedCommunicationProviders.mockResolvedValue(['discord']);
    mockResolveAutomationRuntimeDestination.mockResolvedValue({
      provider: 'discord',
      channelId: 'D999',
      source: 'primary_conversation',
    });
    mockBuildDestinationTaskPayloadFields.mockReturnValue({
      communicationProvider: 'discord',
      communicationChannelId: 'D999',
    });
    mockEnqueueTask.mockRejectedValue(new Error('enqueue failed'));

    const postMessage = vi
      .fn()
      .mockResolvedValueOnce({ messageId: 'opener-1' })
      .mockResolvedValueOnce({ messageId: 'recovery-1' });
    mockGetCommunicationProviderAdapter.mockResolvedValue({
      provider: 'discord',
      postMessage,
    });

    await launchCiFailureTriageForFailedRun(failedRun);

    expect(postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channelId: 'D999',
        replyToMessageId: 'opener-1',
        text: expect.stringContaining(
          "I couldn't start the investigation for this failure.",
        ),
      }),
    );
    expect(postMessage.mock.calls[1]?.[0]).not.toHaveProperty('threadId');
  });
});
