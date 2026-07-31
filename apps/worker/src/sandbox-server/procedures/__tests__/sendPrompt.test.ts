import { appRouter } from '../../routers';
import type { Context } from '../../trpc';
import type { RunTokenContext } from '@roomote/types';

const { mockPrepareActorScopedTurn } = vi.hoisted(() => ({
  mockPrepareActorScopedTurn: vi.fn(),
}));

function createCaller(options?: {
  sendFollowUpPrompt?: (args: {
    prompt: string;
    images?: string[];
    workflowPhase?: string;
    autoSteerWhenQueued?: boolean;
    userId?: string;
  }) => boolean;
  status?: {
    phase: string;
    taskStateEvent: null;
    sessionId: string | undefined;
    isConnected: boolean;
    sleepRemainingMs: number | null;
    lastErrorMessage: string | undefined;
  };
}) {
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

  const ctx = {
    workingDirectory: '/tmp',
    harness: {
      isConnected: true,
      getPendingUserInputRequests: () => [],
    },
    harnessManager: {
      sendFollowUpPrompt,
      getStatus,
    },
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
    sendFollowUpPrompt,
  };
}

describe('sendPrompt procedure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrepareActorScopedTurn.mockResolvedValue(undefined);
  });

  it('forwards autoSteerWhenQueued to the harness follow-up prompt', async () => {
    const { caller, sendFollowUpPrompt } = createCaller();

    const result = await caller.commands.sendPrompt({
      prompt: 'change direction',
      autoSteerWhenQueued: true,
    });

    expect(result).toEqual({ success: true });
    expect(sendFollowUpPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'change direction',
        autoSteerWhenQueued: true,
      }),
    );
  });

  it('leaves autoSteerWhenQueued unset for plain queued sends', async () => {
    const { caller, sendFollowUpPrompt } = createCaller();

    await caller.commands.sendPrompt({
      prompt: 'just queue this',
    });

    expect(sendFollowUpPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'just queue this',
        autoSteerWhenQueued: undefined,
      }),
    );
  });

  it('forwards queueOnly to keep a follow-up behind the active turn', async () => {
    const { caller, sendFollowUpPrompt } = createCaller();

    await caller.commands.sendPrompt({
      prompt: 'review the newest commits next',
      queueOnly: true,
    });

    expect(sendFollowUpPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'review the newest commits next',
        queueOnly: true,
      }),
    );
  });
});
