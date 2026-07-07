import { appRouter } from '../../routers';
import type { Context } from '../../trpc';

function createCaller(options?: {
  harnessConnected?: boolean;
  getCurrentWorkflowPhase?: () => string | null;
  getPendingUserInputRequests?: () => unknown[];
  getPendingEnvVarRequest?: () => unknown | null;
  getQueuedMessages?: () => unknown[];
  status?: {
    phase: string;
    taskStateEvent: null;
    sessionId: string | undefined;
    isConnected: boolean;
    sleepRemainingMs: number | null;
    lastErrorMessage: string | undefined;
  };
}) {
  const getPendingUserInputRequests = vi.fn(
    options?.getPendingUserInputRequests ?? (() => []),
  );
  const getCurrentWorkflowPhase = vi.fn(
    options?.getCurrentWorkflowPhase ?? (() => null),
  );
  const getPendingEnvVarRequest = vi.fn(
    options?.getPendingEnvVarRequest ?? (() => null),
  );
  const getQueuedMessages = vi.fn(options?.getQueuedMessages ?? (() => []));
  const getStatus = vi.fn(
    () =>
      options?.status ?? {
        phase: 'idle',
        taskStateEvent: null,
        sessionId: undefined,
        isConnected: true,
        sleepRemainingMs: null,
        lastErrorMessage: undefined,
      },
  );

  const ctx = {
    workingDirectory: '/tmp',
    harness: {
      isConnected: options?.harnessConnected ?? true,
      sendCommand: vi.fn(() => true),
      getCurrentWorkflowPhase,
      getPendingUserInputRequests,
      getPendingEnvVarRequest,
      getQueuedMessages,
    },
    harnessManager: {
      getStatus,
    },
  } as unknown as Context;

  return {
    caller: appRouter.createCaller(ctx),
    getCurrentWorkflowPhase,
    getPendingUserInputRequests,
    getPendingEnvVarRequest,
    getQueuedMessages,
    getStatus,
  };
}

describe('getRuntimeState procedure', () => {
  it('returns the normalized status plus pending request_user_input prompts and queued messages', async () => {
    const {
      caller,
      getCurrentWorkflowPhase,
      getPendingUserInputRequests,
      getPendingEnvVarRequest,
      getQueuedMessages,
      getStatus,
    } = createCaller({
      status: {
        phase: 'waiting_for_user_input',
        taskStateEvent: null,
        sessionId: 'task-1',
        isConnected: true,
        sleepRemainingMs: 12_000,
        lastErrorMessage: undefined,
      },
      getPendingUserInputRequests: () => [
        {
          requestId: 'rui:session:turn:call',
          sessionId: 'task-1',
          turnId: 'turn-1',
          callId: 'call-1',
          status: 'pending',
          ts: 123,
          questions: [],
        },
      ],
      getQueuedMessages: () => [
        {
          id: 'runtime-queued-1',
          text: 'Follow up after the current turn',
          timestamp: 456,
          images: ['data:image/png;base64,abc'],
          userName: 'Casey',
          userImageUrl: 'https://example.com/casey.png',
          clientMessageId: 'client-123',
        },
      ],
      getPendingEnvVarRequest: () => ({
        key: 'env-var-request-1',
        ts: 789,
        variables: [{ name: 'OPENAI_API_KEY' }],
      }),
      getCurrentWorkflowPhase: () => 'review-code',
    });

    const result = await caller.commands.getRuntimeState();

    expect(result).toEqual({
      status: expect.objectContaining({
        phase: 'waiting_for_user_input',
        sessionId: 'task-1',
      }),
      pendingUserInputRequests: [
        expect.objectContaining({
          requestId: 'rui:session:turn:call',
          ts: 123,
        }),
      ],
      currentWorkflowPhase: 'review-code',
      pendingEnvVarRequest: {
        key: 'env-var-request-1',
        ts: 789,
        variables: [{ name: 'OPENAI_API_KEY' }],
      },
      queuedMessages: [
        expect.objectContaining({
          id: 'runtime-queued-1',
          text: 'Follow up after the current turn',
          timestamp: 456,
          images: ['data:image/png;base64,abc'],
          userName: 'Casey',
          userImageUrl: 'https://example.com/casey.png',
          clientMessageId: 'client-123',
        }),
      ],
    });
    expect(getStatus).toHaveBeenCalled();
    expect(getCurrentWorkflowPhase).toHaveBeenCalled();
    expect(getPendingUserInputRequests).toHaveBeenCalled();
    expect(getPendingEnvVarRequest).toHaveBeenCalled();
    expect(getQueuedMessages).toHaveBeenCalled();
  });

  it('does not expose queue-only queued messages in runtime-state hydration', async () => {
    const { caller } = createCaller({
      status: {
        phase: 'running',
        taskStateEvent: null,
        sessionId: 'task-1',
        isConnected: true,
        sleepRemainingMs: null,
        lastErrorMessage: undefined,
      },
      getQueuedMessages: () => [
        {
          id: 'runtime-queued-hidden',
          text: 'Passive thread activity',
          timestamp: 100,
          queueOnly: true,
        },
        {
          id: 'runtime-queued-visible',
          text: 'Visible follow-up',
          timestamp: 200,
        },
      ],
    });

    const result = await caller.commands.getRuntimeState();

    expect(result.queuedMessages).toEqual([
      expect.objectContaining({
        id: 'runtime-queued-visible',
        text: 'Visible follow-up',
        timestamp: 200,
      }),
    ]);
  });

  it('returns no pending requests when the harness is disconnected', async () => {
    const {
      caller,
      getPendingUserInputRequests,
      getPendingEnvVarRequest,
      getQueuedMessages,
    } = createCaller({
      harnessConnected: false,
      status: {
        phase: 'waiting_for_user_input',
        taskStateEvent: null,
        sessionId: 'task-1',
        isConnected: false,
        sleepRemainingMs: 12_000,
        lastErrorMessage: undefined,
      },
      getPendingUserInputRequests: () => [
        {
          requestId: 'ignored',
        },
      ],
    });

    const result = await caller.commands.getRuntimeState();

    expect(result.pendingUserInputRequests).toEqual([]);
    expect(result.currentWorkflowPhase).toBeNull();
    expect(result.pendingEnvVarRequest).toBeNull();
    expect(result.queuedMessages).toEqual([]);
    expect(result.status.phase).toBe('idle');
    expect(getPendingUserInputRequests).not.toHaveBeenCalled();
    expect(getPendingEnvVarRequest).not.toHaveBeenCalled();
    expect(getQueuedMessages).not.toHaveBeenCalled();
  });
});
