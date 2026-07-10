import { appRouter } from '../../routers';
import type { Context } from '../../trpc';
import type { JobTokenContext } from '@roomote/types';

const { mockPrepareActorScopedTurn } = vi.hoisted(() => ({
  mockPrepareActorScopedTurn: vi.fn(),
}));

const {
  mockFindFirstById,
  mockGetRoomoteConfig,
  mockTrackSlackReplyQuote,
  mockClearSlackReplyQuote,
} = vi.hoisted(() => ({
  mockFindFirstById: vi.fn(),
  mockGetRoomoteConfig: vi.fn(),
  mockTrackSlackReplyQuote: vi.fn(),
  mockClearSlackReplyQuote: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    cloudJobs: {
      findFirstById: mockFindFirstById,
    },
  },
}));

vi.mock('@roomote/slack/client', () => ({
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
}));

vi.mock('../../../mcp/roomote-mcp-server/config', () => ({
  getRoomoteConfig: mockGetRoomoteConfig,
}));

vi.mock('../../../mcp/roomote-mcp-server/slack-api-client', () => ({
  trackSlackReplyQuote: mockTrackSlackReplyQuote,
  clearSlackReplyQuote: mockClearSlackReplyQuote,
}));

function createCaller(options?: {
  harnessManagerAvailable?: boolean;
  cancelTaskAndWaitForTurnExit?: () => Promise<boolean>;
  sendFollowUpPrompt?: (args: {
    prompt: string;
    images?: string[];
    workflowPhase?: string;
    autoSteerWhenQueued?: boolean;
    userId?: string;
  }) => boolean;
  supportsNativeTurnSteering?: boolean;
  status?: {
    phase: string;
    taskStateEvent: null;
    sessionId: string | undefined;
    isConnected: boolean;
    sleepRemainingMs: number | null;
    lastErrorMessage: string | undefined;
  };
}) {
  const harnessManagerAvailable = options?.harnessManagerAvailable ?? true;
  const cancelTaskAndWaitForTurnExit = vi.fn(
    options?.cancelTaskAndWaitForTurnExit ?? (() => Promise.resolve(true)),
  );

  const sendFollowUpPrompt = vi.fn(options?.sendFollowUpPrompt ?? (() => true));
  const getStatus = vi.fn(
    () =>
      options?.status ?? {
        phase: 'running',
        taskStateEvent: null,
        sessionId: 'task-1',
        isConnected: true,
        sleepRemainingMs: null,
        lastErrorMessage: undefined,
      },
  );

  const harnessManager = harnessManagerAvailable
    ? {
        cancelTaskAndWaitForTurnExit,
        sendFollowUpPrompt,
        getStatus,
        supportsNativeTurnSteering:
          options?.supportsNativeTurnSteering ?? false,
      }
    : undefined;

  const ctx = {
    workingDirectory: '/tmp',
    harness: {
      isConnected: true,
      getPendingUserInputRequests: () => [],
    },
    harnessManager,
    auth: {
      cloudJobId: 1,
      userId: 'sender-user-1',
      principal: 'user',
      tokenType: 'cj',
      version: 1,
    } satisfies JobTokenContext,
    cloudJobId: 1,
    prepareActorScopedTurn: mockPrepareActorScopedTurn,
  } as unknown as Context;

  return {
    caller: appRouter.createCaller(ctx),
    cancelTaskAndWaitForTurnExit,
    sendFollowUpPrompt,
    getStatus,
  };
}

