const {
  mockCreateRunToken,
  mockCreateTRPCProxyClient,
  mockEnqueueTask,
  mockGetTaskChannelBindings,
  mockFindLatestTaskRun,
  mockHttpBatchLink,
  mockSendPromptMutate,
  mockSteerTaskMutate,
  mockTrackLatestUserMessageForSlackQuote,
  mockRestoreActingUserIdAfterFailedDelivery,
  mockUpdateActingUserIdIfNeeded,
  mockUserFindFirst,
} = vi.hoisted(() => ({
  mockCreateRunToken: vi.fn(),
  mockCreateTRPCProxyClient: vi.fn(),
  mockEnqueueTask: vi.fn(),
  mockGetTaskChannelBindings: vi.fn(),
  mockFindLatestTaskRun: vi.fn(),
  mockHttpBatchLink: vi.fn((options) => options),
  mockSendPromptMutate: vi.fn(),
  mockSteerTaskMutate: vi.fn(),
  mockTrackLatestUserMessageForSlackQuote: vi.fn(),
  mockRestoreActingUserIdAfterFailedDelivery: vi.fn(),
  mockUpdateActingUserIdIfNeeded: vi.fn(),
  mockUserFindFirst: vi.fn(),
}));

vi.mock('../acting-user-sync', () => ({
  restoreActingUserIdAfterFailedDelivery:
    mockRestoreActingUserIdAfterFailedDelivery,
  updateActingUserIdIfNeeded: mockUpdateActingUserIdIfNeeded,
}));

