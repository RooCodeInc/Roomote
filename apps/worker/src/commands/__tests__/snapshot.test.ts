import { RunStatus } from '@roomote/types';

const {
  mockTaskRunsUpdate,
  mockFetchSnapshotEnv,
  mockFindEnvironment,
  mockDone,
  mockUpdateSnapshotStatus,
  mockSetup,
  mockInjectEnvVars,
  mockWorkerEnvFromProcessEnv,
  mockCreateStartupLogger,
  mockCaptureWorkerException,
  mockSetWorkerRuntimeContext,
  mockClearWorkerRuntimeContext,
} = vi.hoisted(() => ({
  mockTaskRunsUpdate: vi.fn(),
  mockFetchSnapshotEnv: vi.fn(),
  mockFindEnvironment: vi.fn(),
  mockDone: vi.fn(),
  mockUpdateSnapshotStatus: vi.fn(),
  mockSetup: vi.fn(),
  mockInjectEnvVars: vi.fn(),
  mockWorkerEnvFromProcessEnv: vi.fn(),
  mockCreateStartupLogger: vi.fn(),
  mockCaptureWorkerException: vi.fn(),
  mockSetWorkerRuntimeContext: vi.fn(),
  mockClearWorkerRuntimeContext: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      update: mockTaskRunsUpdate,
      fetchSnapshotEnv: mockFetchSnapshotEnv,
      done: mockDone,
    },
    environments: {
      findEnvironment: mockFindEnvironment,
      updateSnapshotStatus: mockUpdateSnapshotStatus,
    },
  },
}));

vi.mock('../setup', () => ({
  setup: mockSetup,
}));

vi.mock('../utils/env-vars', () => ({
  injectEnvVars: mockInjectEnvVars,
}));

vi.mock('../../env', () => ({
  WorkerEnv: {
    fromProcessEnv: mockWorkerEnvFromProcessEnv,
  },
}));

vi.mock('../../logging', () => ({
  createStartupLogger: mockCreateStartupLogger,
}));

vi.mock('../../monitoring/sentry', () => ({
  captureWorkerException: mockCaptureWorkerException,
}));

vi.mock('../../monitoring/runtime-context', () => ({
  setWorkerRuntimeContext: mockSetWorkerRuntimeContext,
  clearWorkerRuntimeContext: mockClearWorkerRuntimeContext,
}));

import {
  AUTO_SNAPSHOT_TIMEOUT_MS,
  EXPLICIT_SNAPSHOT_TIMEOUT_MS,
  snapshot,
} from '../snapshot';

describe('snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockFetchSnapshotEnv.mockResolvedValue({
      envVars: { R_PREVIEW_PROXY_BASE_URL: 'https://preview.roomote.run' },
      gitHubToken: 'gh-token',
      taskId: 'task-42',
    });
    mockFindEnvironment.mockResolvedValue({
      id: 'env-1',
      config: {
        name: 'App',
        repositories: [{ repository: 'Roomote/example-app' }],
      },
    });
    mockWorkerEnvFromProcessEnv.mockReturnValue({});
    mockCreateStartupLogger.mockReturnValue({ userLog: { log: vi.fn() } });
    mockDone.mockResolvedValue(undefined);
    mockUpdateSnapshotStatus.mockResolvedValue(undefined);
    mockSetup.mockRejectedValue(new Error('setup failed'));
  });

  it('uses a longer timeout for explicit snapshot polling than the shared sleep handoff timeout', () => {
    expect(AUTO_SNAPSHOT_TIMEOUT_MS).toBe(5 * 60 * 1_000);
    expect(EXPLICIT_SNAPSHOT_TIMEOUT_MS).toBe(10 * 60 * 1_000);
  });

  it('treats the failure cleanup status write as a best-effort no-op when it succeeds idempotently', async () => {
    const result = await snapshot({
      runId: 42,
      environmentId: 'env-1',
      sandboxId: 'sb-1',
    });

    expect(result).toBe(false);
    expect(mockDone).toHaveBeenCalledWith({
      id: 42,
      status: RunStatus.Failed,
      error: 'setup failed',
    });
    expect(mockUpdateSnapshotStatus).toHaveBeenCalledWith({
      environmentId: 'env-1',
      snapshotStatus: 'failed',
    });
    const injectCallOrder = mockInjectEnvVars.mock.invocationCallOrder[0];
    const findEnvironmentCallOrder =
      mockFindEnvironment.mock.invocationCallOrder[0];

    expect(injectCallOrder).toBeDefined();
    expect(findEnvironmentCallOrder).toBeDefined();
    expect(mockSetWorkerRuntimeContext).toHaveBeenNthCalledWith(1, {
      runId: 42,
      taskRunType: 'snapshot_environment',
      environmentId: 'env-1',
    });
    expect(mockSetWorkerRuntimeContext).toHaveBeenNthCalledWith(2, {
      runId: 42,
      taskRunType: 'snapshot_environment',
      environmentId: 'env-1',
      taskId: 'task-42',
    });
    expect(mockCaptureWorkerException).toHaveBeenCalledTimes(1);
    expect(mockCaptureWorkerException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'setup failed' }),
      {
        runId: 42,
        environmentId: 'env-1',
        stage: 'snapshot',
      },
    );
  });
});
