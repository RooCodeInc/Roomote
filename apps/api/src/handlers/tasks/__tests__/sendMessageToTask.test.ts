const {
  mockCreateJobToken,
  mockCreateTRPCProxyClient,
  mockEnqueueCloudTask,
  mockFindLatestCloudJob,
  mockHttpBatchLink,
  mockSendPromptMutate,
  mockSteerTaskMutate,
  mockTrackLatestUserMessageForSlackQuote,
  mockUserFindFirst,
} = vi.hoisted(() => ({
  mockCreateJobToken: vi.fn(),
  mockCreateTRPCProxyClient: vi.fn(),
  mockEnqueueCloudTask: vi.fn(),
  mockFindLatestCloudJob: vi.fn(),
  mockHttpBatchLink: vi.fn((options) => options),
  mockSendPromptMutate: vi.fn(),
  mockSteerTaskMutate: vi.fn(),
  mockTrackLatestUserMessageForSlackQuote: vi.fn(),
  mockUserFindFirst: vi.fn(),
}));

vi.mock('@roomote/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/auth')>();

  return {
    ...actual,
    createJobToken: mockCreateJobToken,
  };
});

vi.mock('@trpc/client', () => ({
  createTRPCProxyClient: mockCreateTRPCProxyClient,
  httpBatchLink: mockHttpBatchLink,
  TRPCClientError: class TRPCClientError extends Error {
    cause?: unknown;
  },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueCloudTask: mockEnqueueCloudTask,
}));

vi.mock('@roomote/slack', () => ({
  hasSlackThreadReplyContext: ({
    payload,
    slackThreadTs,
  }: {
    payload: unknown;
    slackThreadTs: string | null;
  }) => {
    const record =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : {};

    return (
      (typeof record.channel === 'string' &&
        typeof record.thread_ts === 'string') ||
      (typeof record.slackChannel === 'string' &&
        typeof slackThreadTs === 'string')
    );
  },
  trackLatestUserMessageForSlackQuote: mockTrackLatestUserMessageForSlackQuote,
}));

vi.mock('../helpers', () => ({
  findLatestCloudJob: mockFindLatestCloudJob,
}));

vi.mock('../../utils', () => ({
  logHandlerError: vi.fn(),
}));

vi.mock('@roomote/db/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/db/server')>();

  return {
    ...actual,
    db: {
      query: {
        users: {
          findFirst: mockUserFindFirst,
        },
        taskPullRequests: {
          findFirst: vi.fn(),
        },
      },
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(),
        })),
      })),
    },
  };
});

import { EXPIRED_SNAPSHOT_RESUME_ERROR } from '@roomote/types';

import { sendMessageToTask, steerMessageToTask } from '../sendMessageToTask';

function createActiveJob(
  overrides: Partial<{
    id: number;
    status: string;
    sandboxServerUrl: string | null;
    userId: string | null;
    actingUserId: string | null;
    snapshotId: string | null;
    snapshotCreatedAt: Date | null;
    sourceCloudJobId: number | null;
    payload: Record<string, unknown> | null;
    port: number | null;
    slackThreadTs: string | null;
    linearSessionId: string | null;
    linearIssueId: string | null;
    linearOrganizationId: string | null;
  }> = {},
) {
  return {
    id: 42,
    status: 'running',
    sandboxServerUrl: 'https://sandbox.example.com',
    userId: 'user-1',
    actingUserId: 'user-1',
    snapshotId: null,
    snapshotCreatedAt: overrides.snapshotId ? new Date() : null,
    sourceCloudJobId: null,
    payload: {
      channel: 'C123',
      thread_ts: '111.222',
    },
    port: null,
    slackThreadTs: '111.222',
    linearSessionId: null,
    linearIssueId: null,
    linearOrganizationId: null,
    ...overrides,
  };
}

