import { appRouter } from '../../routers';
import type { HarnessPendingUserInputRequest } from '../../lib/harness';
import type { Context } from '../../trpc';
import type { RunTokenContext } from '@roomote/types';

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
  trackSlackReplyQuote: mockTrackSlackReplyQuote,
  clearSlackReplyQuote: mockClearSlackReplyQuote,
}));

function createCaller(options?: {
  harnessConnected?: boolean;
  sendCommand?: (command: unknown) => boolean;
  getPendingUserInputRequests?: () => HarnessPendingUserInputRequest[];
  harnessOverride?: Partial<Context['harness']>;
}) {
  const sendCommand = vi.fn(options?.sendCommand ?? (() => true));
  const harness =
    options?.harnessOverride ??
    ({
      isConnected: options?.harnessConnected ?? true,
      getPendingUserInputRequests: options?.getPendingUserInputRequests,
      sendCommand,
    } satisfies Partial<Context['harness']>);

  const ctx = {
    workingDirectory: '/tmp',
    harness,
    harnessManager: undefined,
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
    sendCommand,
  };
}

function createPendingRequest(
  requestId: string,
): HarnessPendingUserInputRequest {
  return {
    requestId,
    sessionId: 'session',
    turnId: 'turn',
    callId: 'call',
    status: 'pending',
    ts: Date.now(),
    questions: [
      {
        id: 'color',
        header: 'Color',
        question: 'Pick a color',
        isOther: false,
        isSecret: false,
        options: [
          {
            label: 'Blue',
            description: 'Use blue',
          },
        ],
      },
    ],
  };
}

