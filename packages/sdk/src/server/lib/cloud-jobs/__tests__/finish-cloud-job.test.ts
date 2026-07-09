import { CloudTaskStatus, CloudTaskType } from '@roomote/types';
import { tasks, type CloudJob } from '@roomote/db/server';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockFindFirstCloudJob = vi.fn();
const mockFindManyCloudJobs = vi.fn();
const mockFindFirstTask = vi.fn();
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
const mockDbSelect = vi.fn().mockReturnValue({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]),
      }),
    }),
  }),
});
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
        cloudJobs: {
          findFirst: (...args: unknown[]) => mockFindFirstCloudJob(...args),
          findMany: (...args: unknown[]) => mockFindManyCloudJobs(...args),
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
vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueCloudTask: vi.fn(),
  releaseCloudTask: vi.fn().mockResolvedValue(undefined),
  getTaskUrl: vi.fn().mockReturnValue('https://example.com/task'),
  suggestSlackQuestionChannels: (...args: unknown[]) =>
    mockSuggestSlackQuestionChannels(...args),
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

function makeCloudJob(overrides: Partial<CloudJob> = {}): CloudJob {
  return {
    id: 1,
    type: CloudTaskType.StandardTask,
    userId: 'user-1',
    harness: 'opencode-server',
    status: CloudTaskStatus.Running,
    payload: { repo: 'owner/repo' },
    taskId: 'task-1',
    slackThreadTs: null,
    linearSessionId: null,
    linearIssueId: null,
    linearOrganizationId: null,
    githubPrReactionId: null,
    githubPrCheckRunId: null,
    githubPrReviewCommentId: null,
    prRepo: null,
    prNumber: null,
    prSha: null,
    startedAt: null,
    canceledAt: null,
    completedAt: null,
    ...overrides,
  } as CloudJob;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('finishCloudJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindManyCloudJobs.mockResolvedValue([]);
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
    mockDbTransaction.mockImplementation(
      async (callback: (tx: unknown) => unknown) =>
        callback({
          execute: (...args: unknown[]) => mockDbExecute(...args),
          query: {
            cloudJobs: {
              findFirst: (...args: unknown[]) => mockFindFirstCloudJob(...args),
            },
          },
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
    mockFindFirstCloudJob.mockResolvedValue(makeCloudJob());

    await finishCloudJob({
      id: 1,
      status: CloudTaskStatus.Completed,
    });

    expect(mockCleanupSandboxOidcTargetsForCloudJob).toHaveBeenCalledWith(1);
  });

  it('marks the linked task completed when the job completes', async () => {
    mockFindFirstCloudJob.mockResolvedValue(makeCloudJob());

    await finishCloudJob({
      id: 1,
      status: CloudTaskStatus.Completed,
    });

    expect(mockDbUpdate).toHaveBeenNthCalledWith(2, tasks);
    expect(mockDbUpdateSet).toHaveBeenNthCalledWith(2, {
      completed: true,
      updatedAt: expect.any(Date),
    });
  });

  it('clears the linked task completion flag when the job is canceled', async () => {
    mockFindFirstCloudJob.mockResolvedValue(makeCloudJob());

    await finishCloudJob({
      id: 1,
      status: CloudTaskStatus.Canceled,
    });

    expect(mockDbUpdate).toHaveBeenNthCalledWith(2, tasks);
    expect(mockDbUpdateSet).toHaveBeenNthCalledWith(2, {
      completed: false,
      updatedAt: expect.any(Date),
    });
  });

  it('skips sandbox OIDC cleanup when a job transitions to idle', async () => {
    mockFindFirstCloudJob.mockResolvedValue(makeCloudJob());

    await finishCloudJob({
      id: 1,
      status: CloudTaskStatus.Idle,
    });

    expect(mockCleanupSandboxOidcTargetsForCloudJob).not.toHaveBeenCalled();
  });

  it('enqueues a dedicated GitHub follow-up when a SnapshotResume job finishes without accepting the deferred prompt', async () => {
    const resumeJob = makeCloudJob({
      id: 303,
      type: CloudTaskType.SnapshotResume,
      taskId: 'resume-task-303',
      payload: {
        repo: 'owner/repo',
        sourceSnapshotId: 'snapshot-303',
        sourceCloudJobId: 302,
        resumePrompt: 'Please fix this.',
        resumePromptFallbackTask: {
          type: CloudTaskType.GithubPrReviewFollowUp,
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
    });

    mockFindFirstCloudJob
      .mockResolvedValueOnce(resumeJob)
      .mockResolvedValueOnce(resumeJob);
    vi.mocked(enqueueCloudTask).mockResolvedValue({
      id: 444,
      taskId: 'fallback-task-444',
    } as never);

    await finishCloudJob({
      id: 303,
      status: CloudTaskStatus.Failed,
      error: 'snapshot resume failed',
    });

    expect(enqueueCloudTask).toHaveBeenCalledWith({
      type: CloudTaskType.GithubPrReviewFollowUp,
      payload: {
        repo: 'owner/repo',
        prNumber: 42,
        prTitle: 'Test PR',
        commentId: 99,
        commentBody: '@roomote please fix this',
        followUpSource: 'github_mention',
      },
      userId: 'user-1',
      githubLogin: 'reviewer',
      githubUserId: 2,
    });
    expect(mockDbUpdateSet).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        status: CloudTaskStatus.Failed,
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

  it('records a terminal failed lifecycle event', async () => {
    const job = makeCloudJob({
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
    mockFindFirstCloudJob.mockResolvedValue(job);

    await finishCloudJob({
      id: 12,
      status: CloudTaskStatus.Failed,
      error: 'spawn timeout',
    });

    expect(mockRecordJobLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cloudJobId: 12,
        taskId: 'task-1',
        eventType: 'failed',
        message: 'Cloud job finished with a failure.',
        details: expect.objectContaining({
          stage: 'finish_cloud_job',
          status: CloudTaskStatus.Failed,
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
      const job = makeCloudJob({
        type: CloudTaskType.SlackAppMention,
        slackThreadTs: '111.222',
        payload: {
          repo: 'owner/repo',
          channel: 'C123',
          user: 'U456',
          text: 'test',
          ts: '111.222',
          thread_ts: '111.222',
        },
      });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockFindFirstSlackInstallation.mockResolvedValue({
        botAccessToken: 'xoxb-test',
      });

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Completed,
      });

      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('posts a setup thread reply with a /setup link when setup onboarding completes', async () => {
      const origin = process.env.ROOMOTE_APP_URL || 'http://localhost:13000';
      const job = makeCloudJob({
        type: CloudTaskType.SlackAppMention,
        slackThreadTs: '111.222',
        payload: {
          repo: 'owner/repo',
          channel: 'C123',
          user: 'U456',
          text: 'test',
          ts: '111.222',
          thread_ts: '111.222',
          webPath: '/setup',
        },
      });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Completed,
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
      const job = makeCloudJob({
        type: CloudTaskType.SlackAppMention,
        taskPhase: 'waiting_for_prompt',
        slackThreadTs: '111.222',
        payload: {
          repo: 'owner/repo',
          channel: 'C123',
          user: 'U456',
          text: 'test',
          ts: '111.222',
          thread_ts: '111.222',
          webPath: '/setup',
          environmentDefinitionId: 'env-123',
        } as CloudJob['payload'],
      });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Idle,
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
      const job = makeCloudJob({
        type: CloudTaskType.SlackAppMention,
        taskPhase: 'running',
        slackThreadTs: '111.222',
        payload: {
          repo: 'owner/repo',
          channel: 'C123',
          user: 'U456',
          text: 'test',
          ts: '111.222',
          thread_ts: '111.222',
          webPath: '/setup',
          environmentDefinitionId: 'env-123',
        } as CloudJob['payload'],
      });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Idle,
      });

      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('does not post a setup thread reply when setup onboarding becomes idle without a linked environment', async () => {
      const job = makeCloudJob({
        type: CloudTaskType.SlackAppMention,
        taskPhase: 'waiting_for_prompt',
        slackThreadTs: '111.222',
        payload: {
          repo: 'owner/repo',
          channel: 'C123',
          user: 'U456',
          text: 'test',
          ts: '111.222',
          thread_ts: '111.222',
          webPath: '/setup',
        },
      });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Idle,
      });

      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('falls back to a generic setup completion message when no project name is available', async () => {
      const origin = process.env.ROOMOTE_APP_URL || 'http://localhost:13000';
      const job = makeCloudJob({
        type: CloudTaskType.SlackAppMention,
        slackThreadTs: '111.222',
        payload: {
          repo: '',
          channel: 'C123',
          user: 'U456',
          text: 'test',
          ts: '111.222',
          thread_ts: '111.222',
          webPath: '/setup',
        },
      });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Completed,
      });

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: '111.222',
        text: `Setup is done. Continue on the web: <${origin}/setup?utm_source=slack&utm_medium=link&utm_campaign=setup.onboarding.completed|Open setup>.`,
        unfurl_links: false,
        unfurl_media: false,
      });
    });

    it('posts a setup thread reply for resumed setup snapshot jobs', async () => {
      const origin = process.env.ROOMOTE_APP_URL || 'http://localhost:13000';
      const sourceJob = makeCloudJob({
        id: 1,
        type: CloudTaskType.SlackAppMention,
        slackThreadTs: '111.222',
        payload: {
          repo: 'owner/repo',
          channel: 'C123',
          user: 'U456',
          text: 'test',
          ts: '111.222',
          thread_ts: '111.222',
          webPath: '/setup',
        },
      });
      const resumedJob = makeCloudJob({
        id: 2,
        type: CloudTaskType.SnapshotResume,
        slackThreadTs: '111.222',
        sourceCloudJobId: 1,
        payload: {
          repo: 'owner/repo',
          sourceSnapshotId: 'snapshot-123',
          sourceCloudJobId: 1,
          slackChannel: 'C123',
        },
      });
      mockFindFirstCloudJob
        .mockResolvedValueOnce(resumedJob)
        .mockResolvedValueOnce(sourceJob)
        .mockResolvedValueOnce(sourceJob);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');

      await finishCloudJob({
        id: 2,
        status: CloudTaskStatus.Completed,
      });

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: '111.222',
        text: `Setup for the repo project is done. Continue on the web: <${origin}/setup?utm_source=slack&utm_medium=link&utm_campaign=setup.onboarding.completed|Open setup>.`,
        unfurl_links: false,
        unfurl_media: false,
      });
    });

    it('posts a setup thread reply for resumed setup snapshot jobs that become idle when the source setup job has a linked environment', async () => {
      const origin = process.env.ROOMOTE_APP_URL || 'http://localhost:13000';
      const sourceJob = makeCloudJob({
        id: 1,
        type: CloudTaskType.SlackAppMention,
        slackThreadTs: '111.222',
        payload: {
          repo: 'owner/repo',
          channel: 'C123',
          user: 'U456',
          text: 'test',
          ts: '111.222',
          thread_ts: '111.222',
          webPath: '/setup',
          environmentDefinitionId: 'env-123',
        } as CloudJob['payload'],
      });
      const resumedJob = makeCloudJob({
        id: 2,
        type: CloudTaskType.SnapshotResume,
        taskPhase: 'waiting_for_prompt',
        slackThreadTs: '111.222',
        sourceCloudJobId: 1,
        payload: {
          repo: 'owner/repo',
          sourceSnapshotId: 'snapshot-123',
          sourceCloudJobId: 1,
          slackChannel: 'C123',
        },
      });
      mockFindFirstCloudJob
        .mockResolvedValueOnce(resumedJob)
        .mockResolvedValueOnce(resumedJob)
        .mockResolvedValueOnce(sourceJob)
        .mockResolvedValueOnce(sourceJob);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');

      await finishCloudJob({
        id: 2,
        status: CloudTaskStatus.Idle,
      });

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: '111.222',
        text: `Setup for the repo project is done. Continue on the web: <${origin}/setup?utm_source=slack&utm_medium=link&utm_campaign=setup.onboarding.completed|Open setup>.`,
        unfurl_links: false,
        unfurl_media: false,
      });
    });

    it('posts the setup thread reply only once across repeated idle resume cycles in the same job chain', async () => {
      const rootSetupJob = makeCloudJob({
        id: 1,
        type: CloudTaskType.SlackAppMention,
        slackThreadTs: '111.222',
        payload: {
          repo: 'owner/repo',
          channel: 'C123',
          user: 'U456',
          text: 'test',
          ts: '111.222',
          thread_ts: '111.222',
          webPath: '/setup',
          environmentDefinitionId: 'env-123',
        } as CloudJob['payload'],
      });
      const firstResumeJob = makeCloudJob({
        id: 2,
        type: CloudTaskType.SnapshotResume,
        taskPhase: 'waiting_for_prompt',
        slackThreadTs: '111.222',
        sourceCloudJobId: 1,
        payload: {
          repo: 'owner/repo',
          sourceSnapshotId: 'snapshot-123',
          sourceCloudJobId: 1,
          slackChannel: 'C123',
        },
      });
      const secondResumeJob = makeCloudJob({
        id: 3,
        type: CloudTaskType.SnapshotResume,
        taskPhase: 'waiting_for_prompt',
        slackThreadTs: '111.222',
        sourceCloudJobId: 2,
        payload: {
          repo: 'owner/repo',
          sourceSnapshotId: 'snapshot-456',
          sourceCloudJobId: 2,
          slackChannel: 'C123',
        },
      });

      mockFindFirstCloudJob
        .mockResolvedValueOnce(firstResumeJob)
        .mockResolvedValueOnce(firstResumeJob)
        .mockResolvedValueOnce(rootSetupJob)
        .mockResolvedValueOnce(rootSetupJob)
        .mockResolvedValueOnce(rootSetupJob)
        .mockResolvedValueOnce(secondResumeJob)
        .mockResolvedValueOnce(secondResumeJob)
        .mockResolvedValueOnce(firstResumeJob)
        .mockResolvedValueOnce(rootSetupJob)
        .mockResolvedValueOnce(firstResumeJob)
        .mockResolvedValueOnce(rootSetupJob)
        .mockResolvedValueOnce(firstResumeJob)
        .mockResolvedValueOnce(rootSetupJob);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');
      mockRedisSet.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

      await finishCloudJob({
        id: 2,
        status: CloudTaskStatus.Idle,
      });
      await finishCloudJob({
        id: 3,
        status: CloudTaskStatus.Idle,
      });

      expect(mockRedisSet).toHaveBeenNthCalledWith(
        1,
        'slack:setup-completion:slack-inst-1:1',
        '1',
        'EX',
        2592000,
        'NX',
      );
      expect(mockRedisSet).toHaveBeenNthCalledWith(
        2,
        'slack:setup-completion:slack-inst-1:1',
        '1',
        'EX',
        2592000,
        'NX',
      );
      expect(mockPostMessage).toHaveBeenCalledTimes(1);
    });

    it('posts a setup thread reply when the linked environment is more than five source hops away', async () => {
      const origin = process.env.ROOMOTE_APP_URL || 'http://localhost:13000';
      const resumedJob = makeCloudJob({
        id: 7,
        type: CloudTaskType.SnapshotResume,
        taskPhase: 'waiting_for_prompt',
        slackThreadTs: '111.222',
        sourceCloudJobId: 6,
        payload: {
          repo: 'owner/repo',
          sourceSnapshotId: 'snapshot-123',
          sourceCloudJobId: 6,
          slackChannel: 'C123',
        },
      });
      const sourceJobLevel6 = makeCloudJob({
        id: 6,
        sourceCloudJobId: 5,
      });
      const sourceJobLevel5 = makeCloudJob({
        id: 5,
        sourceCloudJobId: 4,
      });
      const sourceJobLevel4 = makeCloudJob({
        id: 4,
        sourceCloudJobId: 3,
      });
      const sourceJobLevel3 = makeCloudJob({
        id: 3,
        sourceCloudJobId: 2,
      });
      const sourceJobLevel2 = makeCloudJob({
        id: 2,
        sourceCloudJobId: 1,
      });
      const sourceJobLevel1 = makeCloudJob({
        id: 1,
        type: CloudTaskType.SlackAppMention,
        slackThreadTs: '111.222',
        payload: {
          repo: 'owner/repo',
          channel: 'C123',
          user: 'U456',
          text: 'test',
          ts: '111.222',
          thread_ts: '111.222',
          webPath: '/setup',
          environmentDefinitionId: 'env-123',
        } as CloudJob['payload'],
      });
      mockFindFirstCloudJob
        .mockResolvedValueOnce(resumedJob)
        .mockResolvedValueOnce(resumedJob)
        .mockResolvedValueOnce(sourceJobLevel6)
        .mockResolvedValueOnce(sourceJobLevel5)
        .mockResolvedValueOnce(sourceJobLevel4)
        .mockResolvedValueOnce(sourceJobLevel3)
        .mockResolvedValueOnce(sourceJobLevel2)
        .mockResolvedValueOnce(sourceJobLevel1)
        .mockResolvedValueOnce(sourceJobLevel6)
        .mockResolvedValueOnce(sourceJobLevel5)
        .mockResolvedValueOnce(sourceJobLevel4)
        .mockResolvedValueOnce(sourceJobLevel3)
        .mockResolvedValueOnce(sourceJobLevel2)
        .mockResolvedValueOnce(sourceJobLevel1);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });

      await finishCloudJob({
        id: 7,
        status: CloudTaskStatus.Idle,
      });

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: '111.222',
        text: `Setup for the repo project is done. Continue on the web: <${origin}/setup?utm_source=slack&utm_medium=link&utm_campaign=setup.onboarding.completed|Open setup>.`,
        unfurl_links: false,
        unfurl_media: false,
      });
    });

    it('DMs the installing user after their second completed non-unknown task when no channels were joined yet', async () => {
      const job = makeCloudJob({
        id: 2,
        taskId: 'task-2',
        requestedWorkKind: 'implement',
        completedAt: new Date('2026-04-08T12:05:00.000Z'),
      });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        teamId: 'T123',
        botAccessToken: 'xoxb-test',
        updatedAt: new Date('2026-04-08T10:00:00.000Z'),
        joinedChannels: [],
      });
      mockFindManyCloudJobs.mockResolvedValue([
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
      ]);
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
        status: CloudTaskStatus.Completed,
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
      const job = makeCloudJob({
        id: 2,
        taskId: 'task-2',
        requestedWorkKind: 'question',
      });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        teamId: 'T123',
        botAccessToken: 'xoxb-test',
        updatedAt: new Date('2026-04-08T10:00:00.000Z'),
        joinedChannels: [{ channelId: 'CJOINED' }],
      });

      await finishCloudJob({
        id: 2,
        status: CloudTaskStatus.Completed,
      });

      expect(mockOpenConversation).not.toHaveBeenCalled();
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('skips the proactive DM until the second completed non-unknown task is reached', async () => {
      const job = makeCloudJob({
        id: 2,
        taskId: 'task-2',
        requestedWorkKind: 'question',
      });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        teamId: 'T123',
        botAccessToken: 'xoxb-test',
        updatedAt: new Date('2026-04-08T10:00:00.000Z'),
        joinedChannels: [],
      });
      mockFindManyCloudJobs.mockResolvedValue([
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
      ]);
      mockFindFirstSlackUserMapping.mockResolvedValue({
        slackUserId: 'UINSTALLER',
        updatedAt: new Date('2026-04-08T10:00:00.000Z'),
      });

      await finishCloudJob({
        id: 2,
        status: CloudTaskStatus.Completed,
      });

      expect(mockOpenConversation).not.toHaveBeenCalled();
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('skips the proactive DM when the current completed task is unknown work kind', async () => {
      const job = makeCloudJob({
        id: 2,
        taskId: 'task-2',
        requestedWorkKind: 'unknown',
      });
      mockFindFirstCloudJob.mockResolvedValue(job);

      await finishCloudJob({
        id: 2,
        status: CloudTaskStatus.Completed,
      });

      expect(mockFindFirstSlackInstallation).not.toHaveBeenCalled();
      expect(mockOpenConversation).not.toHaveBeenCalled();
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('skips the proactive DM once the deployment onboarding stage is done', async () => {
      const job = makeCloudJob({
        id: 2,
        taskId: 'task-2',
        requestedWorkKind: 'question',
      });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockFindFirstDeploymentSettings.mockResolvedValue({
        slackOnboardingStage: 'done',
      });

      await finishCloudJob({
        id: 2,
        status: CloudTaskStatus.Completed,
      });

      expect(mockFindFirstSlackInstallation).not.toHaveBeenCalled();
      expect(mockOpenConversation).not.toHaveBeenCalled();
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('does not count pre-reinstall non-unknown tasks toward the second-task invite trigger', async () => {
      const job = makeCloudJob({
        id: 2,
        taskId: 'task-new-1',
        requestedWorkKind: 'question',
      });
      mockFindFirstCloudJob.mockResolvedValue(job);
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
      mockFindManyCloudJobs.mockResolvedValue([
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
      ]);

      await finishCloudJob({
        id: 2,
        status: CloudTaskStatus.Completed,
      });

      expect(mockOpenConversation).not.toHaveBeenCalled();
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('skips the proactive DM when the dedupe claim already exists', async () => {
      const job = makeCloudJob({
        id: 2,
        taskId: 'task-2',
        requestedWorkKind: 'question',
      });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        teamId: 'T123',
        botAccessToken: 'xoxb-test',
        updatedAt: new Date('2026-04-08T10:00:00.000Z'),
        joinedChannels: [],
      });
      mockFindManyCloudJobs.mockResolvedValue([
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
      ]);
      mockFindFirstSlackUserMapping.mockResolvedValue({
        slackUserId: 'UINSTALLER',
        updatedAt: new Date('2026-04-08T10:00:00.000Z'),
      });
      mockRedisSet.mockResolvedValue(null);

      await finishCloudJob({
        id: 2,
        status: CloudTaskStatus.Completed,
      });

      expect(mockPostMessage).not.toHaveBeenCalled();
    });
  });

  describe('Slack failure notification', () => {
    it('posts a retryable generic thread reply when a non-setup Slack job fails', async () => {
      const job = makeCloudJob({
        type: CloudTaskType.SlackAppMention,
        slackThreadTs: '111.222',
        payload: {
          repo: 'owner/repo',
          channel: 'C123',
          user: 'U456',
          text: 'test',
          ts: '111.222',
        },
      });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Failed,
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
      const job = makeCloudJob({
        type: CloudTaskType.SlackAppMention,
        slackThreadTs: '111.222',
        cancelRequestedAt: new Date(),
        payload: {
          repo: 'owner/repo',
          channel: 'C123',
          user: 'U456',
          text: 'test',
          ts: '111.222',
        },
      });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Failed,
        error: 'Worker heartbeat stale and instance sb-1 is stopped',
      });

      expect(mockBuildTaskFailedMessage).not.toHaveBeenCalled();
      expect(mockUpdateMessage).not.toHaveBeenCalled();
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('posts a text-only thread reply when a SnapshotResume Slack job fails', async () => {
      const job = makeCloudJob({
        type: CloudTaskType.SnapshotResume,
        slackThreadTs: '111.222',
        payload: {
          repo: 'owner/repo',
          channel: 'C123',
          user: 'U456',
          text: 'test',
          ts: '111.222',
          thread_ts: '111.222',
        },
      });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Failed,
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
      const job = makeCloudJob({
        type: CloudTaskType.SlackAppMention,
        slackThreadTs: '111.222',
        payload: {
          repo: 'owner/repo',
          channel: 'C123',
          user: 'U456',
          text: 'test',
          ts: '111.222',
        },
      });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockGetSlackStartedMessageTs.mockResolvedValue(null);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Failed,
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
      const job = makeCloudJob({
        type: CloudTaskType.SlackAppMention,
        slackThreadTs: '111.222',
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
      });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Failed,
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
      const job = makeCloudJob({
        type: CloudTaskType.SlackAppMention,
        slackThreadTs: '111.222',
        payload: {
          repo: 'owner/repo',
          channel: 'C123',
          user: 'U456',
          text: 'test',
          ts: '111.222',
          thread_ts: '111.222',
          webPath: '/setup',
        },
      });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockGetSlackStartedMessageTs.mockResolvedValue('111.333');
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Failed,
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

    it('skips Slack notification when job has no slackThreadTs', async () => {
      const job = makeCloudJob({ slackThreadTs: null });
      mockFindFirstCloudJob.mockResolvedValue(job);

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Failed,
        error: 'some error',
      });

      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('skips Slack notification on non-Failed status', async () => {
      const job = makeCloudJob({
        type: CloudTaskType.SlackAppMention,
        slackThreadTs: '111.222',
        payload: {
          repo: 'owner/repo',
          channel: 'C123',
          user: 'U456',
          text: 'test',
          ts: '111.222',
        },
      });
      mockFindFirstCloudJob.mockResolvedValue(job);

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Completed,
      });

      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('does not throw when Slack notification fails', async () => {
      const job = makeCloudJob({
        type: CloudTaskType.SlackAppMention,
        slackThreadTs: '111.222',
        payload: {
          repo: 'owner/repo',
          channel: 'C123',
          user: 'U456',
          text: 'test',
          ts: '111.222',
        },
      });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockFindFirstSlackInstallation.mockResolvedValue({
        id: 'slack-inst-1',
        botAccessToken: 'xoxb-test',
        isActive: true,
      });
      mockPostMessage.mockRejectedValue(new Error('Slack API error'));

      // Should not throw
      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Failed,
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
    } as unknown as CloudJob['payload'];

    beforeEach(() => {
      mockCreateTeamsCommunicationProviderFromEnv.mockReturnValue({
        postMessage: mockTeamsPostMessage,
      });
    });

    it('posts a startup-failure thread reply when a Teams job fails before runtime', async () => {
      const job = makeCloudJob({ payload: teamsPayload });
      mockFindFirstCloudJob.mockResolvedValue(job);

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Failed,
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
      const job = makeCloudJob({
        payload: teamsPayload,
        cancelRequestedAt: new Date(),
      });
      mockFindFirstCloudJob.mockResolvedValue(job);

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Failed,
        error: 'spawn timeout',
      });

      expect(mockTeamsPostMessage).not.toHaveBeenCalled();
    });

    it('posts runtime-failure copy when the runtime task already started', async () => {
      const job = makeCloudJob({
        payload: teamsPayload,
        result: { runtimeTaskId: 'runtime-1' },
      } as Partial<CloudJob>);
      mockFindFirstCloudJob.mockResolvedValue(job);

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Failed,
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
      const job = makeCloudJob({ payload: { repo: 'owner/repo' } });
      mockFindFirstCloudJob.mockResolvedValue(job);

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Failed,
        error: 'some error',
      });

      expect(mockTeamsPostMessage).not.toHaveBeenCalled();
    });

    it('skips the Teams notification on non-Failed status', async () => {
      const job = makeCloudJob({ payload: teamsPayload });
      mockFindFirstCloudJob.mockResolvedValue(job);

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Completed,
      });

      expect(mockTeamsPostMessage).not.toHaveBeenCalled();
    });

    it('skips the Teams notification when bot credentials are not configured', async () => {
      const job = makeCloudJob({ payload: teamsPayload });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockCreateTeamsCommunicationProviderFromEnv.mockReturnValue(null);

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Failed,
        error: 'some error',
      });

      expect(mockTeamsPostMessage).not.toHaveBeenCalled();
    });

    it('does not throw when the Teams notification fails', async () => {
      const job = makeCloudJob({ payload: teamsPayload });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockTeamsPostMessage.mockRejectedValue(new Error('Teams API error'));

      // Should not throw
      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Failed,
        error: 'test error',
      });
    });
  });

  describe('GitHub conflict resolution comments', () => {
    it('posts the persisted resolution summary for completed conflict jobs', async () => {
      const job = makeCloudJob({
        type: CloudTaskType.GithubPrConflictResolve,
        prRepo: 'owner/repo',
        prNumber: 42,
        result: {
          conflictResolutionSummary: {
            resolvedFiles: ['apps/api/src/file.ts'],
            controversialDecisions: [
              'Kept the incoming branch validation check.',
            ],
            warnings: [],
          },
        },
      });
      mockFindFirstCloudJob.mockResolvedValue(job);

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Completed,
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
      const job = makeCloudJob({
        type: CloudTaskType.GithubPrConflictResolve,
        prRepo: 'owner/repo',
        prNumber: 42,
      });
      mockFindFirstCloudJob.mockResolvedValue(job);

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Completed,
      });

      expect(mockCreateIssueComment).toHaveBeenCalledWith('github-token', {
        owner: 'owner',
        repo: 'repo',
        issue_number: 42,
        body: 'Resolved merge conflicts on this PR.',
      });
    });

    it('posts the simplified failure comment for failed conflict jobs', async () => {
      const job = makeCloudJob({
        type: CloudTaskType.GithubPrConflictResolve,
        prRepo: 'owner/repo',
        prNumber: 42,
      });
      mockFindFirstCloudJob.mockResolvedValue(job);

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Failed,
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
  });

  describe('Linear failure notification', () => {
    it('emits an error activity when status is Failed and job has linearSessionId', async () => {
      const job = makeCloudJob({
        linearSessionId: 'session-abc',
      });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockFindLinearDeploymentMcpConnection.mockResolvedValue({
        id: 'linear-conn-1',
      });

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Failed,
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
      const job = makeCloudJob({
        linearSessionId: 'session-abc',
        cancelRequestedAt: new Date(),
      });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockFindLinearDeploymentMcpConnection.mockResolvedValue({
        id: 'linear-conn-1',
      });

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Failed,
        error: 'spawn failure',
      });

      expect(mockEmitError).not.toHaveBeenCalled();
    });

    it('skips Linear notification when job has no linearSessionId', async () => {
      const job = makeCloudJob({ linearSessionId: null });
      mockFindFirstCloudJob.mockResolvedValue(job);

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Failed,
        error: 'some error',
      });

      expect(mockEmitError).not.toHaveBeenCalled();
    });

    it('skips Linear notification on non-Failed status', async () => {
      const job = makeCloudJob({ linearSessionId: 'session-abc' });
      mockFindFirstCloudJob.mockResolvedValue(job);

      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Completed,
      });

      expect(mockEmitError).not.toHaveBeenCalled();
    });

    it('does not throw when Linear notification fails', async () => {
      const job = makeCloudJob({ linearSessionId: 'session-abc' });
      mockFindFirstCloudJob.mockResolvedValue(job);
      mockFindLinearDeploymentMcpConnection.mockResolvedValue({
        id: 'linear-conn-1',
      });
      mockEmitError.mockRejectedValue(new Error('Linear API error'));

      // Should not throw
      await finishCloudJob({
        id: 1,
        status: CloudTaskStatus.Failed,
        error: 'test error',
      });
    });
  });
});
