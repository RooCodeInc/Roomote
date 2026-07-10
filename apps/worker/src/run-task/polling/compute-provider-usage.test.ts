import { WORKER_HEARTBEAT_INTERVAL_MS } from '@roomote/types';

const { mockExecFile, mockReadFile, mockRecordComputeProviderUsage } =
  vi.hoisted(() => ({
    mockExecFile: vi.fn(),
    mockReadFile: vi.fn(),
    mockRecordComputeProviderUsage: vi.fn(),
  }));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      recordComputeProviderUsage: mockRecordComputeProviderUsage,
    },
  },
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

import {
  createComputeProviderUsageInterval,
  sampleCgroupUsage,
} from './compute-provider-usage';

describe('sampleCgroupUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads Modal cgroup counters when they are available', async () => {
    mockReadFile.mockImplementation((path: string) => {
      switch (path) {
        case '/sys/fs/cgroup/cpuacct/cpuacct.usage':
          return Promise.resolve('1570000000\n');
        case '/sys/fs/cgroup/memory/memory.usage_in_bytes':
          return Promise.resolve('105295872\n');
        case '/sys/fs/cgroup/memory/memory.max_usage_in_bytes':
          return Promise.resolve('209715200\n');
        default:
          return Promise.reject(new Error(`Unexpected path: ${path}`));
      }
    });

    await expect(sampleCgroupUsage()).resolves.toEqual({
      sampledCpuUsageNsTotal: 1_570_000_000,
      sampledCpuUsageSource: 'cgroup_v1',
      sampledMemoryUsageBytes: 105_295_872,
      sampledMemoryUsageSource: 'cgroup_v1',
      sampledMemoryPeakUsageBytes: 209_715_200,
      sampledMemoryPeakUsageSource: 'cgroup_v1',
    });
  });

  it('falls back to cgroup v2 counters when v1 files are unavailable', async () => {
    mockReadFile.mockImplementation((path: string) => {
      switch (path) {
        case '/sys/fs/cgroup/cpuacct/cpuacct.usage':
        case '/sys/fs/cgroup/memory/memory.usage_in_bytes':
        case '/sys/fs/cgroup/memory/memory.max_usage_in_bytes':
          return Promise.reject(new Error('missing'));
        case '/sys/fs/cgroup/cpu.stat':
          return Promise.resolve('usage_usec 1570000\nuser_usec 1200000\n');
        case '/sys/fs/cgroup/memory.current':
          return Promise.resolve('105295872\n');
        case '/sys/fs/cgroup/memory.peak':
          return Promise.resolve('209715200\n');
        default:
          return Promise.reject(new Error(`Unexpected path: ${path}`));
      }
    });

    await expect(sampleCgroupUsage()).resolves.toEqual({
      sampledCpuUsageNsTotal: 1_570_000_000,
      sampledCpuUsageSource: 'cgroup_v2',
      sampledMemoryUsageBytes: 105_295_872,
      sampledMemoryUsageSource: 'cgroup_v2',
      sampledMemoryPeakUsageBytes: 209_715_200,
      sampledMemoryPeakUsageSource: 'cgroup_v2',
    });
  });

  it('returns null when the cgroup files are unavailable', async () => {
    mockReadFile.mockRejectedValue(new Error('missing'));

    await expect(sampleCgroupUsage()).resolves.toBeNull();
  });
});

