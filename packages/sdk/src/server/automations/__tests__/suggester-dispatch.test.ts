const {
  mockEnqueueTask,
  mockLoadAutomationThreadFeedbackReport,
  mockPartitionActiveRepositoriesByProvider,
  mockRecordAutomationRunOutcome,
} = vi.hoisted(() => ({
  mockEnqueueTask: vi.fn(),
  mockLoadAutomationThreadFeedbackReport: vi.fn(),
  mockPartitionActiveRepositoriesByProvider: vi.fn(),
  mockRecordAutomationRunOutcome: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@roomote/cloud-agents/server')>();
  return { ...actual, enqueueTask: mockEnqueueTask };
});

vi.mock('@roomote/db/server', () => ({
  db: {},
  recordAutomationRunOutcome: mockRecordAutomationRunOutcome,
}));

vi.mock('../automation-thread-feedback', () => ({
  loadAutomationThreadFeedbackReport: mockLoadAutomationThreadFeedbackReport,
}));

vi.mock('../github-deployment-scope', () => ({
  partitionActiveRepositoriesByProvider:
    mockPartitionActiveRepositoriesByProvider,
}));

import { buildSuggestedTasksPrompt } from '@roomote/cloud-agents/server';
import { ALL_REPOSITORIES, TaskPayloadKind } from '@roomote/types';

import { dispatchSuggestionScan } from '../suggester-dispatch';

function buildParams() {
  return {
    channelId: 'C123SUGGEST',
    deployment: { slackBotToken: 'xoxb-test', slackTeamId: 'T-1' },
    now: new Date('2026-04-09T03:00:00.000Z'),
    previousSuggestions: [
      {
        title: 'Scope legacy run tokens to their own task',
        brief: 'Legacy run tokens can still reach unrelated task APIs.',
        status: 'open' as const,
      },
    ],
    repositoryCoverage: [
      { repositoryFullName: 'acme/api', targetEnvironmentId: 'env-1' },
    ],
    repositoryFullNames: ['acme/api'],
    suggesterInstructions: 'Prioritize auth and data-loss failures.',
    triggerKind: 'scheduled' as const,
  };
}

describe('dispatchSuggestionScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-09T03:00:00.000Z'));
    mockEnqueueTask.mockResolvedValue({ taskId: 'task-1' });
    mockLoadAutomationThreadFeedbackReport.mockResolvedValue({
      promptText: 'Manager feedback',
    });
    mockPartitionActiveRepositoriesByProvider.mockResolvedValue([
      { provider: 'github', host: null, repositoryFullNames: ['acme/api'] },
    ]);
  });

  afterEach(() => vi.useRealTimers());

  it('enqueues the default destination scan and records success', async () => {
    const result = await dispatchSuggestionScan(buildParams());

    expect(result).toEqual({
      successfulScans: 1,
      firstLaunchedTaskId: 'task-1',
      errors: [],
    });
    expect(mockEnqueueTask).toHaveBeenCalledWith({
      task: {
        type: TaskPayloadKind.Scan,
        payload: {
          repo: ALL_REPOSITORIES,
          selectedRepositories: ['acme/api'],
          sourceControlProvider: 'github',
          teamId: 'T-1',
          description: buildSuggestedTasksPrompt({
            repositoryFullNames: ['acme/api'],
            repositoryCoverage: [
              { repositoryFullName: 'acme/api', targetEnvironmentId: 'env-1' },
            ],
            setupGuidance: null,
            suggesterInstructions: 'Prioritize auth and data-loss failures.',
            previousSuggestions: buildParams().previousSuggestions,
            recentThreadFeedback: 'Manager feedback',
          }),
          trigger: 'scheduled',
          notifySlack: true,
          slackChannel: 'C123SUGGEST',
          suggestionSource: 'suggest_ideas',
          visibleInTranscript: false,
        },
      },
      initiator: { kind: 'automation', key: 'suggester' },
      workflow: 'scan',
      surface: 'system',
      trigger: 'schedule',
      visibility: 'hidden',
      channels: { slackChannelId: 'C123SUGGEST' },
    });
    expect(mockRecordAutomationRunOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ key: 'suggester', status: 'succeeded' }),
    );
  });

  it('launches one stamped scan per source-control partition', async () => {
    mockPartitionActiveRepositoriesByProvider.mockResolvedValue([
      {
        provider: 'bitbucket',
        host: 'bitbucket.org',
        repositoryFullNames: ['acme/api'],
      },
      {
        provider: 'ado',
        host: 'dev.azure.com',
        repositoryFullNames: ['acme/mobile'],
      },
    ]);
    mockEnqueueTask
      .mockResolvedValueOnce({ taskId: 'task-bitbucket' })
      .mockResolvedValueOnce({ taskId: 'task-ado' });

    const result = await dispatchSuggestionScan({
      ...buildParams(),
      repositoryFullNames: ['acme/api', 'acme/mobile'],
      repositoryCoverage: [
        { repositoryFullName: 'acme/api', targetEnvironmentId: 'env-1' },
        { repositoryFullName: 'acme/mobile', targetEnvironmentId: 'env-2' },
      ],
    });

    expect(result.firstLaunchedTaskId).toBe('task-bitbucket');
    expect(mockEnqueueTask).toHaveBeenCalledTimes(2);
    expect(mockEnqueueTask.mock.calls[1]![0].task.payload).toMatchObject({
      selectedRepositories: ['acme/mobile'],
      sourceControlProvider: 'ado',
      sourceControlHost: 'dev.azure.com',
    });
  });

  it('omits Slack metadata for a Telegram destination', async () => {
    await dispatchSuggestionScan({
      ...buildParams(),
      channelId: '-100123',
      destinationPayloadFields: {
        communicationProvider: 'telegram',
        communicationChannelId: '-100123',
      },
    });

    const enqueueArg = mockEnqueueTask.mock.calls[0]![0] as {
      task: { payload: Record<string, unknown> };
      channels?: { slackChannelId?: string };
    };
    expect(enqueueArg.task.payload.slackChannel).toBeUndefined();
    expect(enqueueArg.channels).toBeUndefined();
  });

  it('records failure when the scan cannot launch', async () => {
    mockEnqueueTask.mockRejectedValue(new Error('queue failed'));

    await expect(dispatchSuggestionScan(buildParams())).resolves.toEqual({
      successfulScans: 0,
      firstLaunchedTaskId: null,
      errors: ['queue failed'],
    });
    expect(mockRecordAutomationRunOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        key: 'suggester',
        status: 'failed',
        error: 'queue failed',
      }),
    );
  });
});
