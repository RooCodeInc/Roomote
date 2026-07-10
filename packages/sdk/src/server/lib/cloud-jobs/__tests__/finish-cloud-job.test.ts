import { RunStatus, TaskPayloadKind } from '@roomote/types';
import { tasks, type Run, type Task } from '@roomote/db/server';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockFindFirstRun = vi.fn();
const mockFindManyRuns = vi.fn();
const mockFindFirstTask = vi.fn();
const mockFindManyTaskPullRequests = vi.fn();
const mockFindFirstDeploymentSettings = vi.fn();
const mockFindFirstSlackInstallation = vi.fn();
const mockFindFirstSlackUserMapping = vi.fn();
const mockFindLinearDeploymentMcpConnection = vi.fn();
const mockGetValidAccessToken = vi.fn().mockResolvedValue('decrypted-token');
const mockRedisSet = vi.fn().mockResolvedValue('OK');
const mockRedisDel = vi.fn().mockResolvedValue(1);
const mockDbExecute = vi.fn().mockResolvedValue([]);
const mockRecordJobLifecycleEvent = vi.fn().mockResolvedValue(undefined);
const mockCleanupSandboxOidcTargetsForCloudJob = vi
  .fn()
  .mockResolvedValue(undefined);
const mockDbTransaction = vi.fn();

/**
 * Rows resolved by db.select() chains that join tasks with task_runs (the
 * question-channel invite eligibility query). All other select chains resolve
 * to an empty array.
 */
let joinedSelectRows: unknown[] = [];

function makeSelectChain() {
  let joined = false;
  const chain: Record<string, unknown> = {};

  for (const method of [
    'from',
    'leftJoin',
    'where',
    'orderBy',
    'limit',
    'groupBy',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain.innerJoin = vi.fn().mockImplementation(() => {
    joined = true;
    return chain;
  });

  chain.then = (
    onFulfilled: (value: unknown[]) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) =>
    Promise.resolve(joined ? joinedSelectRows : []).then(
      onFulfilled,
      onRejected,
    );

  return chain;
}

/**
 * Rows the terminal transaction's `syncTaskStateFromRuns` reads back for the
 * task's runs. Each state test sets this to drive the derived task state.
 */
let syncRunRows: Array<{
  id: number;
  status: RunStatus;
  startedAt: Date | null;
}> = [];

function makeTxSelectChain() {
  const chain: Record<string, unknown> = {};

  for (const method of [
    'from',
    'where',
    'leftJoin',
    'innerJoin',
    'orderBy',
    'limit',
    // syncTaskStateFromRuns takes a SELECT ... FOR UPDATE lock on the task row.
    'for',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain.then = (
    onFulfilled: (value: unknown[]) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise.resolve(syncRunRows).then(onFulfilled, onRejected);

  return chain;
}

const mockDbSelect = vi.fn().mockImplementation(() => makeSelectChain());
const mockDbUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockDbUpdateSet = vi.fn().mockReturnValue({
  where: (...args: unknown[]) => mockDbUpdateWhere(...args),
});
const mockDbUpdate = vi.fn().mockReturnValue({
  set: (...args: unknown[]) => mockDbUpdateSet(...args),
});
vi.mock('@roomote/db/server', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/db/server')>(
      '@roomote/db/server',
    );
  return {
    ...actual,
    db: {
      query: {
        taskRuns: {
          findFirst: (...args: unknown[]) => mockFindFirstRun(...args),
          findMany: (...args: unknown[]) => mockFindManyRuns(...args),
        },
        taskPullRequests: {
          findMany: (...args: unknown[]) =>
            mockFindManyTaskPullRequests(...args),
        },
        deploymentSettings: {
          findFirst: (...args: unknown[]) =>
            mockFindFirstDeploymentSettings(...args),
        },
        slackInstallations: {
          findFirst: (...args: unknown[]) =>
            mockFindFirstSlackInstallation(...args),
        },
        slackUserMappings: {
          findFirst: (...args: unknown[]) =>
            mockFindFirstSlackUserMapping(...args),
        },
        tasks: {
          findFirst: (...args: unknown[]) => mockFindFirstTask(...args),
        },
      },
      execute: (...args: unknown[]) => mockDbExecute(...args),
      select: (...args: unknown[]) => mockDbSelect(...args),
      transaction: (...args: unknown[]) => mockDbTransaction(...args),
      update: (...args: unknown[]) => mockDbUpdate(...args),
    },
    recordJobLifecycleEvent: (...args: unknown[]) =>
      mockRecordJobLifecycleEvent(...args),
  };
});

const mockSuggestSlackQuestionChannels = vi.fn();
const mockBuildTerminalReviewStatus = vi
  .fn()
  .mockReturnValue('terminal-status');
const mockFinalizeGithubPrReviewComment = vi.fn().mockResolvedValue(false);

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueCloudTask: vi.fn(),
  releaseCloudTask: vi.fn().mockResolvedValue(undefined),
  getTaskUrl: vi.fn().mockReturnValue('https://example.com/task'),
  suggestSlackQuestionChannels: (...args: unknown[]) =>
    mockSuggestSlackQuestionChannels(...args),
  buildTerminalReviewStatus: (...args: unknown[]) =>
    mockBuildTerminalReviewStatus(...args),
  finalizeGithubPrReviewComment: (...args: unknown[]) =>
    mockFinalizeGithubPrReviewComment(...args),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
  }),
}));

const mockCreateIssueComment = vi.fn().mockResolvedValue(undefined);

vi.mock('@roomote/github', () => ({
  createCloudJobGitHubToken: vi.fn().mockResolvedValue('github-token'),
  createIssueComment: (...args: unknown[]) => mockCreateIssueComment(...args),
  deleteReaction: vi.fn(),
  updateCheckRun: vi.fn(),
}));

const mockPostMessage = vi.fn().mockResolvedValue('ts-123');
const mockUpdateMessage = vi.fn().mockResolvedValue(true);
const mockRemoveCancelButton = vi.fn().mockResolvedValue(true);
const mockGetSlackStartedMessageTs = vi.fn().mockResolvedValue(null);
const mockBuildTaskFailedBlocks = vi.fn();
const mockBuildTaskFailedMessage = vi.fn();
const mockOpenConversation = vi.fn().mockResolvedValue('D123');
const mockListPublicChannels = vi.fn().mockResolvedValue([]);
vi.mock('@roomote/slack', () => ({
  SlackNotifier: class MockSlackNotifier {
    postMessage = mockPostMessage;
    updateMessage = mockUpdateMessage;
    removeCancelButton = mockRemoveCancelButton;
    openConversation = mockOpenConversation;
    listPublicChannels = mockListPublicChannels;
  },
  buildTaskFailedBlocks: (...args: unknown[]) =>
    mockBuildTaskFailedBlocks(...args),
  buildTaskFailedMessage: (...args: unknown[]) =>
    mockBuildTaskFailedMessage(...args),
  getSlackStartedMessageTs: (...args: unknown[]) =>
    mockGetSlackStartedMessageTs(...args),
  SLACK_STARTUP_FAILURE_TEXT:
    "I ran into a hiccup and couldn't get started. This is usually temporary -- try again and I'll give it another shot.",
  SLACK_RUNTIME_FAILURE_TEXT:
    "I ran into a hiccup while working on this task. This is usually temporary -- try again and I'll give it another shot.",
}));

