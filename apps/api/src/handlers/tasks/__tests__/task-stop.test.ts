import { TRPCClientError } from '@trpc/client';
import { RunStatus } from '@roomote/types';

const {
  mockWithSandboxServerRpcClient,
  mockDbUpdate,
  mockDbUpdateSet,
  mockDbUpdateWhere,
  mockFindFirstCloudJob,
  mockDbTransaction,
  mockTxUpdate,
  mockTxUpdateSet,
  mockTxUpdateWhere,
  mockTxReturning,
  mockMarkTaskStartParallelCountEndedAt,
  mockCancelTaskRunDirect,
} = vi.hoisted(() => {
  const mockTxReturning = vi.fn();
  const mockTxUpdateWhere = vi.fn(() => ({ returning: mockTxReturning }));
  const mockTxUpdateSet = vi.fn(() => ({ where: mockTxUpdateWhere }));
  const mockTxUpdate = vi.fn(() => ({ set: mockTxUpdateSet }));
  const mockDbUpdateWhere = vi.fn(() => Promise.resolve([]));
  const mockDbUpdateSet = vi.fn(() => ({ where: mockDbUpdateWhere }));
  const mockDbUpdate = vi.fn(() => ({ set: mockDbUpdateSet }));

  return {
    mockWithSandboxServerRpcClient: vi.fn(),
    mockDbUpdate,
    mockDbUpdateSet,
    mockDbUpdateWhere,
    mockFindFirstCloudJob: vi.fn(),
    mockDbTransaction: vi.fn(),
    mockTxUpdate,
    mockTxUpdateSet,
    mockTxUpdateWhere,
    mockTxReturning,
    mockMarkTaskStartParallelCountEndedAt: vi.fn(),
    mockCancelTaskRunDirect: vi.fn(),
  };
});

vi.mock('@roomote/sdk/server', () => ({
  withSandboxServerRpcClient: mockWithSandboxServerRpcClient,
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args) => ({ type: 'and', args })),
  eq: vi.fn((...args) => ({ type: 'eq', args })),
  inArray: vi.fn((...args) => ({ type: 'inArray', args })),
  isNull: vi.fn((...args) => ({ type: 'isNull', args })),
  not: vi.fn((...args) => ({ type: 'not', args })),
  taskRuns: {
    id: 'id',
    status: 'status',
    sandboxServerUrl: 'sandboxServerUrl',
    cancelRequestedAt: 'cancelRequestedAt',
  },
  cancelTaskRunDirect: mockCancelTaskRunDirect,
  markTaskStartParallelCountEndedAt: mockMarkTaskStartParallelCountEndedAt,
  db: {
    update: mockDbUpdate,
    transaction: mockDbTransaction,
    query: {
      taskRuns: {
        findFirst: mockFindFirstCloudJob,
      },
    },
  },
}));

import { stopTaskJob } from '../task-stop';

describe('stopTaskJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbUpdate.mockReturnValue({ set: mockDbUpdateSet });
    mockDbUpdateSet.mockReturnValue({ where: mockDbUpdateWhere });
    mockDbUpdateWhere.mockResolvedValue([]);
    mockTxUpdate.mockReturnValue({ set: mockTxUpdateSet });
    mockTxUpdateSet.mockReturnValue({ where: mockTxUpdateWhere });
    mockTxUpdateWhere.mockReturnValue({ returning: mockTxReturning });
    mockTxReturning.mockResolvedValue([{ id: 7 }]);
    mockDbTransaction.mockImplementation(
      async (callback: (tx: unknown) => unknown) =>
        callback({ update: mockTxUpdate }),
    );
    mockMarkTaskStartParallelCountEndedAt.mockResolvedValue(undefined);
    mockWithSandboxServerRpcClient.mockResolvedValue(undefined);
  });

  it('persists cancel intent on the job row before the sandbox stop RPC', async () => {
    const job = {
      id: 7,
      status: RunStatus.Running,
      sandboxServerUrl: 'https://sandbox.example',
      actingUserId: null,
    };

    const result = await stopTaskJob({ job, authUserId: 'user-1' });

    expect(result).toEqual({ success: true, mode: 'sandbox_stop' });
    expect(mockDbUpdateSet).toHaveBeenCalledWith({
      cancelRequestedAt: expect.any(Date),
    });
    // Intent must be durable before the sandbox is asked to cancel, so a
    // sandbox that dies mid-cancel still leaves the stop request behind.
    expect(mockDbUpdateSet.mock.invocationCallOrder[0]!).toBeLessThan(
      mockWithSandboxServerRpcClient.mock.invocationCallOrder[0]!,
    );
  });

  it('persists cancel intent even when the sandbox stop RPC fails', async () => {
    const job = {
      id: 7,
      status: RunStatus.Running,
      sandboxServerUrl: 'https://sandbox.example',
      actingUserId: null,
    };
    mockWithSandboxServerRpcClient.mockRejectedValue(
      new TRPCClientError('sandbox unreachable'),
    );

    const result = await stopTaskJob({ job, authUserId: 'user-1' });

    expect(result).toEqual({
      success: false,
      statusCode: 502,
      error: 'Sandbox error: sandbox unreachable',
    });
    expect(mockDbUpdateSet).toHaveBeenCalledWith({
      cancelRequestedAt: expect.any(Date),
    });
  });

  it('stamps cancelRequestedAt when direct-canceling a job without a sandbox', async () => {
    const job = {
      id: 7,
      status: RunStatus.Processing,
      sandboxServerUrl: null,
      actingUserId: null,
    };
    mockFindFirstCloudJob.mockResolvedValue(job);
    mockCancelTaskRunDirect.mockResolvedValue(true);

    const result = await stopTaskJob({
      job,
      authUserId: 'user-1',
      allowDirectCancelWithoutSandbox: true,
    });

    expect(result).toEqual({ success: true, mode: 'direct_cancel' });
    // The guarded terminal write (status/cancelRequestedAt/canceledAt) and the
    // parallel-count close live in the shared cancelTaskRunDirect helper,
    // covered by its real-DB tests in packages/db.
    expect(mockCancelTaskRunDirect).toHaveBeenCalledWith({ runId: 7 });
  });
});