describe('steerTask procedure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrepareActorScopedTurn.mockResolvedValue(undefined);
    mockFindFirstById.mockResolvedValue({
      payload: {
        channel: 'C123',
        thread_ts: '111.222',
      },
      slackThreadTs: '111.222',
    });
    mockGetRoomoteConfig.mockReturnValue({
      token: 'job-token',
      platformApiUrl: 'https://platform.example.com',
    });
    mockTrackSlackReplyQuote.mockResolvedValue({ success: true });
    mockClearSlackReplyQuote.mockResolvedValue({ success: true });
  });

  it('cancels active turn before sending steer prompt', async () => {
    const { caller, cancelTaskAndWaitForTurnExit, sendFollowUpPrompt } =
      createCaller();

    const result = await caller.commands.steerTask({
      prompt: 'Switch to fixing tests first',
      images: ['data:image/png;base64,abc'],
    });

    expect(result).toEqual({ success: true });
    expect(cancelTaskAndWaitForTurnExit).toHaveBeenCalledTimes(1);
    expect(
      cancelTaskAndWaitForTurnExit.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockPrepareActorScopedTurn.mock.invocationCallOrder[0] ??
        Number.MAX_SAFE_INTEGER,
    );
    expect(mockPrepareActorScopedTurn).toHaveBeenCalledWith('sender-user-1');
    expect(mockPrepareActorScopedTurn.mock.invocationCallOrder[0]).toBeLessThan(
      sendFollowUpPrompt.mock.invocationCallOrder[0]!,
    );
    expect(mockFindFirstById).toHaveBeenCalledWith(1);
    expect(mockTrackSlackReplyQuote).toHaveBeenCalledWith(
      {
        token: 'job-token',
        platformApiUrl: 'https://platform.example.com',
      },
      {
        cloudJobId: 1,
        text: 'Switch to fixing tests first',
        userName: 'Someone',
      },
    );
    expect(mockTrackSlackReplyQuote.mock.invocationCallOrder[0]).toBeLessThan(
      sendFollowUpPrompt.mock.invocationCallOrder[0]!,
    );
    expect(sendFollowUpPrompt).toHaveBeenCalledWith({
      prompt: 'Switch to fixing tests first',
      images: ['data:image/png;base64,abc'],
      userId: 'sender-user-1',
    });
    expect(
      cancelTaskAndWaitForTurnExit.mock.invocationCallOrder[0],
    ).toBeLessThan(
      sendFollowUpPrompt.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('uses native turn steering without canceling when supported', async () => {
    const { caller, cancelTaskAndWaitForTurnExit, sendFollowUpPrompt } =
      createCaller({ supportsNativeTurnSteering: true });

    const result = await caller.commands.steerTask({
      prompt: 'Steer this into the current turn',
      images: ['data:image/png;base64,abc'],
    });

    expect(result).toEqual({ success: true });
    expect(cancelTaskAndWaitForTurnExit).not.toHaveBeenCalled();
    expect(mockPrepareActorScopedTurn).toHaveBeenCalledWith('sender-user-1', {
      allowMcpReconnect: false,
    });
    expect(sendFollowUpPrompt).toHaveBeenCalledWith({
      prompt: 'Steer this into the current turn',
      images: ['data:image/png;base64,abc'],
      autoSteerWhenQueued: true,
      userId: 'sender-user-1',
    });
  });

  it('forwards workflow phase for explicit steer prompts', async () => {
    const { caller, sendFollowUpPrompt } = createCaller({
      supportsNativeTurnSteering: true,
    });

    const result = await caller.commands.steerTask({
      prompt: '/review-code inspect the latest diff',
    });

    expect(result).toEqual({ success: true });
    expect(sendFollowUpPrompt).toHaveBeenCalledWith({
      prompt: '/review-code inspect the latest diff',
      images: undefined,
      workflowPhase: 'review-code',
      autoSteerWhenQueued: true,
      userId: 'sender-user-1',
    });
  });

  it('throws PRECONDITION_FAILED when harness manager is unavailable', async () => {
    const { caller } = createCaller({ harnessManagerAvailable: false });

    await expect(
      caller.commands.steerTask({ prompt: 'Switch directions' }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('allows steering with images when prompt text is blank', async () => {
    const { caller, cancelTaskAndWaitForTurnExit, sendFollowUpPrompt } =
      createCaller();

    const result = await caller.commands.steerTask({
      prompt: '   ',
      images: ['data:image/png;base64,abc'],
    });

    expect(result).toEqual({ success: true });
    expect(cancelTaskAndWaitForTurnExit).toHaveBeenCalledTimes(1);
    expect(sendFollowUpPrompt).toHaveBeenCalledWith({
      prompt: '   ',
      images: ['data:image/png;base64,abc'],
      userId: 'sender-user-1',
    });
    expect(mockTrackSlackReplyQuote).not.toHaveBeenCalled();
  });

  it('sends the follow-up without canceling when there is no active turn', async () => {
    const { caller, cancelTaskAndWaitForTurnExit, sendFollowUpPrompt } =
      createCaller({
        status: {
          phase: 'idle',
          taskStateEvent: null,
          sessionId: undefined,
          isConnected: false,
          sleepRemainingMs: null,
          lastErrorMessage: undefined,
        },
      });

    const result = await caller.commands.steerTask({
      prompt: 'Continue from the queued follow-up',
    });

    expect(result).toEqual({ success: true });
    expect(cancelTaskAndWaitForTurnExit).not.toHaveBeenCalled();
    expect(mockPrepareActorScopedTurn).toHaveBeenCalledWith('sender-user-1');
    expect(sendFollowUpPrompt).toHaveBeenCalledWith({
      prompt: 'Continue from the queued follow-up',
      images: undefined,
      userId: 'sender-user-1',
    });
  });

  it('treats waiting_for_user_input as an active turn', async () => {
    const { caller, cancelTaskAndWaitForTurnExit, sendFollowUpPrompt } =
      createCaller({
        status: {
          phase: 'waiting_for_user_input',
          taskStateEvent: null,
          sessionId: 'task-1',
          isConnected: true,
          sleepRemainingMs: null,
          lastErrorMessage: undefined,
        },
      });

    const result = await caller.commands.steerTask({
      prompt: 'Switch directions',
    });

    expect(result).toEqual({ success: true });
    expect(cancelTaskAndWaitForTurnExit).toHaveBeenCalledTimes(1);
    expect(sendFollowUpPrompt).toHaveBeenCalledWith({
      prompt: 'Switch directions',
      images: undefined,
      userId: 'sender-user-1',
    });
  });

  it('throws INTERNAL_SERVER_ERROR when steering cannot start', async () => {
    const { caller, cancelTaskAndWaitForTurnExit, sendFollowUpPrompt } =
      createCaller({
        sendFollowUpPrompt: () => false,
      });

    await expect(
      caller.commands.steerTask({ prompt: 'Switch directions' }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    expect(cancelTaskAndWaitForTurnExit).toHaveBeenCalledTimes(1);
    expect(mockTrackSlackReplyQuote.mock.invocationCallOrder[0]).toBeLessThan(
      sendFollowUpPrompt.mock.invocationCallOrder[0]!,
    );
    expect(sendFollowUpPrompt).toHaveBeenCalledWith({
      prompt: 'Switch directions',
      images: undefined,
      userId: 'sender-user-1',
    });
    expect(mockClearSlackReplyQuote).toHaveBeenCalledWith(
      {
        token: 'job-token',
        platformApiUrl: 'https://platform.example.com',
      },
      {
        cloudJobId: 1,
      },
    );
  });

  it('throws PRECONDITION_FAILED when the active turn cannot be interrupted', async () => {
    const { caller, sendFollowUpPrompt } = createCaller({
      cancelTaskAndWaitForTurnExit: () => Promise.resolve(false),
    });

    await expect(
      caller.commands.steerTask({ prompt: 'Switch directions' }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });

    expect(mockPrepareActorScopedTurn).not.toHaveBeenCalled();
    expect(sendFollowUpPrompt).not.toHaveBeenCalled();
  });

  it('requires non-empty prompt unless images are provided', async () => {
    const { caller } = createCaller();

    await expect(
      caller.commands.steerTask({ prompt: '   ' }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('throws PRECONDITION_FAILED when actor-scoped preparation fails', async () => {
    mockPrepareActorScopedTurn.mockResolvedValueOnce(false);
    const { caller, sendFollowUpPrompt } = createCaller();

    await expect(
      caller.commands.steerTask({ prompt: 'Switch directions' }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });

    expect(sendFollowUpPrompt).not.toHaveBeenCalled();
  });
});