const mockEmitError = vi.fn().mockResolvedValue({ success: true });
vi.mock('@roomote/linear', () => ({
  LinearClient: class MockLinearClient {
    emitError = mockEmitError;
  },
}));

const mockTeamsPostMessage = vi.fn().mockResolvedValue({
  provider: 'teams',
  channelId: 'conversation-1',
  messageId: 'activity-response',
});
const mockCreateTeamsCommunicationProviderFromEnv = vi.fn();
vi.mock('@roomote/communication/teams-provider', () => ({
  createTeamsCommunicationProviderFromEnv: (...args: unknown[]) =>
    mockCreateTeamsCommunicationProviderFromEnv(...args),
}));

vi.mock('../../mcp/linear-connections', () => ({
  findLinearDeploymentMcpConnection: (...args: unknown[]) =>
    mockFindLinearDeploymentMcpConnection(...args),
}));

vi.mock('../../mcp/data', () => ({
  getValidAccessToken: (...args: unknown[]) => mockGetValidAccessToken(...args),
}));

vi.mock('../../sandbox-oidc', () => ({
  cleanupSandboxOidcTargetsForCloudJob: (...args: unknown[]) =>
    mockCleanupSandboxOidcTargetsForCloudJob(...args),
}));

import { finishCloudJob } from '../finish-cloud-job';
import { createCloudJobGitHubToken } from '@roomote/github';
import { enqueueCloudTask } from '@roomote/cloud-agents/server';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    workflow: 'standard',
    surface: 'web',
    trigger: 'manual',
    visibility: 'visible',
    state: 'active',
    initiatorKind: 'user',
    initiatorUserId: 'user-1',
    initiatorAutomation: null,
    actorExternalId: null,
    actorDisplayName: null,
    slackChannelId: null,
    slackThreadTs: null,
    linearSessionId: null,
    linearIssueId: null,
    linearOrganizationId: null,
    requestedWorkKind: 'unknown',
    harnessSessionId: null,
    harnessInstructions: null,
    title: 'Task 1',
    prompt: null,
    ...overrides,
  } as Task;
}

type RunWithTask = Run & { task: Task };