vi.mock('@roomote/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/auth')>();

  return {
    ...actual,
    createRunToken: mockCreateRunToken,
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
  enqueueTask: mockEnqueueTask,
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
  findLatestTaskRun: mockFindLatestTaskRun,
  getTaskChannelBindings: mockGetTaskChannelBindings,
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

function createActiveRun(
  overrides: Partial<{
    id: number;
    status: string;
    sandboxServerUrl: string | null;
    userId: string | null;
    actingUserId: string | null;
    snapshotId: string | null;
    snapshotCreatedAt: Date | null;
    sourceRunId: number | null;
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
    sourceRunId: null,
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
    mockCreateRunToken.mockResolvedValue('run-token');
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
    mockEnqueueTask.mockResolvedValue({ id: 77, taskId: 'task-1' });
    mockGetTaskChannelBindings.mockResolvedValue({
      slackChannelId: 'C123',
      slackThreadTs: '111.222',
      linearSessionId: null,
      linearIssueId: null,
      linearOrganizationId: null,
    });
    mockTrackLatestUserMessageForSlackQuote.mockResolvedValue(undefined);
    mockRestoreActingUserIdAfterFailedDelivery.mockResolvedValue(undefined);
    mockUpdateActingUserIdIfNeeded.mockImplementation(
      async ({ currentActingUserId, nextActingUserId, preserveActor }) =>
        !preserveActor && currentActingUserId !== nextActingUserId,
    );
    mockUserFindFirst.mockResolvedValue({
      name: 'Alice',
      email: 'alice@example.com',
    });
  });

  it('writes the acting user BEFORE delivering the prompt to the sandbox', async () => {
    // Ordering is the security property: the run's actingUserId selects
    // whose credentials actor-scoped routes resolve, so the trusted switch
    // must land before the new sender's prompt can run.
    mockFindLatestTaskRun.mockResolvedValue(
      createActiveRun({ actingUserId: 'user-1' }),
    );

    const result = await sendMessageToTask({
      taskId: 'task-1',
      userId: 'user-2',
      message: 'Continue as the new sender.',
    });

    expect(result).toEqual({ success: true, result: { ok: true } });
    expect(mockUpdateActingUserIdIfNeeded).toHaveBeenCalledWith({
      runId: 42,
      currentActingUserId: 'user-1',
      nextActingUserId: 'user-2',
      preserveActor: false,
    });
    expect(
      mockUpdateActingUserIdIfNeeded.mock.invocationCallOrder[0]!,
    ).toBeLessThan(mockSendPromptMutate.mock.invocationCallOrder[0]!);
    expect(mockSendPromptMutate).toHaveBeenCalledWith({
      prompt: 'Continue as the new sender.',
      autoSteerWhenQueued: true,
    });
  });

  it('does not deliver the prompt when the pre-delivery acting-user write fails', async () => {
    mockFindLatestTaskRun.mockResolvedValue(
      createActiveRun({ actingUserId: 'user-1' }),
    );
    mockUpdateActingUserIdIfNeeded.mockRejectedValueOnce(
      new Error('db unavailable'),
    );

    const result = await sendMessageToTask({
      taskId: 'task-1',
      userId: 'user-2',
      message: 'Continue as the new sender.',
    });

    expect(result).toEqual({
      success: false,
      error: 'db unavailable',
      status: 500,
    });
    expect(mockSendPromptMutate).not.toHaveBeenCalled();
    expect(mockRestoreActingUserIdAfterFailedDelivery).not.toHaveBeenCalled();
  });

  it('rolls back the actor when prompt delivery fails after the switch', async () => {
    mockFindLatestTaskRun.mockResolvedValue(
      createActiveRun({ actingUserId: 'user-1' }),
    );
    mockSendPromptMutate.mockRejectedValueOnce(
      new Error('sandbox delivery failed'),
    );

    const result = await sendMessageToTask({
      taskId: 'task-1',
      userId: 'user-2',
      message: 'Continue as the new sender.',
    });

    expect(result).toEqual({
      success: false,
      error: 'sandbox delivery failed',
      status: 500,
    });
    expect(mockRestoreActingUserIdAfterFailedDelivery).toHaveBeenCalledWith({
      handlerName: 'sendMessageToTask',
      runId: 42,
      previousActingUserId: 'user-1',
      attemptedActingUserId: 'user-2',
    });
  });

  it('writes the acting user BEFORE delivering steering prompts to the sandbox', async () => {
    mockFindLatestTaskRun.mockResolvedValue(
      createActiveRun({ actingUserId: 'user-1' }),
    );

    const result = await steerMessageToTask({
      taskId: 'task-1',
      userId: 'user-2',
      message: 'Steer as the new sender.',
    });

    expect(result).toEqual({ success: true, result: { ok: true } });
    expect(mockUpdateActingUserIdIfNeeded).toHaveBeenCalledWith({
      runId: 42,
      currentActingUserId: 'user-1',
      nextActingUserId: 'user-2',
      preserveActor: false,
    });
    expect(
      mockUpdateActingUserIdIfNeeded.mock.invocationCallOrder[0]!,
    ).toBeLessThan(mockSteerTaskMutate.mock.invocationCallOrder[0]!);
  });

  it('rolls back the actor when steering delivery fails after the switch', async () => {
    mockFindLatestTaskRun.mockResolvedValue(
      createActiveRun({ actingUserId: 'user-1' }),
    );
    mockSteerTaskMutate.mockRejectedValueOnce(
      new Error('sandbox delivery failed'),
    );

    const result = await steerMessageToTask({
      taskId: 'task-1',
      userId: 'user-2',
      message: 'Steer as the new sender.',
    });

    expect(result).toEqual({
      success: false,
      error: 'sandbox delivery failed',
      status: 500,
    });
    expect(mockRestoreActingUserIdAfterFailedDelivery).toHaveBeenCalledWith({
      handlerName: 'steerMessageToTask',
      runId: 42,
      previousActingUserId: 'user-1',
      attemptedActingUserId: 'user-2',
    });
  });

  it('stores the latest user message for active Slack-thread tasks', async () => {
    mockFindLatestTaskRun.mockResolvedValue(createActiveRun());

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
      runId: 42,
      text: 'Please keep the existing payout logic.',
      userName: 'Alice',
      onError: expect.any(Function),
    });
    expect(mockCreateRunToken).toHaveBeenCalledWith({
      runId: 42,
      userId: 'user-1',
      timeoutMs: 15 * 60 * 1000,
    });
    expect(mockHttpBatchLink).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://sandbox.example.com/trpc',
      }),
    );
    expect(mockHttpBatchLink.mock.calls[0]?.[0].headers()).toEqual({
      Authorization: 'Bearer run-token',
    });
    expect(mockSendPromptMutate).toHaveBeenCalledWith({
      prompt: 'Please keep the existing payout logic.',
      source: 'web',
      clientMessageId: 'client-1',
    });
  });

  it('does not store the latest user message for tasks without Slack thread context', async () => {
    mockFindLatestTaskRun.mockResolvedValue(
      createActiveRun({
        payload: { repo: 'acme/app' },
      }),
    );
    mockGetTaskChannelBindings.mockResolvedValue({
      slackChannelId: null,
      slackThreadTs: null,
      linearSessionId: null,
      linearIssueId: null,
      linearOrganizationId: null,
    });

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

  it('stores the latest user message on the resumed Slack run when resuming from snapshot', async () => {
    mockFindLatestTaskRun.mockResolvedValue(
      createActiveRun({
        status: 'completed',
        sandboxServerUrl: null,
        snapshotId: 'snap-1',
        sourceRunId: null,
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
        runId: 77,
        taskId: 'task-1',
      },
    });
    expect(mockTrackLatestUserMessageForSlackQuote).toHaveBeenCalledWith({
      runId: 77,
      text: 'Resume and use the same thread.',
      userName: 'Alice',
      onError: expect.any(Function),
    });
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            resumePrompt: 'Resume and use the same thread.',
            resumePromptSource: 'web',
            resumePromptClientMessageId: 'client-2',
          }),
        }),
        // The follow-up sender becomes the resume run's acting user.
        actingUserId: 'user-1',
      }),
      expect.any(Object),
    );
  });

  it('returns a clear error when a sleeping task snapshot has expired', async () => {
    mockFindLatestTaskRun.mockResolvedValue(
      createActiveRun({
        status: 'completed',
        sandboxServerUrl: null,
        snapshotId: 'snap-expired',
        snapshotCreatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        sourceRunId: null,
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
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockTrackLatestUserMessageForSlackQuote).not.toHaveBeenCalled();
  });

  it('still sends prompts when Slack quote context lookup fails', async () => {
    mockFindLatestTaskRun.mockResolvedValue(createActiveRun());
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
    mockFindLatestTaskRun.mockResolvedValue(createActiveRun());
    mockUserFindFirst.mockResolvedValue({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
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
      userName: 'Ada Lovelace',
    });
  });

  it('stores the latest user message for steerMessageToTask on active Slack-thread tasks', async () => {
    mockFindLatestTaskRun.mockResolvedValue(createActiveRun());

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
      runId: 42,
      text: 'Pause the implementation and inspect the failing test.',
      userName: 'Alice',
      onError: expect.any(Function),
    });
    expect(mockCreateRunToken).toHaveBeenCalledWith({
      runId: 42,
      userId: 'user-1',
      timeoutMs: 15 * 60 * 1000,
    });
    expect(mockSteerTaskMutate).toHaveBeenCalledWith({
      prompt: 'Pause the implementation and inspect the failing test.',
    });
  });

  it('skips API-side Slack quote tracking for GitHub PR follow-up steering messages but passes the resolved display name to the worker', async () => {
    mockFindLatestTaskRun.mockResolvedValue(createActiveRun());
    mockUserFindFirst.mockResolvedValue({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
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
      userName: 'Ada Lovelace',
    });
  });

  it('uses an explicit workerQuoteUserName override instead of resolving the sender user, so unlinked commenters are not misattributed to the task owner', async () => {
    mockFindLatestTaskRun.mockResolvedValue(createActiveRun());

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
    mockFindLatestTaskRun.mockResolvedValue(createActiveRun());
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
    mockFindLatestTaskRun.mockResolvedValue(
      createActiveRun({
        status: 'completed',
        sandboxServerUrl: null,
        snapshotId: 'snap-1',
        sourceRunId: null,
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
        runId: 77,
        taskId: 'task-1',
      },
    });
    expect(mockTrackLatestUserMessageForSlackQuote).not.toHaveBeenCalled();
  });
});
