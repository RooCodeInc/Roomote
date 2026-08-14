import { RunStatus } from '@roomote/types';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockFindFirstRun = vi.fn();
const mockRecordMutation = vi.fn().mockResolvedValue(undefined);
const mockCreateComputeProviderMutationEventRecorder = vi
  .fn()
  .mockReturnValue((...args: unknown[]) => mockRecordMutation(...args));
const mockResolveComputeProviderEnvValues = vi.fn();

/** Rows resolved by the final-usage-record lookup select chain. */
let finalUsageRows: unknown[] = [];

function makeSelectChain() {
  const chain: Record<string, unknown> = {};

  for (const method of ['from', 'where', 'limit']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain.then = (
    onFulfilled: (value: unknown[]) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise.resolve(finalUsageRows).then(onFulfilled, onRejected);

  return chain;
}

vi.mock('@roomote/db/server', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/db/server')>(
      '@roomote/db/server',
    );
  return {
    ...actual,
    db: {
      query: {
        taskRuns: {
          findFirst: (...args: unknown[]) => mockFindFirstRun(...args),
        },
      },
      select: () => makeSelectChain(),
    },
    createComputeProviderMutationEventRecorder: (...args: unknown[]) =>
      mockCreateComputeProviderMutationEventRecorder(...args),
    resolveComputeProviderEnvValues: (...args: unknown[]) =>
      mockResolveComputeProviderEnvValues(...args),
  };
});

const mockRedisSet = vi.fn();
const mockRedisEval = vi.fn().mockResolvedValue(1);

vi.mock('@roomote/redis', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/redis')>('@roomote/redis');
  return {
    ...actual,
    getRedis: () => ({
      set: (...args: unknown[]) => mockRedisSet(...args),
      eval: (...args: unknown[]) => mockRedisEval(...args),
    }),
  };
});

const mockDestroyInstance = vi.fn();
const mockCreateComputeProviderClient = vi.fn().mockReturnValue({
  destroyInstance: (...args: unknown[]) => mockDestroyInstance(...args),
});

vi.mock('@roomote/compute-providers', () => ({
  createComputeProviderClient: (...args: unknown[]) =>
    mockCreateComputeProviderClient(...args),
}));

const mockRecordComputeProviderUsage = vi.fn().mockResolvedValue(undefined);

vi.mock('../record-compute-provider-usage', () => ({
  recordComputeProviderUsage: (...args: unknown[]) =>
    mockRecordComputeProviderUsage(...args),
}));