describe('createComputeProviderUsageInterval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockRecordComputeProviderUsage.mockResolvedValue(undefined);
    mockReadFile.mockRejectedValue(new Error('missing'));
    mockExecFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, '', '');
        return {} as never;
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records compute usage immediately and on each interval for sandbox jobs', async () => {
    const loop = createComputeProviderUsageInterval({
      runId: 42,
      computeProvider: 'modal',
      logger: {
        warn: vi.fn(),
      } as never,
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRecordComputeProviderUsage).toHaveBeenCalledTimes(1);
      expect(mockRecordComputeProviderUsage).toHaveBeenCalledWith({
        runId: 42,
        lifecycleAction: 'running',
        completedAt: expect.any(Date),
        details: {
          source: 'worker_heartbeat',
          updateKind: 'periodic',
        },
      });

      await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
      expect(mockRecordComputeProviderUsage).toHaveBeenCalledTimes(2);
    } finally {
      loop.stop();
    }
  });

  it('includes Modal cgroup samples in running updates and supports a shutdown flush', async () => {
    mockReadFile.mockImplementation((path: string) => {
      switch (path) {
        case '/sys/fs/cgroup/cpuacct/cpuacct.usage':
          return Promise.resolve('1000000000\n');
        case '/sys/fs/cgroup/memory/memory.usage_in_bytes':
          return Promise.resolve('67108864\n');
        case '/sys/fs/cgroup/memory/memory.max_usage_in_bytes':
          return Promise.resolve('134217728\n');
        default:
          return Promise.reject(new Error(`Unexpected path: ${path}`));
      }
    });

    const loop = createComputeProviderUsageInterval({
      runId: 84,
      computeProvider: 'modal',
      logger: {
        warn: vi.fn(),
      } as never,
    });

    try {
      await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
      expect(mockRecordComputeProviderUsage).toHaveBeenCalledWith({
        runId: 84,
        lifecycleAction: 'running',
        completedAt: expect.any(Date),
        sampledCpuUsageNsTotal: 1_000_000_000,
        sampledMemoryUsageBytes: 67_108_864,
        sampledMemoryPeakUsageBytes: 134_217_728,
        details: {
          source: 'worker_heartbeat',
          updateKind: 'periodic',
          cgroupUsageObservationSource: 'cgroup_poll',
        },
      });

      loop.stop();
      await loop.flush({ updateKind: 'shutdown_flush' });

      expect(mockRecordComputeProviderUsage).toHaveBeenLastCalledWith({
        runId: 84,
        lifecycleAction: 'running',
        completedAt: expect.any(Date),
        sampledCpuUsageNsTotal: 1_000_000_000,
        sampledMemoryUsageBytes: 67_108_864,
        sampledMemoryPeakUsageBytes: 134_217_728,
        details: expect.objectContaining({
          source: 'worker_heartbeat',
          updateKind: 'shutdown_flush',
          cgroupUsageObservationSource: 'cgroup_poll',
          modalMemoryDiagnostic: expect.objectContaining({
            reason: 'modal_memory_pressure_diagnostic',
            updateKind: 'shutdown_flush',
          }),
        }),
      });
    } finally {
      loop.stop();
    }
  });

  it('captures threshold-triggered diagnostics and emits a matching event', async () => {
    const recordDiagnosticEvent = vi.fn().mockResolvedValue(undefined);

    mockReadFile.mockImplementation((path: string) => {
      switch (path) {
        case '/sys/fs/cgroup/cpuacct/cpuacct.usage':
          return Promise.resolve('1000000000\n');
        case '/sys/fs/cgroup/memory/memory.usage_in_bytes':
          return Promise.resolve(String(13 * 1024 * 1024 * 1024));
        case '/sys/fs/cgroup/memory/memory.max_usage_in_bytes':
          return Promise.resolve(String(14 * 1024 * 1024 * 1024));
        default:
          return Promise.reject(new Error(`Unexpected path: ${path}`));
      }
    });
    mockExecFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(
          null,
          [
            '123 1 204800 node node /sandbox/worker/dist/worker.js',
            '456 123 102400 git git fetch --all',
          ].join('\n'),
          '',
        );
        return {} as never;
      },
    );

    const loop = createComputeProviderUsageInterval({
      runId: 99,
      computeProvider: 'modal',
      logger: {
        warn: vi.fn(),
      } as never,
      recordDiagnosticEvent,
    });

    try {
      await vi.advanceTimersByTimeAsync(0);

      expect(mockRecordComputeProviderUsage).toHaveBeenCalledWith({
        runId: 99,
        lifecycleAction: 'running',
        completedAt: expect.any(Date),
        sampledCpuUsageNsTotal: 1_000_000_000,
        sampledMemoryUsageBytes: 13 * 1024 * 1024 * 1024,
        sampledMemoryPeakUsageBytes: 14 * 1024 * 1024 * 1024,
        details: expect.objectContaining({
          source: 'worker_heartbeat',
          updateKind: 'periodic',
          cgroupUsageObservationSource: 'cgroup_poll',
          modalMemoryDiagnostic: expect.objectContaining({
            reason: 'modal_memory_pressure_diagnostic',
            diagnosticTriggerReasons: ['memory_pressure_elevated'],
            memoryPressureBand: 'elevated',
            topProcesses: expect.arrayContaining([
              expect.objectContaining({
                pid: 123,
                command: 'node',
              }),
            ]),
          }),
        }),
      });

      expect(recordDiagnosticEvent).toHaveBeenCalledWith({
        message: 'Captured Modal memory diagnostic snapshot for task run #99.',
        details: expect.objectContaining({
          reason: 'modal_memory_pressure_diagnostic',
          diagnosticTriggerReasons: ['memory_pressure_elevated'],
          memoryPressureBand: 'elevated',
        }),
      });
    } finally {
      loop.stop();
    }
  });

  it('does not keep re-emitting the same threshold diagnostic while memory stays flat', async () => {
    const recordDiagnosticEvent = vi.fn().mockResolvedValue(undefined);

    mockReadFile.mockImplementation((path: string) => {
      switch (path) {
        case '/sys/fs/cgroup/cpuacct/cpuacct.usage':
          return Promise.resolve('1000000000\n');
        case '/sys/fs/cgroup/memory/memory.usage_in_bytes':
          return Promise.resolve(String(13 * 1024 * 1024 * 1024));
        case '/sys/fs/cgroup/memory/memory.max_usage_in_bytes':
          return Promise.resolve(String(14 * 1024 * 1024 * 1024));
        default:
          return Promise.reject(new Error(`Unexpected path: ${path}`));
      }
    });

    const loop = createComputeProviderUsageInterval({
      runId: 101,
      computeProvider: 'modal',
      logger: {
        warn: vi.fn(),
      } as never,
      recordDiagnosticEvent,
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(recordDiagnosticEvent).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
      expect(recordDiagnosticEvent).toHaveBeenCalledTimes(1);
    } finally {
      loop.stop();
    }
  });

  it('warns once and falls back when Modal cgroup counters are unavailable', async () => {
    const warn = vi.fn();
    const loop = createComputeProviderUsageInterval({
      runId: 91,
      computeProvider: 'modal',
      logger: { warn } as never,
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(warn).toHaveBeenCalledWith(
        '[workerComputeUsage] Modal cgroup usage counters unavailable for task run 91; falling back to requested-resource estimates.',
      );

      await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(mockRecordComputeProviderUsage).toHaveBeenLastCalledWith({
        runId: 91,
        lifecycleAction: 'running',
        completedAt: expect.any(Date),
        details: {
          source: 'worker_heartbeat',
          updateKind: 'periodic',
        },
      });
    } finally {
      loop.stop();
    }
  });

  it('logs and keeps running when a compute usage update fails', async () => {
    const warn = vi.fn();
    mockRecordComputeProviderUsage.mockRejectedValueOnce(
      new Error('network blip'),
    );
    mockRecordComputeProviderUsage.mockResolvedValue(undefined);

    const loop = createComputeProviderUsageInterval({
      runId: 84,
      computeProvider: 'modal',
      logger: { warn } as never,
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(warn).toHaveBeenCalledWith(
        '[workerComputeUsage] Failed to update compute usage for task run 84: network blip',
      );

      await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
      expect(mockRecordComputeProviderUsage).toHaveBeenLastCalledWith({
        runId: 84,
        lifecycleAction: 'running',
        completedAt: expect.any(Date),
        details: {
          source: 'worker_heartbeat',
          updateKind: 'periodic',
        },
      });
    } finally {
      loop.stop();
    }
  });

  it('includes cgroup samples in running updates for sandbox jobs when counters are available', async () => {
    mockReadFile.mockImplementation((path: string) => {
      switch (path) {
        case '/sys/fs/cgroup/cpuacct/cpuacct.usage':
          return Promise.reject(new Error('missing'));
        case '/sys/fs/cgroup/cpu.stat':
          return Promise.resolve('usage_usec 2500000\nuser_usec 1200000\n');
        case '/sys/fs/cgroup/memory/memory.usage_in_bytes':
        case '/sys/fs/cgroup/memory/memory.max_usage_in_bytes':
          return Promise.reject(new Error('missing'));
        case '/sys/fs/cgroup/memory.current':
          return Promise.resolve('2147483648\n');
        case '/sys/fs/cgroup/memory.peak':
          return Promise.resolve('3221225472\n');
        default:
          return Promise.reject(new Error(`Unexpected path: ${path}`));
      }
    });

    const loop = createComputeProviderUsageInterval({
      runId: 142,
      computeProvider: 'modal',
      logger: {
        warn: vi.fn(),
      } as never,
    });

    try {
      await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
      expect(mockRecordComputeProviderUsage).toHaveBeenCalledWith({
        runId: 142,
        lifecycleAction: 'running',
        completedAt: expect.any(Date),
        sampledCpuUsageNsTotal: 2_500_000_000,
        sampledMemoryUsageBytes: 2_147_483_648,
        sampledMemoryPeakUsageBytes: 3_221_225_472,
        details: {
          source: 'worker_heartbeat',
          updateKind: 'periodic',
          cgroupUsageObservationSource: 'cgroup_poll',
        },
      });
    } finally {
      loop.stop();
    }
  });
});