describe('sendMessageToTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateJobToken.mockResolvedValue('job-token');
    mockCreateTRPCProxyClient.mockImplementation(() => ({
      commands: {
        sendPrompt: {
          mutate: mockSendPromptMutate,
        },
        steerTask: {
          mutate: mockSteerTaskMutate,
        },
      },
    }));
    mockHttpBatchLink.mockImplementation((options) => options);
    mockSendPromptMutate.mockResolvedValue({ ok: true });
    mockSteerTaskMutate.mockResolvedValue({ ok: true });
    mockEnqueueCloudTask.mockResolvedValue({ id: 77, taskId: 'task-1' });
    mockTrackLatestUserMessageForSlackQuote.mockResolvedValue(undefined);
    mockUserFindFirst.mockResolvedValue({
      name: 'Alice',
      email: 'alice@example.com',
    });
  });

  it('stores the latest user message for active Slack-thread tasks', async () => {
    mockFindLatestCloudJob.mockResolvedValue(createActiveJob());

    const result = await sendMessageToTask({
      taskId: 'task-1',
      userId: 'user-1',
      message: 'Please keep the existing payout logic.',
      source: 'web',
      clientMessageId: 'client-1',
    });

    expect(result).toEqual({
      success: true,
      result: { ok: true },
    });
    expect(mockTrackLatestUserMessageForSlackQuote).toHaveBeenCalledWith({
      cloudJobId: 42,
      text: 'Please keep the existing payout logic.',
      userName: 'Alice',
      onError: expect.any(Function),
    });
    expect(mockCreateJobToken).toHaveBeenCalledWith({
      cloudJobId: 42,
      userId: 'user-1',
      timeoutMs: 15 * 60 * 1000,
    });
    expect(mockHttpBatchLink).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://sandbox.example.com/trpc',
      }),
    );
    expect(mockHttpBatchLink.mock.calls[0]?.[0].headers()).toEqual({
      Authorization: 'Bearer job-token',
    });
    expect(mockSendPromptMutate).toHaveBeenCalledWith({
      prompt: 'Please keep the existing payout logic.',
      source: 'web',
      clientMessageId: 'client-1',
    });
  });

  it('does not store the latest user message for tasks without Slack thread context', async () => {
    mockFindLatestCloudJob.mockResolvedValue(
      createActiveJob({
        payload: { repo: 'acme/app' },
        slackThreadTs: null,
      }),
    );

    const result = await sendMessageToTask({
      taskId: 'task-1',
      userId: 'user-1',
      message: 'This stays in the web UI only.',
    });

    expect(result).toEqual({
      success: true,
      result: { ok: true },
    });
    expect(mockTrackLatestUserMessageForSlackQuote).not.toHaveBeenCalled();
    expect(mockSendPromptMutate).toHaveBeenCalledWith({
      prompt: 'This stays in the web UI only.',
    });
  });

  it('stores the latest user message on the resumed Slack job when resuming from snapshot', async () => {
    mockFindLatestCloudJob.mockResolvedValue(
      createActiveJob({
        status: 'completed',
        sandboxServerUrl: null,
        snapshotId: 'snap-1',
        sourceCloudJobId: null,
        payload: {
          repo: 'acme/app',
          slackChannel: 'C123',
        },
      }),
    );
    const result = await sendMessageToTask({
      taskId: 'task-1',
      userId: 'user-1',
      message: 'Resume and use the same thread.',
      source: 'web',
      clientMessageId: 'client-2',
    });

    expect(result).toEqual({
      success: true,
      result: {
        resumed: true,
        cloudJobId: 77,
        taskId: 'task-1',
      },
    });
    expect(mockTrackLatestUserMessageForSlackQuote).toHaveBeenCalledWith({
      cloudJobId: 77,
      text: 'Resume and use the same thread.',
      userName: 'Alice',
      onError: expect.any(Function),
    });
    expect(mockEnqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          resumePrompt: 'Resume and use the same thread.',
          resumePromptSource: 'web',
          resumePromptClientMessageId: 'client-2',
        }),
      }),
      expect.any(Object),
    );
  });

  it('returns a clear error when a sleeping task snapshot has expired', async () => {
    mockFindLatestCloudJob.mockResolvedValue(
      createActiveJob({
        status: 'completed',
        sandboxServerUrl: null,
        snapshotId: 'snap-expired',
        snapshotCreatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        sourceCloudJobId: null,
        payload: {
          repo: 'acme/app',
          slackChannel: 'C123',
        },
      }),
    );

    const result = await sendMessageToTask({
      taskId: 'task-1',
      userId: 'user-1',
      message: 'Try to wake the expired task.',
    });

    expect(result).toEqual({
      success: false,
      error: EXPIRED_SNAPSHOT_RESUME_ERROR,
      status: 409,
    });
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
    expect(mockTrackLatestUserMessageForSlackQuote).not.toHaveBeenCalled();
  });

  it('still sends prompts when Slack quote context lookup fails', async () => {
    mockFindLatestCloudJob.mockResolvedValue(createActiveJob());
    mockUserFindFirst.mockRejectedValueOnce(new Error('db failed'));

    const result = await sendMessageToTask({
      taskId: 'task-1',
      userId: 'user-1',
      message: 'Please keep the existing payout logic.',
    });

    expect(result).toEqual({
      success: true,
      result: { ok: true },
    });
    expect(mockTrackLatestUserMessageForSlackQuote).not.toHaveBeenCalled();
    expect(mockSendPromptMutate).toHaveBeenCalledWith({
      prompt: 'Please keep the existing payout logic.',
    });
  });

  it('passes the resolved display name to the worker for GitHub PR follow-up sendPrompt messages', async () => {
    mockFindLatestCloudJob.mockResolvedValue(createActiveJob());
    mockUserFindFirst.mockResolvedValue({
      name: 'Matt Rubens',
      email: 'matt@example.com',
    });

    const result = await sendMessageToTask({
      taskId: 'task-1',
      userId: 'user-1',
      message: '<github-pr-follow-up>Route this through the existing PR task.',
      senderMode: 'github_pr_follow_up',
    });

    expect(result).toEqual({
      success: true,
      result: { ok: true },
    });
    expect(mockTrackLatestUserMessageForSlackQuote).not.toHaveBeenCalled();
    expect(mockSendPromptMutate).toHaveBeenCalledWith({
      prompt: '<github-pr-follow-up>Route this through the existing PR task.',
      userName: 'Matt Rubens',
    });
  });

  it('stores the latest user message for steerMessageToTask on active Slack-thread tasks', async () => {
    mockFindLatestCloudJob.mockResolvedValue(createActiveJob());

    const result = await steerMessageToTask({
      taskId: 'task-1',
      userId: 'user-1',
      message: 'Pause the implementation and inspect the failing test.',
    });

    expect(result).toEqual({
      success: true,
      result: { ok: true },
    });
    expect(mockTrackLatestUserMessageForSlackQuote).toHaveBeenCalledWith({
      cloudJobId: 42,
      text: 'Pause the implementation and inspect the failing test.',
      userName: 'Alice',
      onError: expect.any(Function),
    });
    expect(mockCreateJobToken).toHaveBeenCalledWith({
      cloudJobId: 42,
      userId: 'user-1',
      timeoutMs: 15 * 60 * 1000,
    });
    expect(mockSteerTaskMutate).toHaveBeenCalledWith({
      prompt: 'Pause the implementation and inspect the failing test.',
    });
  });

  it('skips API-side Slack quote tracking for GitHub PR follow-up steering messages but passes the resolved display name to the worker', async () => {
    mockFindLatestCloudJob.mockResolvedValue(createActiveJob());
    mockUserFindFirst.mockResolvedValue({
      name: 'Matt Rubens',
      email: 'matt@example.com',
    });

    const result = await steerMessageToTask({
      taskId: 'task-1',
      userId: 'user-1',
      message: '<github-pr-follow-up>Route this through the existing PR task.',
      senderMode: 'github_pr_follow_up',
    });

    expect(result).toEqual({
      success: true,
      result: { ok: true },
    });
    expect(mockTrackLatestUserMessageForSlackQuote).not.toHaveBeenCalled();
    expect(mockUserFindFirst).toHaveBeenCalledWith(expect.anything());
    expect(mockSteerTaskMutate).toHaveBeenCalledWith({
      prompt: '<github-pr-follow-up>Route this through the existing PR task.',
      userName: 'Matt Rubens',
    });
  });

  it('uses an explicit workerQuoteUserName override instead of resolving the sender user, so unlinked commenters are not misattributed to the task owner', async () => {
    mockFindLatestCloudJob.mockResolvedValue(createActiveJob());

    const result = await steerMessageToTask({
      taskId: 'task-1',
      userId: 'user-1',
      message: '<github-pr-follow-up>Route this through the existing PR task.',
      senderMode: 'github_pr_follow_up',
      workerQuoteUserName: 'octocat',
    });

    expect(result).toEqual({
      success: true,
      result: { ok: true },
    });
    expect(mockUserFindFirst).not.toHaveBeenCalled();
    expect(mockSteerTaskMutate).toHaveBeenCalledWith({
      prompt: '<github-pr-follow-up>Route this through the existing PR task.',
      userName: 'octocat',
    });
  });

  it('still steers GitHub PR follow-ups when the display name lookup fails', async () => {
    mockFindLatestCloudJob.mockResolvedValue(createActiveJob());
    mockUserFindFirst.mockRejectedValueOnce(new Error('db failed'));

    const result = await steerMessageToTask({
      taskId: 'task-1',
      userId: 'user-1',
      message: '<github-pr-follow-up>Route this through the existing PR task.',
      senderMode: 'github_pr_follow_up',
    });

    expect(result).toEqual({
      success: true,
      result: { ok: true },
    });
    expect(mockSteerTaskMutate).toHaveBeenCalledWith({
      prompt: '<github-pr-follow-up>Route this through the existing PR task.',
    });
  });

  it('skips Slack quote tracking when GitHub PR follow-up steering resumes from snapshot', async () => {
    mockFindLatestCloudJob.mockResolvedValue(
      createActiveJob({
        status: 'completed',
        sandboxServerUrl: null,
        snapshotId: 'snap-1',
        sourceCloudJobId: null,
        payload: {
          repo: 'acme/app',
          slackChannel: 'C123',
        },
      }),
    );

    const result = await steerMessageToTask({
      taskId: 'task-1',
      userId: 'user-1',
      message: '<github-pr-follow-up>Resume the existing PR task.',
      senderMode: 'github_pr_follow_up',
    });

    expect(result).toEqual({
      success: true,
      result: {
        resumed: true,
        cloudJobId: 77,
        taskId: 'task-1',
      },
    });
    expect(mockTrackLatestUserMessageForSlackQuote).not.toHaveBeenCalled();
  });
});