import { destroyCanceledTaskRunSandbox } from '../destroy-canceled-run-sandbox';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    taskId: 'task-42',
    status: RunStatus.Canceled,
    machineId: 'sb-42',
    vendor: 'roomote',
    snapshotId: null,
    canceledAt: new Date('2026-07-29T12:00:00.000Z'),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('destroyCanceledTaskRunSandbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    finalUsageRows = [];
    mockRedisSet.mockResolvedValue('OK');
    mockRedisEval.mockResolvedValue(1);
    mockResolveComputeProviderEnvValues.mockResolvedValue({
      ROOMOTE_CLOUD_TOKEN_ID: 'tenant-1',
    });
    mockDestroyInstance.mockResolvedValue({
      usageObservation: {
        activeCpuDurationMs: 1_000,
        networkTransfer: { ingress: 10, egress: 20 },
      },
    });
    mockCreateComputeProviderClient.mockReturnValue({
      destroyInstance: (...args: unknown[]) => mockDestroyInstance(...args),
    });
  });

  it('destroys the machine and records a destroy usage record for a canceled run', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun());

    const result = await destroyCanceledTaskRunSandbox({
      runId: 42,
      logPrefix: 'test',
    });

    expect(result).toBe('destroyed');
    expect(mockCreateComputeProviderClient).toHaveBeenCalledWith({
      provider: 'roomote',
      envFallback: { ROOMOTE_CLOUD_TOKEN_ID: 'tenant-1' },
    });
    expect(mockDestroyInstance).toHaveBeenCalledWith({ instanceId: 'sb-42' });
    expect(mockRecordComputeProviderUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 42,
        lifecycleAction: 'destroy',
        completedAt: expect.any(Date),
        activeCpuDurationMs: 1_000,
        networkIngressBytes: 10,
        networkEgressBytes: 20,
        details: expect.objectContaining({
          provider: 'roomote',
          reason: 'task_run_canceled',
        }),
      }),
    );
    expect(mockRecordMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'destroy_instance',
        eventType: 'started',
        instanceId: 'sb-42',
      }),
    );
    expect(mockRecordMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'destroy_instance',
        eventType: 'completed',
        instanceId: 'sb-42',
      }),
    );
  });

  it('builds a docker client without env fallback for docker runs', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun({ vendor: 'docker' }));

    await destroyCanceledTaskRunSandbox({ runId: 42, logPrefix: 'test' });

    expect(mockResolveComputeProviderEnvValues).not.toHaveBeenCalled();
    expect(mockCreateComputeProviderClient).toHaveBeenCalledWith({
      provider: 'docker',
    });
  });

  it('treats a canceledAt stamp as canceled even before the status write lands', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun({ status: RunStatus.Running }));

    const result = await destroyCanceledTaskRunSandbox({
      runId: 42,
      logPrefix: 'test',
    });

    expect(result).toBe('destroyed');
    expect(mockDestroyInstance).toHaveBeenCalled();
  });

  it('skips runs without a machine', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun({ machineId: null }));

    const result = await destroyCanceledTaskRunSandbox({
      runId: 42,
      logPrefix: 'test',
    });

    expect(result).toBe('skipped');
    expect(mockDestroyInstance).not.toHaveBeenCalled();
    expect(mockRecordComputeProviderUsage).not.toHaveBeenCalled();
  });

  it('skips runs preserved via snapshot', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun({ snapshotId: 'snap-1' }));

    const result = await destroyCanceledTaskRunSandbox({
      runId: 42,
      logPrefix: 'test',
    });

    expect(result).toBe('skipped');
    expect(mockDestroyInstance).not.toHaveBeenCalled();
  });

  it('skips runs that are not canceled', async () => {
    mockFindFirstRun.mockResolvedValue(
      makeRun({ status: RunStatus.Running, canceledAt: null }),
    );

    const result = await destroyCanceledTaskRunSandbox({
      runId: 42,
      logPrefix: 'test',
    });

    expect(result).toBe('skipped');
    expect(mockDestroyInstance).not.toHaveBeenCalled();
  });

  it('skips missing runs', async () => {
    mockFindFirstRun.mockResolvedValue(undefined);

    const result = await destroyCanceledTaskRunSandbox({
      runId: 42,
      logPrefix: 'test',
    });

    expect(result).toBe('skipped');
    expect(mockDestroyInstance).not.toHaveBeenCalled();
  });

  it('skips when a final usage record already exists (e.g. sleep-check destroyed first)', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun());
    finalUsageRows = [{ id: 'roomote:compute:roomote:42:sb-42' }];

    const result = await destroyCanceledTaskRunSandbox({
      runId: 42,
      logPrefix: 'test',
    });

    expect(result).toBe('skipped');
    expect(mockDestroyInstance).not.toHaveBeenCalled();
    expect(mockRecordComputeProviderUsage).not.toHaveBeenCalled();
  });

  it('claims the machine with a unique token before the provider delete', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun());

    await destroyCanceledTaskRunSandbox({ runId: 42, logPrefix: 'test' });

    expect(mockRedisSet).toHaveBeenCalledWith(
      'compute:machine-destroy-claim:roomote:sb-42',
      expect.stringMatching(/^test:/),
      'EX',
      expect.any(Number),
      'NX',
    );
    expect(mockRedisSet.mock.invocationCallOrder[0]).toBeLessThan(
      mockDestroyInstance.mock.invocationCallOrder[0]!,
    );
  });

  it('lets exactly one of two concurrent callers issue the provider delete', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun());
    // First caller wins the SET NX; the second sees the claim held.
    mockRedisSet.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

    const [first, second] = await Promise.all([
      destroyCanceledTaskRunSandbox({ runId: 42, logPrefix: 'finishRun' }),
      destroyCanceledTaskRunSandbox({ runId: 42, logPrefix: 'cancelTask' }),
    ]);

    expect([first, second].sort()).toEqual(['destroyed', 'skipped']);
    expect(mockDestroyInstance).toHaveBeenCalledTimes(1);
    expect(mockRecordComputeProviderUsage).toHaveBeenCalledTimes(1);
    // The loser must not record a failed destroy mutation.
    expect(mockRecordMutation).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'failed' }),
    );
  });

  it('skips when another destroyer already holds the claim', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun());
    mockRedisSet.mockResolvedValue(null);

    const result = await destroyCanceledTaskRunSandbox({
      runId: 42,
      logPrefix: 'test',
    });

    expect(result).toBe('skipped');
    expect(mockDestroyInstance).not.toHaveBeenCalled();
    expect(mockRecordMutation).not.toHaveBeenCalled();
  });

  it('conditionally releases its own token when the provider delete fails', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun());
    mockDestroyInstance.mockRejectedValue(new Error('provider down'));

    const result = await destroyCanceledTaskRunSandbox({
      runId: 42,
      logPrefix: 'test',
    });

    expect(result).toBe('failed');
    // Token-conditional DEL: the release script compares the stored value to
    // this caller's token so it can never delete a successor's claim.
    const claimedToken = mockRedisSet.mock.calls[0]?.[1];
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining('del'),
      1,
      'compute:machine-destroy-claim:roomote:sb-42',
      claimedToken,
    );
  });

  it('renews the lease while a slow provider delete is in flight', async () => {
    vi.useFakeTimers();
    try {
      mockFindFirstRun.mockResolvedValue(makeRun());

      let resolveDestroy!: (value: unknown) => void;
      mockDestroyInstance.mockReturnValue(
        new Promise((resolve) => {
          resolveDestroy = resolve;
        }),
      );

      const pending = destroyCanceledTaskRunSandbox({
        runId: 42,
        logPrefix: 'test',
      });

      // Two renewal intervals elapse while destroyInstance is still pending.
      await vi.advanceTimersByTimeAsync(11 * 60 * 1_000);

      const claimedToken = mockRedisSet.mock.calls[0]?.[1];
      const renewCalls = mockRedisEval.mock.calls.filter(([script]) =>
        String(script).includes('expire'),
      );
      expect(renewCalls.length).toBeGreaterThanOrEqual(2);
      expect(renewCalls[0]).toEqual([
        expect.stringContaining('expire'),
        1,
        'compute:machine-destroy-claim:roomote:sb-42',
        claimedToken,
        expect.any(String),
      ]);

      resolveDestroy({});
      await expect(pending).resolves.toBe('destroyed');

      // Settling the claim stops renewal.
      mockRedisEval.mockClear();
      await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
      expect(mockRedisEval).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still destroys when redis is unavailable rather than leaking the machine', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun());
    mockRedisSet.mockRejectedValue(new Error('redis unavailable'));

    const result = await destroyCanceledTaskRunSandbox({
      runId: 42,
      logPrefix: 'test',
    });

    expect(result).toBe('destroyed');
    expect(mockDestroyInstance).toHaveBeenCalledTimes(1);
  });

  it('records a failed mutation event and reports failure when destroyInstance throws', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun());
    mockDestroyInstance.mockRejectedValue(new Error('sandbox not found'));

    const result = await destroyCanceledTaskRunSandbox({
      runId: 42,
      logPrefix: 'test',
    });

    expect(result).toBe('failed');
    expect(mockRecordComputeProviderUsage).not.toHaveBeenCalled();
    expect(mockRecordMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'destroy_instance',
        eventType: 'failed',
        details: expect.objectContaining({ error: 'sandbox not found' }),
      }),
    );
  });

  it('still reports destroyed when the usage record write fails', async () => {
    mockFindFirstRun.mockResolvedValue(makeRun());
    mockRecordComputeProviderUsage.mockRejectedValueOnce(
      new Error('usage write failed'),
    );

    const result = await destroyCanceledTaskRunSandbox({
      runId: 42,
      logPrefix: 'test',
    });

    expect(result).toBe('destroyed');
    expect(mockRecordMutation).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'completed' }),
    );
  });

  it('never throws when the run lookup fails', async () => {
    mockFindFirstRun.mockRejectedValue(new Error('db unavailable'));

    const result = await destroyCanceledTaskRunSandbox({
      runId: 42,
      logPrefix: 'test',
    });

    expect(result).toBe('failed');
  });
});