describe('answerUserInputRequest procedure', () => {
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
    mockTrackSlackReplyQuote.mockResolvedValue({ success: true });
    mockClearSlackReplyQuote.mockResolvedValue({ success: true });
  });

  it('sends the answer directly through the harness', async () => {
    const { caller, sendCommand } = createCaller();

    const result = await caller.commands.answerUserInputRequest({
      requestId: 'rui:session:turn:call',
      userName: 'Casey',
      answers: {
        color: {
          answers: ['Blue'],
        },
      },
    });

    expect(result).toEqual({ success: true });
    expect(mockPrepareActorScopedTurn).toHaveBeenCalledWith('sender-user-1');
    expect(mockPrepareActorScopedTurn.mock.invocationCallOrder[0]).toBeLessThan(
      sendCommand.mock.invocationCallOrder[0]!,
    );
    expect(sendCommand).toHaveBeenCalledWith({
      commandName: 'AnswerUserInputRequest',
      data: {
        requestId: 'rui:session:turn:call',
        answers: {
          color: {
            answers: ['Blue'],
          },
        },
        userId: 'sender-user-1',
      },
    });
  });

  it('stores the submitted web answer for the next Slack reply quote', async () => {
    const { caller, sendCommand } = createCaller({
      getPendingUserInputRequests: () => [
        createPendingRequest('rui:session:turn:call'),
      ],
    });

    const result = await caller.commands.answerUserInputRequest({
      requestId: 'rui:session:turn:call',
      userName: 'Casey',
      answers: {
        color: {
          answers: ['Blue'],
        },
      },
    });

    expect(result).toEqual({ success: true });
    expect(mockFindFirstById).toHaveBeenCalledWith(1);
    expect(mockTrackSlackReplyQuote).toHaveBeenCalledWith(
      {
        token: 'run-token',
        platformApiUrl: 'https://platform.example.com',
      },
      {
        runId: 1,
        text: 'Blue',
        userName: 'Casey',
      },
    );
    expect(mockTrackSlackReplyQuote.mock.invocationCallOrder[0]).toBeLessThan(
      sendCommand.mock.invocationCallOrder[0]!,
    );
  });

  it('stores cancelled quote text when the input request is dismissed', async () => {
    const { caller } = createCaller({
      getPendingUserInputRequests: () => [
        createPendingRequest('rui:session:turn:call'),
      ],
    });

    const result = await caller.commands.answerUserInputRequest({
      requestId: 'rui:session:turn:call',
      userName: 'Casey',
      answers: {
        color: {
          answers: [],
        },
      },
    });

    expect(result).toEqual({ success: true });
    expect(mockFindFirstById).toHaveBeenCalledWith(1);
    expect(mockTrackSlackReplyQuote).toHaveBeenCalledWith(
      {
        token: 'run-token',
        platformApiUrl: 'https://platform.example.com',
      },
      {
        runId: 1,
        text: 'Cancelled input request',
        userName: 'Casey',
      },
    );
  });

  it('does not store a Slack quote when the task has no Slack thread context', async () => {
    mockFindFirstById.mockResolvedValueOnce({
      payload: {},
      slackThreadTs: null,
    });
    const { caller } = createCaller({
      getPendingUserInputRequests: () => [
        createPendingRequest('rui:session:turn:call'),
      ],
    });

    const result = await caller.commands.answerUserInputRequest({
      requestId: 'rui:session:turn:call',
      answers: {
        color: {
          answers: ['Blue'],
        },
      },
    });

    expect(result).toEqual({ success: true });
    expect(mockTrackSlackReplyQuote).not.toHaveBeenCalled();
  });

  it('stores submitted answer text even when pending request metadata is unavailable', async () => {
    const { caller } = createCaller();

    const result = await caller.commands.answerUserInputRequest({
      requestId: 'rui:session:turn:call',
      userName: 'Casey',
      answers: {
        color: {
          answers: ['Blue'],
        },
      },
    });

    expect(result).toEqual({ success: true });
    expect(mockTrackSlackReplyQuote).toHaveBeenCalledWith(
      {
        token: 'run-token',
        platformApiUrl: 'https://platform.example.com',
      },
      {
        runId: 1,
        text: 'Blue',
        userName: 'Casey',
      },
    );
  });

  it('throws PRECONDITION_FAILED when the harness is not connected', async () => {
    const { caller } = createCaller({ harnessConnected: false });

    await expect(
      caller.commands.answerUserInputRequest({
        requestId: 'rui:session:turn:call',
        answers: {},
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('throws NOT_FOUND when the pending request is missing', async () => {
    const { caller, sendCommand } = createCaller({
      sendCommand: () => false,
    });

    await expect(
      caller.commands.answerUserInputRequest({
        requestId: 'missing',
        answers: {},
      }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    expect(sendCommand).toHaveBeenCalledWith({
      commandName: 'AnswerUserInputRequest',
      data: {
        requestId: 'missing',
        answers: {},
        userId: 'sender-user-1',
      },
    });
    expect(mockTrackSlackReplyQuote.mock.invocationCallOrder[0]).toBeLessThan(
      sendCommand.mock.invocationCallOrder[0]!,
    );
    expect(mockClearSlackReplyQuote).toHaveBeenCalledWith(
      {
        token: 'run-token',
        platformApiUrl: 'https://platform.example.com',
      },
      {
        runId: 1,
      },
    );
  });

  it('throws PRECONDITION_FAILED when actor-scoped preparation fails', async () => {
    mockPrepareActorScopedTurn.mockResolvedValueOnce(false);
    const { caller, sendCommand } = createCaller();

    await expect(
      caller.commands.answerUserInputRequest({
        requestId: 'rui:session:turn:call',
        answers: {},
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });

    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('waits briefly for a restored pending request before sending the answer', async () => {
    vi.useFakeTimers();
    let restored = false;
    const { caller, sendCommand } = createCaller({
      getPendingUserInputRequests: () =>
        restored ? [createPendingRequest('rui:session:turn:call')] : [],
    });

    try {
      const answerPromise = caller.commands.answerUserInputRequest({
        requestId: 'rui:session:turn:call',
        answers: {
          color: {
            answers: ['Blue'],
          },
        },
      });

      await vi.advanceTimersByTimeAsync(200);
      expect(sendCommand).not.toHaveBeenCalled();

      restored = true;

      await vi.advanceTimersByTimeAsync(25);
      await expect(answerPromise).resolves.toEqual({ success: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the harness method context while polling for restored requests', async () => {
    vi.useFakeTimers();

    class HarnessPendingRequestStore {
      restored = false;
      sendCommand = vi.fn(() => true);
      get isConnected() {
        return true;
      }

      getPendingUserInputRequests() {
        return this.restored
          ? [createPendingRequest('rui:session:turn:call')]
          : [];
      }
    }

    const requestStore = new HarnessPendingRequestStore();
    const { caller } = createCaller({
      harnessOverride: requestStore as unknown as Partial<Context['harness']>,
    });

    try {
      const answerPromise = caller.commands.answerUserInputRequest({
        requestId: 'rui:session:turn:call',
        answers: {
          color: {
            answers: ['Blue'],
          },
        },
      });

      await vi.advanceTimersByTimeAsync(200);
      expect(requestStore.sendCommand).not.toHaveBeenCalled();

      requestStore.restored = true;

      await vi.advanceTimersByTimeAsync(25);
      await expect(answerPromise).resolves.toEqual({ success: true });
      expect(requestStore.sendCommand).toHaveBeenCalledWith({
        commandName: 'AnswerUserInputRequest',
        data: {
          requestId: 'rui:session:turn:call',
          answers: {
            color: {
              answers: ['Blue'],
            },
          },
          userId: 'sender-user-1',
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
