const { sdkCloudJobsDoneMock, sdkCloudJobsFindFirstByIdMock } = vi.hoisted(
  () => ({
    sdkCloudJobsDoneMock: vi.fn().mockResolvedValue(undefined),
    sdkCloudJobsFindFirstByIdMock: vi.fn(),
  }),
);

const { captureWorkerExceptionMock } = vi.hoisted(() => ({
  captureWorkerExceptionMock: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    cloudJobs: {
      done: sdkCloudJobsDoneMock,
      findFirstById: sdkCloudJobsFindFirstByIdMock,
      update: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('../../monitoring/sentry', () => ({
  captureWorkerException: captureWorkerExceptionMock,
}));

import { CloudTaskStatus } from '@roomote/types';

import { ExecutionError } from '../../command-executor';
import { finalizeJob, handleJobError } from './job-lifecycle';

describe('job-lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdkCloudJobsFindFirstByIdMock.mockResolvedValue(undefined);
  });

  it('marks the job failed, reports it to Sentry, and calls onExit', async () => {
    const onExit = vi.fn().mockResolvedValue(undefined);

    await handleJobError({
      error: new Error('Environment not found'),
      cloudJob: {
        id: 42,
      } as never,
      logger: undefined,
      callbacks: { onExit },
      context: {},
    });

    expect(sdkCloudJobsDoneMock).toHaveBeenCalledWith({
      id: 42,
      status: CloudTaskStatus.Failed,
      error: 'Environment not found',
    });
    expect(captureWorkerExceptionMock).toHaveBeenCalledWith(expect.any(Error), {
      cloudJobId: 42,
      stage: 'handleJobError',
    });
    expect(onExit).toHaveBeenCalledWith({ id: 42 }, CloudTaskStatus.Failed, {});
  });

  it('persists execution diagnostics for command failures', async () => {
    const error = new ExecutionError('Command failed with exit code 2', {
      command: {
        name: 'Build backend apps',
        run: 'pnpm --filter @currents/core-api build',
        timeout: 600,
        continue_on_error: false,
      },
      success: false,
      duration: 34_018,
      exitCode: 2,
      error: 'Command failed with exit code 2',
      stdout: 'Compiling backend apps...',
      stderr:
        'src/prices.ts:42:7 - error TS2322: Type string is not assignable to type number.',
    });

    await handleJobError({
      error,
      cloudJob: {
        id: 20637,
        taskId: '32pp76cbyk012',
      } as never,
      logger: undefined,
      callbacks: {},
      context: {},
    });

    expect(sdkCloudJobsDoneMock).toHaveBeenCalledWith({
      id: 20637,
      status: CloudTaskStatus.Failed,
      error: expect.stringContaining('pnpm --filter @currents/core-api build'),
    });
    expect(sdkCloudJobsDoneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('stderr -> src/prices.ts:42:7'),
      }),
    );
    expect(sdkCloudJobsDoneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('stdout -> Compiling backend apps'),
      }),
    );
    expect(captureWorkerExceptionMock).toHaveBeenCalledWith(error, {
      cloudJobId: 20637,
      taskId: '32pp76cbyk012',
      stage: 'handleJobError',
      commandName: 'Build backend apps',
      commandRun: 'pnpm --filter @currents/core-api build',
      exitCode: 2,
      commandDurationMs: 34_018,
      commandDiagnostics: expect.stringContaining(
        'stderr -> src/prices.ts:42:7',
      ),
    });
  });

  it('preserves the command and exit code when command output is truncated', async () => {
    const longStdout = `stdout-start\n${'stdout noise\n'.repeat(1_000)}stdout-end`;
    const longStderr = `stderr-start\n${'stderr noise\n'.repeat(1_000)}stderr-end`;
    const commandRun = 'pnpm --filter @currents/core-api build';
    const error = new ExecutionError('Command failed with exit code 2', {
      command: {
        name: 'Build backend apps',
        run: commandRun,
        timeout: 600,
        continue_on_error: false,
      },
      success: false,
      duration: 34_018,
      exitCode: 2,
      error: 'Command failed with exit code 2',
      stdout: longStdout,
      stderr: longStderr,
    });

    await handleJobError({
      error,
      cloudJob: {
        id: 20637,
        taskId: '32pp76cbyk012',
      } as never,
      logger: undefined,
      callbacks: {},
      context: {},
    });

    const doneInput = sdkCloudJobsDoneMock.mock.calls.at(0)?.at(0) as
      | { error?: string }
      | undefined;

    expect(doneInput?.error).toContain(commandRun);
    expect(doneInput?.error).toContain('exit code -> 2');
    expect(doneInput?.error).toContain('stdout-end');
    expect(doneInput?.error).toContain('stderr-end');
    expect(doneInput?.error).not.toContain('stdout-start');
    expect(doneInput?.error).not.toContain('stderr-start');
    expect(doneInput?.error?.length).toBeLessThanOrEqual(8_200);
    expect(captureWorkerExceptionMock).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        commandDiagnostics: expect.stringContaining(commandRun),
      }),
    );
  });

  it('adds finalization context when cloudJobs.done throws', async () => {
    sdkCloudJobsDoneMock.mockRejectedValueOnce(new Error('fetch failed'));

    await expect(
      finalizeJob({
        result: { status: CloudTaskStatus.Completed },
        cloudJob: { id: 84, result: null } as never,
        logger: undefined as never,
        callbacks: {},
        context: {},
      }),
    ).rejects.toThrow(
      'cloudJobs.done(completed) failed during finalization for cloud job 84: fetch failed',
    );
  });
});