function makeRun(
  overrides: Partial<Run> = {},
  taskOverrides: Partial<Task> = {},
): RunWithTask {
  const task = makeTask(taskOverrides);

  return {
    id: 1,
    kind: 'fresh',
    payloadKind: TaskPayloadKind.StandardTask,
    actingUserId: 'user-1',
    harness: 'opencode-server',
    status: RunStatus.Running,
    payload: { repo: 'owner/repo' },
    taskId: task.id,
    sourceRunId: null,
    startedAt: null,
    canceledAt: null,
    completedAt: null,
    ...overrides,
    task,
  } as RunWithTask;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('finishCloudJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    joinedSelectRows = [];
    mockFindManyRuns.mockResolvedValue([]);
    mockFindManyTaskPullRequests.mockResolvedValue([]);
    mockFindFirstDeploymentSettings.mockResolvedValue({
      slackOnboardingStage: 'awaiting_task_milestone',
    });
    mockFindFirstSlackInstallation.mockResolvedValue(null);
    mockFindFirstSlackUserMapping.mockResolvedValue(null);
    mockFindLinearDeploymentMcpConnection.mockResolvedValue(null);
    mockGetValidAccessToken.mockResolvedValue('decrypted-token');
    mockFindFirstTask.mockResolvedValue(null);
    mockSuggestSlackQuestionChannels.mockResolvedValue([]);
    mockBuildTaskFailedBlocks.mockReturnValue([
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: "I ran into a hiccup and couldn't get started. This is usually temporary -- try again and I'll give it another shot.",
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: 'retry_failed_task',
            text: { type: 'plain_text', text: 'Try again' },
            value: JSON.stringify({ cloudJobId: 1 }),
          },
        ],
      },
    ]);
    mockBuildTaskFailedMessage.mockImplementation((options) => ({
      text:
        options && typeof options === 'object' && 'messageText' in options
          ? ((options as { messageText?: string }).messageText ??
            "I ran into a hiccup and couldn't get started. This is usually temporary -- try again and I'll give it another shot.")
          : "I ran into a hiccup and couldn't get started. This is usually temporary -- try again and I'll give it another shot.",
      blocks: mockBuildTaskFailedBlocks(),
    }));
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockResolvedValue(1);
    mockUpdateMessage.mockResolvedValue(true);
    mockDbExecute.mockResolvedValue([]);
    syncRunRows = [];
    mockDbTransaction.mockImplementation(
      async (callback: (tx: unknown) => unknown) =>
        callback({
          execute: (...args: unknown[]) => mockDbExecute(...args),
          query: {
            taskRuns: {
              findFirst: (...args: unknown[]) => mockFindFirstRun(...args),
            },
          },
          select: () => makeTxSelectChain(),
          update: (...args: unknown[]) => mockDbUpdate(...args),
        }),
    );
    mockDbSelect.mockClear();
    mockDbUpdate.mockClear();
    mockDbUpdateSet.mockClear();
    mockDbUpdateWhere.mockClear();
    mockCleanupSandboxOidcTargetsForCloudJob.mockResolvedValue(undefined);
    vi.mocked(createCloudJobGitHubToken).mockResolvedValue('github-token');
  });

  it('cleans up sandbox OIDC targets when a job reaches a terminal status', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun());

    await finishCloudJob({
      id: 1,
      status: RunStatus.Completed,
    });

    expect(mockCleanupSandboxOidcTargetsForCloudJob).toHaveBeenCalledWith(1);
  });

  it('derives tasks.state completed via the shared sync when the job completes', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun());
    // syncTaskStateFromRuns reads the run status just written above.
    syncRunRows = [
      { id: 1, status: RunStatus.Completed, startedAt: new Date() },
    ];

    await finishCloudJob({
      id: 1,
      status: RunStatus.Completed,
    });

    expect(mockDbUpdate).toHaveBeenNthCalledWith(2, tasks);
    expect(mockDbUpdateSet).toHaveBeenNthCalledWith(2, {
      state: 'completed',
      updatedAt: expect.any(Date),
    });
  });

  it('derives tasks.state canceled via the shared sync when the job is canceled', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun());
    syncRunRows = [{ id: 1, status: RunStatus.Canceled, startedAt: null }];

    await finishCloudJob({
      id: 1,
      status: RunStatus.Canceled,
    });

    expect(mockDbUpdate).toHaveBeenNthCalledWith(2, tasks);
    expect(mockDbUpdateSet).toHaveBeenNthCalledWith(2, {
      state: 'canceled',
      updatedAt: expect.any(Date),
    });
  });

  it('derives tasks.state failed via the shared sync when the job fails', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun());
    syncRunRows = [{ id: 1, status: RunStatus.Failed, startedAt: new Date() }];

    await finishCloudJob({
      id: 1,
      status: RunStatus.Failed,
      error: 'boom',
    });

    expect(mockDbUpdate).toHaveBeenNthCalledWith(2, tasks);
    expect(mockDbUpdateSet).toHaveBeenNthCalledWith(2, {
      state: 'failed',
      updatedAt: expect.any(Date),
    });
  });

  it('keeps the task active (not terminal) when the finishing run goes idle', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun());
    // The idle run is non-terminal, so the derivation resolves to 'active'.
    syncRunRows = [{ id: 1, status: RunStatus.Idle, startedAt: new Date() }];

    await finishCloudJob({
      id: 1,
      status: RunStatus.Idle,
    });

    // The shared sync still runs, but only ever derives 'active' here; it never
    // stamps a terminal state onto an idle task.
    for (const call of mockDbUpdateSet.mock.calls) {
      const arg = call[0] as { state?: string } | undefined;
      if (arg && 'state' in arg) {
        expect(arg.state).toBe('active');
      }
    }
  });

  it('preserves completed when a bootstrap-failed resume is canceled after an earlier run completed', async () => {
    mockFindFirstRun.mockResolvedValue(
      makeRun({ id: 2, kind: 'resume', sourceRunId: 1 }),
    );
    // The prior run completed (started); this resume never started before it
    // was canceled, so the derivation keeps the task 'completed'.
    syncRunRows = [
      { id: 1, status: RunStatus.Completed, startedAt: new Date() },
      { id: 2, status: RunStatus.Canceled, startedAt: null },
    ];

    await finishCloudJob({
      id: 2,
      status: RunStatus.Canceled,
    });

    expect(mockDbUpdate).toHaveBeenNthCalledWith(2, tasks);
    expect(mockDbUpdateSet).toHaveBeenNthCalledWith(2, {
      state: 'completed',
      updatedAt: expect.any(Date),
    });
  });

  it('skips sandbox OIDC cleanup when a job transitions to idle', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun());

    await finishCloudJob({
      id: 1,
      status: RunStatus.Idle,
    });

    expect(mockCleanupSandboxOidcTargetsForCloudJob).not.toHaveBeenCalled();
  });

  it('enqueues a dedicated GitHub follow-up when a SnapshotResume job finishes without accepting the deferred prompt', async () => {
    const resumeRun = makeRun(
      {
        id: 303,
        payloadKind: TaskPayloadKind.SnapshotResume,
        kind: 'resume',
        taskId: 'resume-task-303',
        payload: {
          repo: 'owner/repo',
          sourceSnapshotId: 'snapshot-303',
          sourceCloudJobId: 302,
          resumePrompt: 'Please fix this.',
          resumePromptFallbackTask: {
            type: TaskPayloadKind.GithubPrReviewFollowUp,
            userId: 'user-1',
            githubLogin: 'reviewer',
            githubUserId: 2,
            payload: {
              repo: 'owner/repo',
              prNumber: 42,
              prTitle: 'Test PR',
              commentId: 99,
              commentBody: '@roomote please fix this',
              followUpSource: 'github_mention',
            },
          },
        },
        result: {},
      },
      { id: 'resume-task-303' },
    );

    mockFindFirstRun
      .mockResolvedValueOnce(resumeRun)
      .mockResolvedValueOnce(resumeRun);
    vi.mocked(enqueueCloudTask).mockResolvedValue({
      id: 444,
      taskId: 'fallback-task-444',
    } as never);

    await finishCloudJob({
      id: 303,
      status: RunStatus.Failed,
      error: 'snapshot resume failed',
    });

    expect(enqueueCloudTask).toHaveBeenCalledWith({
      task: {
        type: TaskPayloadKind.GithubPrReviewFollowUp,
        payload: {
          repo: 'owner/repo',
          prNumber: 42,
          prTitle: 'Test PR',
          commentId: 99,
          commentBody: '@roomote please fix this',
          followUpSource: 'github_mention',
        },
        githubLogin: 'reviewer',
        githubUserId: 2,
      },
      initiator: { kind: 'user', userId: 'user-1' },
      workflow: 'pr_review',
      surface: 'github',
      trigger: 'message',
      prLinkage: {
        provider: 'github',
        host: 'github.com',
        repository: 'owner/repo',
        prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42',
        prTitle: 'Test PR',
      },
    });
    expect(mockDbUpdateSet).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        status: RunStatus.Failed,
        error: 'snapshot resume failed',
      }),
    );
    expect(mockDbUpdateSet).toHaveBeenCalledWith({
      endedAt: expect.any(Date),
    });
    expect(mockDbUpdateSet).toHaveBeenCalledWith({
      result: {
        deferredResumePromptFallbackJobId: 444,
        deferredResumePromptFallbackEnqueuedAt: expect.any(String),
      },
    });
  });

  it('records a terminal failed lifecycle event keyed by run id', async () => {
    const job = makeRun({
      id: 12,
      vendor: 'modal',
      machineId: 'sb-modal-12',
      sourceSnapshotId: 'snap_env_12',
      workerReleaseTag: 'worker-v1.2.3',
      workerVersion: '1.2.3',
      workerCommit: 'abc123',
      taskPhase: 'running',
      sleepAt: new Date('2026-04-09T20:46:54.313Z'),
      sleepRequestedAt: new Date('2026-04-09T20:41:10.000Z'),
      snapshotRequestedAt: new Date('2026-04-09T20:41:12.000Z'),
      snapshotCreatedAt: new Date('2026-04-09T20:41:30.000Z'),
      workerHeartbeatAt: new Date('2026-04-09T20:38:58.630Z'),
      result: {
        runtimeTaskId: 'runtime-task-12',
      },
    });
    mockFindFirstRun.mockResolvedValue(job);

    await finishCloudJob({
      id: 12,
      status: RunStatus.Failed,
      error: 'spawn timeout',
    });

    expect(mockRecordJobLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 12,
        taskId: 'task-1',
        eventType: 'failed',
        message: 'Cloud job finished with a failure.',
        details: expect.objectContaining({
          stage: 'finish_cloud_job',
          status: RunStatus.Failed,
          vendor: 'modal',
          machineId: 'sb-modal-12',
          sourceSnapshotId: 'snap_env_12',
          workerReleaseTag: 'worker-v1.2.3',
          workerVersion: '1.2.3',
          workerCommit: 'abc123',
          runtimeTaskId: 'runtime-task-12',
          previousTaskPhase: 'running',
          previousSleepAt: '2026-04-09T20:46:54.313Z',
          previousSleepRequestedAt: '2026-04-09T20:41:10.000Z',
          previousSnapshotRequestedAt: '2026-04-09T20:41:12.000Z',
          previousSnapshotCreatedAt: '2026-04-09T20:41:30.000Z',
          previousWorkerHeartbeatAt: '2026-04-09T20:38:58.630Z',
          error: 'spawn timeout',
        }),
      }),
    );
  });

  describe('Slack completion handling', () => {
    it('does not auto-post screenshots for completed Slack jobs', async () => {
      const job = makeRun(
        {
          payloadKind: TaskPayloadKind.SlackAppMention,
          payload: {
            repo: 'owner/repo',
            channel: 'C123',
            user: 'U456',
            text: 'test',
            ts: '111.222',
            thread_ts: '111.222',
          },
        },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindFirstTask.mockResolvedValue(job.task);
      mockFindFirstSlackInstallation.mockResolvedValue({
        botAccessToken: 'xoxb-test',
      });

      await finishCloudJob({
        id: 1,
        status: RunStatus.Completed,
      });

      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('posts a setup thread reply with a /setup link when setup onboarding completes', async () => {
      const origin = process.env.ROOMOTE_APP_URL || 'http://localhost:13000';
      const job = makeRun(
        {
          payloadKind: TaskPayloadKind.SlackAppMention,
          payload: {
            repo: 'owner/repo',
            channel: 'C123',
            user: 'U456',
            text: 'test',
            ts: '111.222',
            thread_ts: '111.222',
            webPath: '/setup',
          },
        },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindFirstTask.mockResolvedValue(job.task);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');

      await finishCloudJob({
        id: 1,
        status: RunStatus.Completed,
      });

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: '111.222',
        text: `Setup for the repo project is done. Continue on the web: <${origin}/setup?utm_source=slack&utm_medium=link&utm_campaign=setup.onboarding.completed|Open setup>.`,
        unfurl_links: false,
        unfurl_media: false,
      });
    });

    it('posts a setup thread reply when setup onboarding becomes idle with a linked environment', async () => {
      const origin = process.env.ROOMOTE_APP_URL || 'http://localhost:13000';
      const job = makeRun(
        {
          payloadKind: TaskPayloadKind.SlackAppMention,
          taskPhase: 'waiting_for_prompt',
          payload: {
            repo: 'owner/repo',
            channel: 'C123',
            user: 'U456',
            text: 'test',
            ts: '111.222',
            thread_ts: '111.222',
            webPath: '/setup',
            environmentDefinitionId: 'env-123',
          } as Run['payload'],
        },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindFirstTask.mockResolvedValue(job.task);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');

      await finishCloudJob({
        id: 1,
        status: RunStatus.Idle,
      });

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: '111.222',
        text: `Setup for the repo project is done. Continue on the web: <${origin}/setup?utm_source=slack&utm_medium=link&utm_campaign=setup.onboarding.completed|Open setup>.`,
        unfurl_links: false,
        unfurl_media: false,
      });
    });

    it('does not post a setup thread reply when an idle setup task is still running', async () => {
      const job = makeRun(
        {
          payloadKind: TaskPayloadKind.SlackAppMention,
          taskPhase: 'running',
          payload: {
            repo: 'owner/repo',
            channel: 'C123',
            user: 'U456',
            text: 'test',
            ts: '111.222',
            thread_ts: '111.222',
            webPath: '/setup',
            environmentDefinitionId: 'env-123',
          } as Run['payload'],
        },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindFirstTask.mockResolvedValue(job.task);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');

      await finishCloudJob({
        id: 1,
        status: RunStatus.Idle,
      });

      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('does not post a setup thread reply when setup onboarding becomes idle without a linked environment', async () => {
      const job = makeRun(
        {
          payloadKind: TaskPayloadKind.SlackAppMention,
          taskPhase: 'waiting_for_prompt',
          payload: {
            repo: 'owner/repo',
            channel: 'C123',
            user: 'U456',
            text: 'test',
            ts: '111.222',
            thread_ts: '111.222',
            webPath: '/setup',
          },
        },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindFirstTask.mockResolvedValue(job.task);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');

      await finishCloudJob({
        id: 1,
        status: RunStatus.Idle,
      });

      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('falls back to a generic setup completion message when no project name is available', async () => {
      const origin = process.env.ROOMOTE_APP_URL || 'http://localhost:13000';
      const job = makeRun(
        {
          payloadKind: TaskPayloadKind.SlackAppMention,
          payload: {
            repo: '',
            channel: 'C123',
            user: 'U456',
            text: 'test',
            ts: '111.222',
            thread_ts: '111.222',
            webPath: '/setup',
          },
        },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindFirstTask.mockResolvedValue(job.task);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');

      await finishCloudJob({
        id: 1,
        status: RunStatus.Completed,
      });

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: '111.222',
        text: `Setup is done. Continue on the web: <${origin}/setup?utm_source=slack&utm_medium=link&utm_campaign=setup.onboarding.completed|Open setup>.`,
        unfurl_links: false,
        unfurl_media: false,
      });
    });

    it('posts a setup thread reply for resumed setup snapshot jobs by reading sibling runs of the task', async () => {
      const origin = process.env.ROOMOTE_APP_URL || 'http://localhost:13000';
      const resumedJob = makeRun(
        {
          id: 2,
          payloadKind: TaskPayloadKind.SnapshotResume,
          kind: 'resume',
          sourceRunId: 1,
          payload: {
            repo: 'owner/repo',
            sourceSnapshotId: 'snapshot-123',
            sourceCloudJobId: 1,
            slackChannel: 'C123',
          },
        },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      );
      mockFindFirstRun.mockResolvedValue(resumedJob);
      mockFindFirstTask.mockResolvedValue(resumedJob.task);
      // The setup webPath lives on the fresh run's payload; the router scans
      // the task's sibling runs to find it.
      mockFindManyRuns.mockResolvedValue([
        {
          id: 1,
          payload: {
            repo: 'owner/repo',
            channel: 'C123',
            user: 'U456',
            text: 'test',
            ts: '111.222',
            thread_ts: '111.222',
            webPath: '/setup',
          },
        },
      ]);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');

      await finishCloudJob({
        id: 2,
        status: RunStatus.Completed,
      });

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: '111.222',
        text: `Setup for the repo project is done. Continue on the web: <${origin}/setup?utm_source=slack&utm_medium=link&utm_campaign=setup.onboarding.completed|Open setup>.`,
        unfurl_links: false,
        unfurl_media: false,
      });
    });

    it('posts a setup thread reply for an idle resume when the linked environment lives on a sibling run', async () => {
      const origin = process.env.ROOMOTE_APP_URL || 'http://localhost:13000';
      const resumedJob = makeRun(
        {
          id: 2,
          payloadKind: TaskPayloadKind.SnapshotResume,
          kind: 'resume',
          taskPhase: 'waiting_for_prompt',
          sourceRunId: 1,
          payload: {
            repo: 'owner/repo',
            sourceSnapshotId: 'snapshot-123',
            sourceCloudJobId: 1,
            slackChannel: 'C123',
          },
        },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      );
      mockFindFirstRun.mockResolvedValue(resumedJob);
      mockFindFirstTask.mockResolvedValue(resumedJob.task);
      mockFindManyRuns.mockResolvedValue([
        {
          id: 1,
          payload: {
            repo: 'owner/repo',
            channel: 'C123',
            user: 'U456',
            text: 'test',
            ts: '111.222',
            thread_ts: '111.222',
            webPath: '/setup',
            environmentDefinitionId: 'env-123',
          },
        },
      ]);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');

      await finishCloudJob({
        id: 2,
        status: RunStatus.Idle,
      });

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: '111.222',
        text: `Setup for the repo project is done. Continue on the web: <${origin}/setup?utm_source=slack&utm_medium=link&utm_campaign=setup.onboarding.completed|Open setup>.`,
        unfurl_links: false,
        unfurl_media: false,
      });
    });

    it('posts the setup thread reply only once across repeated idle resume cycles of the same task', async () => {
      const freshRunPayload = {
        repo: 'owner/repo',
        channel: 'C123',
        user: 'U456',
        text: 'test',
        ts: '111.222',
        thread_ts: '111.222',
        webPath: '/setup',
        environmentDefinitionId: 'env-123',
      };
      const firstResumeJob = makeRun(
        {
          id: 2,
          payloadKind: TaskPayloadKind.SnapshotResume,
          kind: 'resume',
          taskPhase: 'waiting_for_prompt',
          sourceRunId: 1,
          payload: {
            repo: 'owner/repo',
            sourceSnapshotId: 'snapshot-123',
            sourceCloudJobId: 1,
            slackChannel: 'C123',
          },
        },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      );
      const secondResumeJob = makeRun(
        {
          id: 3,
          payloadKind: TaskPayloadKind.SnapshotResume,
          kind: 'resume',
          taskPhase: 'waiting_for_prompt',
          sourceRunId: 2,
          payload: {
            repo: 'owner/repo',
            sourceSnapshotId: 'snapshot-456',
            sourceCloudJobId: 2,
            slackChannel: 'C123',
          },
        },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      );

      mockFindFirstRun
        .mockResolvedValueOnce(firstResumeJob)
        .mockResolvedValueOnce(secondResumeJob);
      mockFindFirstTask.mockResolvedValue(firstResumeJob.task);
      mockFindManyRuns.mockResolvedValue([{ id: 1, payload: freshRunPayload }]);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');
      mockRedisSet.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

      await finishCloudJob({
        id: 2,
        status: RunStatus.Idle,
      });
      await finishCloudJob({
        id: 3,
        status: RunStatus.Idle,
      });

      // The claim is task-scoped, so repeated idle cycles share one key.
      expect(mockRedisSet).toHaveBeenNthCalledWith(
        1,
        'slack:setup-completion:slack-inst-1:task-1',
        '1',
        'EX',
        2592000,
        'NX',
      );
      expect(mockRedisSet).toHaveBeenNthCalledWith(
        2,
        'slack:setup-completion:slack-inst-1:task-1',
        '1',
        'EX',
        2592000,
        'NX',
      );
      expect(mockPostMessage).toHaveBeenCalledTimes(1);
    });

    it('DMs the installing user after their second completed non-unknown task when no channels were joined yet', async () => {
      const job = makeRun(
        {
          id: 2,
          taskId: 'task-2',
          completedAt: new Date('2026-04-08T12:05:00.000Z'),
        },
        { id: 'task-2', requestedWorkKind: 'implement' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        teamId: 'T123',
        botAccessToken: 'xoxb-test',
        updatedAt: new Date('2026-04-08T10:00:00.000Z'),
        joinedChannels: [],
      });
      joinedSelectRows = [
        {
          taskId: 'task-1',
          completedAt: new Date('2026-04-08T11:00:00.000Z'),
          requestedWorkKind: 'question',
        },
        {
          taskId: 'task-2',
          completedAt: new Date('2026-04-08T12:05:00.000Z'),
          requestedWorkKind: 'implement',
        },
      ];
      mockFindFirstSlackUserMapping.mockResolvedValue({
        slackUserId: 'UINSTALLER',
        updatedAt: new Date('2026-04-08T10:00:00.000Z'),
      });
      mockListPublicChannels.mockResolvedValue([
        { id: 'CGENERAL', name: 'general' },
        { id: 'CQUESTIONS', name: 'eng-questions' },
      ]);
      mockSuggestSlackQuestionChannels.mockResolvedValue([
        { id: 'CQUESTIONS', name: 'eng-questions' },
        { id: 'CGENERAL', name: 'general' },
      ]);

      await finishCloudJob({
        id: 2,
        status: RunStatus.Completed,
      });

      expect(mockOpenConversation).toHaveBeenCalledWith('UINSTALLER');
      expect(mockSuggestSlackQuestionChannels).toHaveBeenCalledWith({
        userId: 'user-1',
        taskId: 'task-2',
        channels: [
          { id: 'CGENERAL', name: 'general' },
          { id: 'CQUESTIONS', name: 'eng-questions' },
        ],
      });
      expect(mockRedisSet).toHaveBeenCalledWith(
        'slack:question-channel-invite:slack-inst-1:task-2',
        '1',
        'EX',
        2592000,
        'NX',
      );
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'D123',
          text: expect.stringContaining(
            'Perhaps <#CQUESTIONS> or <#CGENERAL>?',
          ),
        }),
      );
    });

    it('skips the proactive DM once the Slack app has already joined a channel', async () => {
      const job = makeRun(
        { id: 2, taskId: 'task-2' },
        { id: 'task-2', requestedWorkKind: 'question' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        teamId: 'T123',
        botAccessToken: 'xoxb-test',
        updatedAt: new Date('2026-04-08T10:00:00.000Z'),
        joinedChannels: [{ channelId: 'CJOINED' }],
      });

      await finishCloudJob({
        id: 2,
        status: RunStatus.Completed,
      });

      expect(mockOpenConversation).not.toHaveBeenCalled();
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('skips the proactive DM until the second completed non-unknown task is reached', async () => {
      const job = makeRun(
        { id: 2, taskId: 'task-2' },
        { id: 'task-2', requestedWorkKind: 'question' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        teamId: 'T123',
        botAccessToken: 'xoxb-test',
        updatedAt: new Date('2026-04-08T10:00:00.000Z'),
        joinedChannels: [],
      });
      joinedSelectRows = [
        {
          taskId: 'task-unknown',
          completedAt: new Date('2026-04-08T11:00:00.000Z'),
          requestedWorkKind: 'unknown',
        },
        {
          taskId: 'task-2',
          completedAt: new Date('2026-04-08T12:05:00.000Z'),
          requestedWorkKind: 'question',
        },
      ];
      mockFindFirstSlackUserMapping.mockResolvedValue({
        slackUserId: 'UINSTALLER',
        updatedAt: new Date('2026-04-08T10:00:00.000Z'),
      });

      await finishCloudJob({
        id: 2,
        status: RunStatus.Completed,
      });

      expect(mockOpenConversation).not.toHaveBeenCalled();
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('skips the proactive DM when the current completed task is unknown work kind', async () => {
      const job = makeRun(
        { id: 2, taskId: 'task-2' },
        { id: 'task-2', requestedWorkKind: 'unknown' },
      );
      mockFindFirstRun.mockResolvedValue(job);

      await finishCloudJob({
        id: 2,
        status: RunStatus.Completed,
      });

      expect(mockFindFirstSlackInstallation).not.toHaveBeenCalled();
      expect(mockOpenConversation).not.toHaveBeenCalled();
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('skips the proactive DM once the deployment onboarding stage is done', async () => {
      const job = makeRun(
        { id: 2, taskId: 'task-2' },
        { id: 'task-2', requestedWorkKind: 'question' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindFirstDeploymentSettings.mockResolvedValue({
        slackOnboardingStage: 'done',
      });

      await finishCloudJob({
        id: 2,
        status: RunStatus.Completed,
      });

      expect(mockFindFirstSlackInstallation).not.toHaveBeenCalled();
      expect(mockOpenConversation).not.toHaveBeenCalled();
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('does not count pre-reinstall non-unknown tasks toward the second-task invite trigger', async () => {
      const job = makeRun(
        { id: 2, taskId: 'task-new-1' },
        { id: 'task-new-1', requestedWorkKind: 'question' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        teamId: 'T123',
        botAccessToken: 'xoxb-test',
        updatedAt: new Date('2026-04-08T11:30:00.000Z'),
        joinedChannels: [],
      });
      mockFindFirstSlackUserMapping.mockResolvedValue({
        slackUserId: 'UINSTALLER',
        updatedAt: new Date('2026-04-01T10:00:00.000Z'),
      });
      joinedSelectRows = [
        {
          taskId: 'task-old-1',
          completedAt: new Date('2026-04-07T09:00:00.000Z'),
          requestedWorkKind: 'implement',
        },
        {
          taskId: 'task-new-1',
          completedAt: new Date('2026-04-08T12:05:00.000Z'),
          requestedWorkKind: 'question',
        },
      ];

      await finishCloudJob({
        id: 2,
        status: RunStatus.Completed,
      });

      expect(mockOpenConversation).not.toHaveBeenCalled();
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('skips the proactive DM when the dedupe claim already exists', async () => {
      const job = makeRun(
        { id: 2, taskId: 'task-2' },
        { id: 'task-2', requestedWorkKind: 'question' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        teamId: 'T123',
        botAccessToken: 'xoxb-test',
        updatedAt: new Date('2026-04-08T10:00:00.000Z'),
        joinedChannels: [],
      });
      joinedSelectRows = [
        {
          taskId: 'task-1',
          completedAt: new Date('2026-04-08T11:00:00.000Z'),
          requestedWorkKind: 'question',
        },
        {
          taskId: 'task-2',
          completedAt: new Date('2026-04-08T12:05:00.000Z'),
          requestedWorkKind: 'implement',
        },
      ];
      mockFindFirstSlackUserMapping.mockResolvedValue({
        slackUserId: 'UINSTALLER',
        updatedAt: new Date('2026-04-08T10:00:00.000Z'),
      });
      mockRedisSet.mockResolvedValue(null);

      await finishCloudJob({
        id: 2,
        status: RunStatus.Completed,
      });

      expect(mockPostMessage).not.toHaveBeenCalled();
    });
  });

  describe('Slack failure notification', () => {
    it('posts a retryable generic thread reply when a non-setup Slack job fails', async () => {
      const job = makeRun(
        {
          payloadKind: TaskPayloadKind.SlackAppMention,
          payload: {
            repo: 'owner/repo',
            channel: 'C123',
            user: 'U456',
            text: 'test',
            ts: '111.222',
          },
        },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindFirstTask.mockResolvedValue(job.task);
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });

      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'spawn timeout',
      });

      expect(mockBuildTaskFailedMessage).toHaveBeenCalledWith({
        cloudJobId: 1,
        messageText:
          "I ran into a hiccup and couldn't get started. This is usually temporary -- try again and I'll give it another shot.",
      });
      expect(mockUpdateMessage).toHaveBeenCalledWith({
        channel: 'C123',
        ts: '111.333',
        message: {
          text: "I ran into a hiccup and couldn't get started. This is usually temporary -- try again and I'll give it another shot.",
          blocks: mockBuildTaskFailedBlocks.mock.results[0]?.value,
        },
      });
      expect(mockPostMessage).not.toHaveBeenCalled();
      expect(mockRemoveCancelButton).toHaveBeenCalledWith({
        channel: 'C123',
        messageTs: '111.333',
        threadTs: '111.222',
      });
    });

    it('suppresses the failure notification when a stop was requested before the failure', async () => {
      const job = makeRun(
        {
          payloadKind: TaskPayloadKind.SlackAppMention,
          cancelRequestedAt: new Date(),
          payload: {
            repo: 'owner/repo',
            channel: 'C123',
            user: 'U456',
            text: 'test',
            ts: '111.222',
          },
        },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindFirstTask.mockResolvedValue(job.task);
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });

      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'Worker heartbeat stale and instance sb-1 is stopped',
      });

      expect(mockBuildTaskFailedMessage).not.toHaveBeenCalled();
      expect(mockUpdateMessage).not.toHaveBeenCalled();
      expect(mockPostMessage).not.toHaveBeenCalled();
      // Persist/report consistency: the stop-normalized status is also what
      // gets PERSISTED — the run is written as canceled (canceledAt set,
      // completedAt cleared) so the derived tasks.state reads canceled, while
      // the sanitized error stays on the run for debugging.
      expect(mockDbUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: RunStatus.Canceled,
          canceledAt: expect.any(Date),
          completedAt: null,
          error: expect.stringContaining('Worker heartbeat stale'),
        }),
      );
    });

    it('persists failed and still notifies when the failure has no stop request', async () => {
      const job = makeRun(
        {
          payloadKind: TaskPayloadKind.SlackAppMention,
          payload: {
            repo: 'owner/repo',
            channel: 'C123',
            user: 'U456',
            text: 'test',
            ts: '111.222',
          },
        },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindFirstTask.mockResolvedValue(job.task);
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });

      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'spawn timeout',
      });

      // No stop request -> no normalization: persisted as failed with
      // completedAt stamped, and the failure notification goes out.
      expect(mockDbUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: RunStatus.Failed,
          canceledAt: null,
          completedAt: expect.any(Date),
        }),
      );
      expect(mockBuildTaskFailedMessage).toHaveBeenCalled();
      expect(mockUpdateMessage).toHaveBeenCalled();
    });

    it('posts a text-only thread reply when a SnapshotResume Slack job fails', async () => {
      const job = makeRun(
        {
          payloadKind: TaskPayloadKind.SnapshotResume,
          kind: 'resume',
          payload: {
            repo: 'owner/repo',
            channel: 'C123',
            user: 'U456',
            text: 'test',
            ts: '111.222',
            thread_ts: '111.222',
          },
        },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindFirstTask.mockResolvedValue(job.task);
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });

      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'resume bootstrap timeout',
      });

      expect(mockBuildTaskFailedBlocks).not.toHaveBeenCalled();
      expect(mockUpdateMessage).toHaveBeenCalledWith({
        channel: 'C123',
        ts: '111.333',
        message: {
          text: "I ran into a hiccup and couldn't get started. Please send a fresh Slack message and I'll give it another shot.",
        },
      });
      expect(mockPostMessage).not.toHaveBeenCalled();
      expect(mockRemoveCancelButton).toHaveBeenCalledWith({
        channel: 'C123',
        messageTs: '111.333',
        threadTs: '111.222',
      });
    });

    it('falls back to a new thread reply when there is no started message ts to update', async () => {
      const job = makeRun(
        {
          payloadKind: TaskPayloadKind.SlackAppMention,
          payload: {
            repo: 'owner/repo',
            channel: 'C123',
            user: 'U456',
            text: 'test',
            ts: '111.222',
          },
        },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindFirstTask.mockResolvedValue(job.task);
      mockGetSlackStartedMessageTs.mockResolvedValue(null);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });

      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'spawn timeout',
      });

      expect(mockUpdateMessage).not.toHaveBeenCalled();
      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: '111.222',
        text: "I ran into a hiccup and couldn't get started. This is usually temporary -- try again and I'll give it another shot.",
        blocks: mockBuildTaskFailedBlocks.mock.results[0]?.value,
      });
      expect(mockRemoveCancelButton).not.toHaveBeenCalled();
    });

    it('posts runtime-failure copy as a new thread reply when the runtime task already started', async () => {
      const job = makeRun(
        {
          payloadKind: TaskPayloadKind.SlackAppMention,
          runtimeTaskStartedAt: new Date('2026-05-21T18:38:48.000Z'),
          result: {
            runtimeTaskId: 'runtime-task-12',
          },
          payload: {
            repo: 'owner/repo',
            channel: 'C123',
            user: 'U456',
            text: 'test',
            ts: '111.222',
            thread_ts: '111.222',
          },
        },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindFirstTask.mockResolvedValue(job.task);
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });

      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'worker heartbeat stale',
      });

      expect(mockBuildTaskFailedMessage).toHaveBeenCalledWith({
        cloudJobId: 1,
        messageText:
          "I ran into a hiccup while working on this task. This is usually temporary -- try again and I'll give it another shot.",
      });
      expect(mockUpdateMessage).not.toHaveBeenCalled();
      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: '111.222',
        text: "I ran into a hiccup while working on this task. This is usually temporary -- try again and I'll give it another shot.",
        blocks: mockBuildTaskFailedBlocks.mock.results[0]?.value,
      });
      expect(mockRemoveCancelButton).toHaveBeenCalledWith({
        channel: 'C123',
        messageTs: '111.333',
        threadTs: '111.222',
      });
    });

    it('posts a setup /setup thread reply when setup onboarding fails', async () => {
      const origin = process.env.ROOMOTE_APP_URL || 'http://localhost:13000';
      const job = makeRun(
        {
          payloadKind: TaskPayloadKind.SlackAppMention,
          payload: {
            repo: 'owner/repo',
            channel: 'C123',
            user: 'U456',
            text: 'test',
            ts: '111.222',
            thread_ts: '111.222',
            webPath: '/setup',
          },
        },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindFirstTask.mockResolvedValue(job.task);
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });

      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'spawn timeout',
      });

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: '111.222',
        text: `I ran into an issue when setting things up. <${origin}/setup?utm_source=slack&utm_medium=link&utm_campaign=setup.onboarding.failed|Continue on the web app> to fix it.`,
        unfurl_links: false,
        unfurl_media: false,
      });
    });

    it('skips Slack notification when the task has no slackThreadTs binding', async () => {
      const job = makeRun({}, { slackThreadTs: null });
      mockFindFirstRun.mockResolvedValue(job);

      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'some error',
      });

      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('skips Slack notification on non-Failed status', async () => {
      const job = makeRun(
        {
          payloadKind: TaskPayloadKind.SlackAppMention,
          payload: {
            repo: 'owner/repo',
            channel: 'C123',
            user: 'U456',
            text: 'test',
            ts: '111.222',
          },
        },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindFirstTask.mockResolvedValue(job.task);

      await finishCloudJob({
        id: 1,
        status: RunStatus.Completed,
      });

      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('does not throw when Slack notification fails', async () => {
      const job = makeRun(
        {
          payloadKind: TaskPayloadKind.SlackAppMention,
          payload: {
            repo: 'owner/repo',
            channel: 'C123',
            user: 'U456',
            text: 'test',
            ts: '111.222',
          },
        },
        { slackChannelId: 'C123', slackThreadTs: '111.222' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindFirstTask.mockResolvedValue(job.task);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });
      mockPostMessage.mockRejectedValue(new Error('Slack API error'));

      // Should not throw
      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'test error',
      });
    });
  });

  describe('Teams failure notification', () => {
    const teamsPayload = {
      repo: 'owner/repo',
      communicationProvider: 'teams',
      communicationChannelId: 'conversation-1',
      communicationServiceUrl: 'https://smba.trafficmanager.net/amer/',
      communicationThreadId: 'activity-root',
    } as unknown as Run['payload'];

    beforeEach(() => {
      mockCreateTeamsCommunicationProviderFromEnv.mockReturnValue({
        postMessage: mockTeamsPostMessage,
      });
    });

    it('posts a startup-failure thread reply when a Teams job fails before runtime', async () => {
      const job = makeRun({ payload: teamsPayload });
      mockFindFirstRun.mockResolvedValue(job);

      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'spawn timeout',
      });

      expect(mockTeamsPostMessage).toHaveBeenCalledWith({
        channelId: 'conversation-1',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        threadId: 'activity-root',
        replyToMessageId: 'activity-root',
        text: "I ran into a hiccup and couldn't get started. This is usually temporary -- try again and I'll give it another shot.\n\n[Open the task](https://example.com/task)",
        textFormat: 'markdown',
      });
    });

    it('suppresses the Teams notification when a stop was requested before the failure', async () => {
      const job = makeRun({
        payload: teamsPayload,
        cancelRequestedAt: new Date(),
      });
      mockFindFirstRun.mockResolvedValue(job);

      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'spawn timeout',
      });

      expect(mockTeamsPostMessage).not.toHaveBeenCalled();
      // The stop-normalized status is also persisted as canceled.
      expect(mockDbUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: RunStatus.Canceled,
          canceledAt: expect.any(Date),
          completedAt: null,
        }),
      );
    });

    it('posts runtime-failure copy when the runtime task already started', async () => {
      const job = makeRun({
        payload: teamsPayload,
        result: { runtimeTaskId: 'runtime-1' },
      });
      mockFindFirstRun.mockResolvedValue(job);

      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'runtime crash',
      });

      expect(mockTeamsPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining(
            'I ran into a hiccup while working on this task.',
          ),
        }),
      );
    });

    it('skips the Teams notification when the payload is not Teams-backed', async () => {
      const job = makeRun({ payload: { repo: 'owner/repo' } });
      mockFindFirstRun.mockResolvedValue(job);

      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'some error',
      });

      expect(mockTeamsPostMessage).not.toHaveBeenCalled();
    });

    it('skips the Teams notification on non-Failed status', async () => {
      const job = makeRun({ payload: teamsPayload });
      mockFindFirstRun.mockResolvedValue(job);

      await finishCloudJob({
        id: 1,
        status: RunStatus.Completed,
      });

      expect(mockTeamsPostMessage).not.toHaveBeenCalled();
    });

    it('skips the Teams notification when bot credentials are not configured', async () => {
      const job = makeRun({ payload: teamsPayload });
      mockFindFirstRun.mockResolvedValue(job);
      mockCreateTeamsCommunicationProviderFromEnv.mockReturnValue(null);

      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'some error',
      });

      expect(mockTeamsPostMessage).not.toHaveBeenCalled();
    });

    it('does not throw when the Teams notification fails', async () => {
      const job = makeRun({ payload: teamsPayload });
      mockFindFirstRun.mockResolvedValue(job);
      mockTeamsPostMessage.mockRejectedValue(new Error('Teams API error'));

      // Should not throw
      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'test error',
      });
    });
  });

  describe('GitHub conflict resolution comments', () => {
    const conflictPrRow = {
      id: 'tpr-1',
      taskId: 'task-1',
      sourceControlProvider: 'github',
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      githubReactionId: null,
      githubCheckRunId: null,
      githubReviewCommentId: null,
    };

    it('posts the persisted resolution summary for completed conflict jobs', async () => {
      const job = makeRun(
        {
          payloadKind: TaskPayloadKind.GithubPrConflictResolve,
          result: {
            conflictResolutionSummary: {
              resolvedFiles: ['apps/api/src/file.ts'],
              controversialDecisions: [
                'Kept the incoming branch validation check.',
              ],
              warnings: [],
            },
          },
        },
        { workflow: 'pr_conflict_resolve', surface: 'github' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindManyTaskPullRequests.mockResolvedValue([conflictPrRow]);

      await finishCloudJob({
        id: 1,
        status: RunStatus.Completed,
      });

      expect(mockCreateIssueComment).toHaveBeenCalledWith('github-token', {
        owner: 'owner',
        repo: 'repo',
        issue_number: 42,
        body: [
          'Resolved merge conflicts in:',
          '- `apps/api/src/file.ts`',
          '',
          "Decisions I'm not 100% sure:",
          '- Kept the incoming branch validation check.',
        ].join('\n'),
      });
    });

    it('falls back to a generic success comment when no summary is available', async () => {
      const job = makeRun(
        {
          payloadKind: TaskPayloadKind.GithubPrConflictResolve,
        },
        { workflow: 'pr_conflict_resolve', surface: 'github' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindManyTaskPullRequests.mockResolvedValue([conflictPrRow]);

      await finishCloudJob({
        id: 1,
        status: RunStatus.Completed,
      });

      expect(mockCreateIssueComment).toHaveBeenCalledWith('github-token', {
        owner: 'owner',
        repo: 'repo',
        issue_number: 42,
        body: 'Resolved merge conflicts on this PR.',
      });
    });

    it('posts the simplified failure comment for failed conflict jobs', async () => {
      const job = makeRun(
        {
          payloadKind: TaskPayloadKind.GithubPrConflictResolve,
        },
        { workflow: 'pr_conflict_resolve', surface: 'github' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindManyTaskPullRequests.mockResolvedValue([conflictPrRow]);

      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'Patch did not apply cleanly.',
      });

      expect(mockCreateIssueComment).toHaveBeenCalledWith('github-token', {
        owner: 'owner',
        repo: 'repo',
        issue_number: 42,
        body: [
          'I detected merge conflicts but could not automatically resolve them:',
          'Patch did not apply cleanly.',
        ].join('\n'),
      });
    });

    it('skips the conflict comment when the task has no linked pull request row', async () => {
      const job = makeRun(
        {
          payloadKind: TaskPayloadKind.GithubPrConflictResolve,
        },
        { workflow: 'pr_conflict_resolve', surface: 'github' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindManyTaskPullRequests.mockResolvedValue([]);

      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'Patch did not apply cleanly.',
      });

      expect(mockCreateIssueComment).not.toHaveBeenCalled();
    });

    it('skips the failure comment when the failed conflict run had a stop request', async () => {
      const job = makeRun(
        {
          payloadKind: TaskPayloadKind.GithubPrConflictResolve,
          cancelRequestedAt: new Date(),
        },
        { workflow: 'pr_conflict_resolve', surface: 'github' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindManyTaskPullRequests.mockResolvedValue([conflictPrRow]);

      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'Patch did not apply cleanly.',
      });

      expect(mockCreateIssueComment).not.toHaveBeenCalled();
      // The stop-normalized status is also persisted as canceled.
      expect(mockDbUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: RunStatus.Canceled,
          canceledAt: expect.any(Date),
          completedAt: null,
        }),
      );
    });
  });

  describe('Linear failure notification', () => {
    it('emits an error activity when status is Failed and the task has a linearSessionId binding', async () => {
      const job = makeRun({}, { linearSessionId: 'session-abc' });
      mockFindFirstRun.mockResolvedValue(job);
      mockFindLinearDeploymentMcpConnection.mockResolvedValue({
        id: 'linear-conn-1',
      });

      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'spawn failure',
      });

      expect(mockGetValidAccessToken).toHaveBeenCalledWith(
        'linear-conn-1',
        'https://mcp.linear.app/mcp',
      );
      expect(mockEmitError).toHaveBeenCalledWith(
        'session-abc',
        'spawn failure',
      );
    });

    it('suppresses the Linear notification when a stop was requested before the failure', async () => {
      const job = makeRun(
        { cancelRequestedAt: new Date() },
        { linearSessionId: 'session-abc' },
      );
      mockFindFirstRun.mockResolvedValue(job);
      mockFindLinearDeploymentMcpConnection.mockResolvedValue({
        id: 'linear-conn-1',
      });

      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'spawn failure',
      });

      expect(mockEmitError).not.toHaveBeenCalled();
      // The stop-normalized status is also persisted as canceled.
      expect(mockDbUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: RunStatus.Canceled,
          canceledAt: expect.any(Date),
          completedAt: null,
        }),
      );
    });

    it('skips Linear notification when the task has no linearSessionId binding', async () => {
      const job = makeRun({}, { linearSessionId: null });
      mockFindFirstRun.mockResolvedValue(job);

      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'some error',
      });

      expect(mockEmitError).not.toHaveBeenCalled();
    });

    it('skips Linear notification on non-Failed status', async () => {
      const job = makeRun({}, { linearSessionId: 'session-abc' });
      mockFindFirstRun.mockResolvedValue(job);

      await finishCloudJob({
        id: 1,
        status: RunStatus.Completed,
      });

      expect(mockEmitError).not.toHaveBeenCalled();
    });

    it('does not throw when Linear notification fails', async () => {
      const job = makeRun({}, { linearSessionId: 'session-abc' });
      mockFindFirstRun.mockResolvedValue(job);
      mockFindLinearDeploymentMcpConnection.mockResolvedValue({
        id: 'linear-conn-1',
      });
      mockEmitError.mockRejectedValue(new Error('Linear API error'));

      // Should not throw
      await finishCloudJob({
        id: 1,
        status: RunStatus.Failed,
        error: 'test error',
      });
    });
  });
});
