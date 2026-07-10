const { sdkTaskRunsDoneMock, sdkTaskRunsFindFirstByIdMock } = vi.hoisted(
  () => ({
    sdkTaskRunsDoneMock: vi.fn().mockResolvedValue(undefined),
    sdkTaskRunsFindFirstByIdMock: vi.fn(),
  }),
);

const { captureWorkerExceptionMock } = vi.hoisted(() => ({
  captureWorkerExceptionMock: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      done: sdkTaskRunsDoneMock,
      findFirstById: sdkTaskRunsFindFirstByIdMock,
      update: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('../../monitoring/sentry', () => ({
  captureWorkerException: captureWorkerExceptionMock,
}));

import { RunStatus } from '@roomote/types';

import { ExecutionError } from '../../command-executor';
import { finalizeJob, handleTaskRunError } from './task-run-lifecycle';

describe('task-run-lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdkTaskRunsFindFirstByIdMock.mockResolvedValue(undefined);
  });

  it('marks the job failed, reports it to Sentry, and calls onExit', async () => {
    const onExit = vi.fn().mockResolvedValue(undefined);

    await handleTaskRunError({
      error: new Error('Environment not found'),
      taskRun: {
        id: 42,
      } as never,
      logger: undefined,
      callbacks: { onExit },
      context: {},
    });

    expect(sdkTaskRunsDoneMock).toHaveBeenCalledWith({
      id: 42,
      status: RunStatus.Failed,
      error: 'Environment not found',
    });
    expect(captureWorkerExceptionMock).toHaveBeenCalledWith(expect.any(Error), {
      runId: 42,
      stage: 'handleTaskRunError',
    });
    expect(onExit).toHaveBeenCalledWith({ id: 42 }, RunStatus.Failed, {});
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

    await handleTaskRunError({
      error,
      taskRun: {
        id: 20637,
        taskId: '32pp76cbyk012',
      } as never,
      logger: undefined,
      callbacks: {},
      context: {},
    });

    expect(sdkTaskRunsDoneMock).toHaveBeenCalledWith({
      id: 20637,
      status: RunStatus.Failed,
      error: expect.stringContaining('pnpm --filter @currents/core-api build'),
    });
    expect(sdkTaskRunsDoneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('stderr -> src/prices.ts:42:7'),
      }),
    );
    expect(sdkTaskRunsDoneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('stdout -> Compiling backend apps'),
      }),
    );
    expect(captureWorkerExceptionMock).toHaveBeenCalledWith(error, {
      runId: 20637,
      taskId: '32pp76cbyk012',
      stage: 'handleTaskRunError',
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

    await handleTaskRunError({
      error,
      taskRun: {
        id: 20637,
        taskId: '32pp76cbyk012',
      } as never,
      logger: undefined,
      callbacks: {},
      context: {},
    });

    const doneInput = sdkTaskRunsDoneMock.mock.calls.at(0)?.at(0) as
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

  it('adds finalization context when taskRuns.done throws', async () => {
    sdkTaskRunsDoneMock.mockRejectedValueOnce(new Error('fetch failed'));

    await expect(
      finalizeJob({
        result: { status: RunStatus.Completed },
        taskRun: { id: 84, result: null } as never,
        logger: undefined as never,
        callbacks: {},
        context: {},
      }),
    ).rejects.toThrow(
      'taskRuns.done(completed) failed during finalization for task run 84: fetch failed',
    );
  });
});
