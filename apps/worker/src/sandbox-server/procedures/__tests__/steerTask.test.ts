import { appRouter } from '../../routers';
import type { Context } from '../../trpc';
import type {
  AcpRequestUserInputQuestion,
  RunTokenContext,
} from '@roomote/types';

const { mockPrepareActorScopedTurn } = vi.hoisted(() => ({
  mockPrepareActorScopedTurn: vi.fn(),
}));

const {
  mockFindFirstById,
  mockGetRoomoteConfig,
  mockSuppressSlackReplyQuote,
  mockTrackSlackReplyQuote,
  mockClearSlackReplyQuote,
} = vi.hoisted(() => ({
  mockFindFirstById: vi.fn(),
  mockGetRoomoteConfig: vi.fn(),
  mockSuppressSlackReplyQuote: vi.fn(),
  mockTrackSlackReplyQuote: vi.fn(),
  mockClearSlackReplyQuote: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
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
  suppressSlackReplyQuote: mockSuppressSlackReplyQuote,
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
  sendCommand?: (command: unknown) => boolean;
  pendingUserInputRequests?: Array<{
    requestId: string;
    sessionId: string;
    turnId: string;
    callId: string;
    status: 'pending';
    ts: number;
    questions: AcpRequestUserInputQuestion[];
  }>;
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
  const sendCommand = vi.fn(options?.sendCommand ?? (() => true));
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
      getPendingUserInputRequests: () =>
        options?.pendingUserInputRequests ?? [],
      sendCommand,
    },
    harnessManager,
    auth: {
      runId: 1,
      userId: 'sender-user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    } satisfies RunTokenContext,
    runId: 1,
    prepareActorScopedTurn: mockPrepareActorScopedTurn,
  } as unknown as Context;

  return {
    caller: appRouter.createCaller(ctx),
    cancelTaskAndWaitForTurnExit,
    sendFollowUpPrompt,
    sendCommand,
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
      token: 'run-token',
      platformApiUrl: 'https://platform.example.com',
    });
    mockTrackSlackReplyQuote.mockResolvedValue({
      success: true,
      quoteId: 'quote-1',
    });
    mockSuppressSlackReplyQuote.mockResolvedValue({
      success: true,
      quoteId: 'suppression-1',
    });
    mockClearSlackReplyQuote.mockResolvedValue({ success: true });
  });

  it('cancels active turn before sending steer prompt', async () => {
    const { caller, cancelTaskAndWaitForTurnExit, sendFollowUpPrompt } =
      createCaller();

    const result = await caller.commands.steerTask({
      prompt: 'Switch to fixing tests first',
      quoteText: 'Switch to fixing tests first',
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
        token: 'run-token',
        platformApiUrl: 'https://platform.example.com',
      },
      {
        runId: 1,
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
      quoteText: 'Steer this into the current turn',
      images: ['data:image/png;base64,abc'],
      clientMessageId: 'delivery-1',
    });

    expect(result).toEqual({ success: true });
    expect(cancelTaskAndWaitForTurnExit).not.toHaveBeenCalled();
    expect(mockPrepareActorScopedTurn).toHaveBeenCalledWith('sender-user-1', {
      allowMcpReconnect: false,
    });
    expect(sendFollowUpPrompt).toHaveBeenCalledWith({
      prompt: 'Steer this into the current turn',
      images: ['data:image/png;base64,abc'],
      clientMessageId: 'delivery-1',
      autoSteerWhenQueued: true,
      userId: 'sender-user-1',
    });
  });

  it('skips Slack reply quote tracking for orchestrated steers', async () => {
    const { caller, sendFollowUpPrompt } = createCaller({
      supportsNativeTurnSteering: true,
    });

    const result = await caller.commands.steerTask({
      prompt: 'Continue the delegated task',
      quoteText: 'Continue the delegated task',
      suppressSlackReplyQuote: true,
    });

    expect(result).toEqual({ success: true });
    expect(mockTrackSlackReplyQuote).not.toHaveBeenCalled();
    expect(mockSuppressSlackReplyQuote).toHaveBeenCalledWith(
      {
        token: 'run-token',
        platformApiUrl: 'https://platform.example.com',
      },
      { runId: 1 },
    );
    expect(
      mockSuppressSlackReplyQuote.mock.invocationCallOrder[0],
    ).toBeLessThan(sendFollowUpPrompt.mock.invocationCallOrder[0]!);
    expect(sendFollowUpPrompt).toHaveBeenCalledWith({
      prompt: 'Continue the delegated task',
      autoSteerWhenQueued: true,
      userId: 'sender-user-1',
    });
  });

  it('answers one pending input request before steering', async () => {
    const { caller, sendCommand, sendFollowUpPrompt } = createCaller({
      pendingUserInputRequests: [
        {
          requestId: 'request-1',
          sessionId: 'session-1',
          turnId: 'turn-1',
          callId: 'call-1',
          status: 'pending',
          ts: 123,
          questions: [
            {
              id: 'approach',
              header: 'Approach',
              question: 'Which approach should I use?',
              isOther: true,
              isSecret: false,
              options: [
                { label: 'Minimal', description: 'Make the smallest change.' },
              ],
            },
          ],
        },
      ],
    });

    const result = await caller.commands.steerTask({
      prompt: 'Use a separate helper instead.',
      quoteText: 'Use a separate helper instead.',
      answerPendingInput: true,
      suppressSlackReplyQuote: true,
    });

    expect(result).toEqual({ success: true });
    expect(sendCommand).toHaveBeenCalledWith({
      commandName: 'AnswerUserInputRequest',
      data: {
        requestId: 'request-1',
        answers: {
          approach: { answers: ['Use a separate helper instead.'] },
        },
        userId: 'sender-user-1',
      },
    });
    expect(sendFollowUpPrompt).not.toHaveBeenCalled();
    expect(mockSuppressSlackReplyQuote).toHaveBeenCalledOnce();
  });

  it('steers when more than one input request is pending', async () => {
    const pendingRequest = {
      requestId: 'request-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      callId: 'call-1',
      status: 'pending' as const,
      ts: 123,
      questions: [],
    };
    const { caller, sendCommand, sendFollowUpPrompt } = createCaller({
      pendingUserInputRequests: [
        pendingRequest,
        { ...pendingRequest, requestId: 'request-2' },
      ],
      supportsNativeTurnSteering: true,
    });

    await caller.commands.steerTask({
      prompt: 'Continue the delegated task',
      quoteText: 'Continue the delegated task',
      answerPendingInput: true,
    });

    expect(sendCommand).not.toHaveBeenCalled();
    expect(sendFollowUpPrompt).toHaveBeenCalledOnce();
  });

  it('steers when one pending input request cannot parse the reply', async () => {
    const { caller, sendCommand, sendFollowUpPrompt } = createCaller({
      pendingUserInputRequests: [
        {
          requestId: 'request-1',
          sessionId: 'session-1',
          turnId: 'turn-1',
          callId: 'call-1',
          status: 'pending',
          ts: 123,
          questions: [
            {
              id: 'approach',
              header: 'Approach',
              question: 'Which approach should I use?',
              isOther: false,
              isSecret: false,
              options: [
                { label: 'Minimal', description: 'Make the smallest change.' },
              ],
            },
          ],
        },
      ],
      supportsNativeTurnSteering: true,
    });

    await caller.commands.steerTask({
      prompt: 'Use a separate helper instead.',
      quoteText: 'Use a separate helper instead.',
      answerPendingInput: true,
    });

    expect(sendCommand).not.toHaveBeenCalled();
    expect(sendFollowUpPrompt).toHaveBeenCalledOnce();
  });

  it('forwards workflow phase for explicit steer prompts', async () => {
    const { caller, sendFollowUpPrompt } = createCaller({
      supportsNativeTurnSteering: true,
    });

    const result = await caller.commands.steerTask({
      prompt: '/review-code inspect the latest diff',
      quoteText: '/review-code inspect the latest diff',
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
      caller.commands.steerTask({
        prompt: 'Switch directions',
        quoteText: 'Switch directions',
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('allows steering with images when prompt text is blank', async () => {
    const { caller, cancelTaskAndWaitForTurnExit, sendFollowUpPrompt } =
      createCaller();

    const result = await caller.commands.steerTask({
      prompt: '   ',
      quoteText: '   ',
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
      quoteText: 'Continue from the queued follow-up',
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
      quoteText: 'Switch directions',
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
    mockTrackSlackReplyQuote.mockResolvedValueOnce({ success: true });
    const { caller, cancelTaskAndWaitForTurnExit, sendFollowUpPrompt } =
      createCaller({
        sendFollowUpPrompt: () => false,
      });

    await expect(
      caller.commands.steerTask({
        prompt: 'Switch directions',
        quoteText: 'Switch directions',
      }),
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
    // Tracked through an older API (no quoteId): the rollback stays pending
    // rather than risking an unscoped clear.
    expect(mockClearSlackReplyQuote).not.toHaveBeenCalled();
  });

  it('rolls back persisted quote suppression when an orchestrated steer cannot start', async () => {
    const { caller } = createCaller({ sendFollowUpPrompt: () => false });

    await expect(
      caller.commands.steerTask({
        prompt: 'Continue the delegated task',
        quoteText: 'Continue the delegated task',
        suppressSlackReplyQuote: true,
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

    expect(mockClearSlackReplyQuote).toHaveBeenCalledWith(
      {
        token: 'run-token',
        platformApiUrl: 'https://platform.example.com',
      },
      { runId: 1, quoteId: 'suppression-1' },
    );
  });

  it('throws PRECONDITION_FAILED when the active turn cannot be interrupted', async () => {
    const { caller, sendFollowUpPrompt } = createCaller({
      cancelTaskAndWaitForTurnExit: () => Promise.resolve(false),
    });

    await expect(
      caller.commands.steerTask({
        prompt: 'Switch directions',
        quoteText: 'Switch directions',
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });

    expect(mockPrepareActorScopedTurn).not.toHaveBeenCalled();
    expect(sendFollowUpPrompt).not.toHaveBeenCalled();
  });

  it('requires non-empty prompt unless images are provided', async () => {
    const { caller } = createCaller();

    await expect(
      caller.commands.steerTask({ prompt: '   ', quoteText: '   ' }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('throws PRECONDITION_FAILED when actor-scoped preparation fails', async () => {
    mockPrepareActorScopedTurn.mockResolvedValueOnce(false);
    const { caller, sendFollowUpPrompt } = createCaller();

    await expect(
      caller.commands.steerTask({
        prompt: 'Switch directions',
        quoteText: 'Switch directions',
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });

    expect(sendFollowUpPrompt).not.toHaveBeenCalled();
  });
});
