const mocks = vi.hoisted(() => ({
  findRun: vi.fn(),
  withClient: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: (...args: unknown[]) => args,
  db: { query: { taskRuns: { findFirst: mocks.findRun } } },
  eq: (...args: unknown[]) => args,
  taskRuns: { id: 'id', taskId: 'taskId' },
}));
vi.mock('../auth/sandbox-server-rpc', () => ({
  withSandboxServerRpcClient: mocks.withClient,
}));

import { continueDirectTaskAttentionReply } from './continue-direct-task-attention-reply';

describe('continueDirectTaskAttentionReply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findRun.mockResolvedValue({ sandboxServerUrl: 'http://sandbox' });
    mocks.withClient.mockImplementation(async ({ call }) =>
      call({ commands: { steerTask: { mutate: vi.fn() } } }),
    );
  });

  it('answers a pending direct-task input request on its existing run', async () => {
    await expect(
      continueDirectTaskAttentionReply({
        taskId: 'task-1',
        runId: 42,
        userId: 'user-1',
        question: 'Use TypeScript',
        kind: 'input_needed',
      }),
    ).resolves.toBe(true);

    const call = mocks.withClient.mock.calls[0]![0].call;
    const mutate = vi.fn();
    await call({ commands: { steerTask: { mutate } } });
    expect(mutate).toHaveBeenCalledWith({
      prompt: 'Use TypeScript',
      quoteText: 'Use TypeScript',
      answerPendingInput: true,
    });
  });

  it('returns false instead of throwing when the sandbox RPC fails', async () => {
    mocks.withClient.mockRejectedValue(new Error('sandbox unavailable'));

    await expect(
      continueDirectTaskAttentionReply({
        taskId: 'task-1',
        runId: 42,
        userId: 'user-1',
        question: 'Continue',
        kind: 'result_ready',
      }),
    ).resolves.toBe(false);
  });
});
