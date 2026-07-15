import { RunStatus } from '@roomote/types';
import type { TaskRun } from '@roomote/db/server';

const mockFindFirstRun = vi.fn();
const mockClaimReturning = vi.fn();
const mockRecordTaskRunLifecycleEvent = vi.fn().mockResolvedValue(undefined);
const mockWithSandboxServerRpcClient = vi.fn().mockResolvedValue({
  success: true,
});

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: {
        findFirst: (...args: unknown[]) => mockFindFirstRun(...args),
      },
    },
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: (...args: unknown[]) => mockClaimReturning(...args),
        })),
      })),
    })),
  },
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((...args: unknown[]) => args),
  sql: vi.fn(),
  taskRuns: { id: 'task_runs.id', result: 'task_runs.result' },
  recordTaskRunLifecycleEvent: (...args: unknown[]) =>
    mockRecordTaskRunLifecycleEvent(...args),
}));

vi.mock('../../auth/sandbox-server-rpc', () => ({
  withSandboxServerRpcClient: (...args: unknown[]) =>
    mockWithSandboxServerRpcClient(...args),
}));

import { notifySourceRunOnSettle } from '../notify-source-run-on-settle';

type SettledRun = TaskRun & { task: { title: string | null } };

function makeSettledRun(overrides: Partial<SettledRun> = {}): SettledRun {
  return {
    id: 200,
    taskId: 'child-task',
    sourceRunId: 100,
    payload: { notifySourceRunOnSettle: true },
    environmentSetupState: 'completed',
    error: null,
    result: null,
    task: { title: 'Verify environment' },
    ...overrides,
  } as SettledRun;
}

const activeParent = {
  id: 100,
  taskId: 'parent-task',
  status: RunStatus.Idle,
  sandboxServerUrl: 'https://sandbox.example.test',
};

describe('notifySourceRunOnSettle', () => {
  beforeEach(() => {
    // Default: claim succeeds (marker was absent).
    mockClaimReturning.mockResolvedValue([{ id: 200 }]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('delivers a settle prompt to the launching run and records delivery', async () => {
    mockFindFirstRun.mockResolvedValueOnce(activeParent);

    const sendPromptMutate = vi.fn().mockResolvedValue({ success: true });
    mockWithSandboxServerRpcClient.mockImplementationOnce(
      async (options: {
        call: (client: unknown) => Promise<unknown>;
        runId: number;
        userId: string | null;
      }) => {
        expect(options.runId).toBe(100);
        expect(options.userId).toBeNull();
        return options.call({
          commands: { sendPrompt: { mutate: sendPromptMutate } },
        });
      },
    );

    await notifySourceRunOnSettle(makeSettledRun(), RunStatus.Completed);

    expect(sendPromptMutate).toHaveBeenCalledTimes(1);
    const promptArg = sendPromptMutate.mock.calls[0]?.[0] as {
      prompt: string;
      source: string;
    };
    expect(promptArg.source).toBe('task-settled');
    expect(promptArg.prompt).toContain('Spawned task update');
    expect(promptArg.prompt).toContain('child-task');
    expect(promptArg.prompt).toContain('completed');
    expect(promptArg.prompt).toContain('environment setup state is: completed');
    expect(mockClaimReturning).toHaveBeenCalledTimes(1);
    expect(mockRecordTaskRunLifecycleEvent).toHaveBeenCalledTimes(1);
  });

  it('includes the error and setup state for failed runs', async () => {
    mockFindFirstRun.mockResolvedValueOnce(activeParent);

    const sendPromptMutate = vi.fn().mockResolvedValue({ success: true });
    mockWithSandboxServerRpcClient.mockImplementationOnce(
      async (options: { call: (client: unknown) => Promise<unknown> }) =>
        options.call({
          commands: { sendPrompt: { mutate: sendPromptMutate } },
        }),
    );

    await notifySourceRunOnSettle(
      makeSettledRun({
        environmentSetupState: 'failed',
        error: 'Sandbox startup timed out',
      }),
      RunStatus.Failed,
    );

    const promptArg = sendPromptMutate.mock.calls[0]?.[0] as {
      prompt: string;
    };
    expect(promptArg.prompt).toContain('failed');
    expect(promptArg.prompt).toContain('environment setup state is: failed');
    expect(promptArg.prompt).toContain('Sandbox startup timed out');
  });

  it('does nothing without the payload opt-in', async () => {
    await notifySourceRunOnSettle(
      makeSettledRun({ payload: {} as never }),
      RunStatus.Completed,
    );

    expect(mockFindFirstRun).not.toHaveBeenCalled();
    expect(mockWithSandboxServerRpcClient).not.toHaveBeenCalled();
  });

  it('does nothing without a source run pointer', async () => {
    await notifySourceRunOnSettle(
      makeSettledRun({ sourceRunId: null }),
      RunStatus.Completed,
    );

    expect(mockWithSandboxServerRpcClient).not.toHaveBeenCalled();
  });

  it('skips delivery when another finalization already claimed it', async () => {
    mockFindFirstRun.mockResolvedValueOnce(activeParent);
    mockClaimReturning.mockResolvedValueOnce([]);

    await notifySourceRunOnSettle(makeSettledRun(), RunStatus.Idle);

    expect(mockWithSandboxServerRpcClient).not.toHaveBeenCalled();
    expect(mockRecordTaskRunLifecycleEvent).not.toHaveBeenCalled();
  });

  it('skips same-task resume chains without claiming', async () => {
    mockFindFirstRun.mockResolvedValueOnce({
      ...activeParent,
      taskId: 'child-task',
    });

    await notifySourceRunOnSettle(makeSettledRun(), RunStatus.Completed);

    expect(mockClaimReturning).not.toHaveBeenCalled();
    expect(mockWithSandboxServerRpcClient).not.toHaveBeenCalled();
  });

  it('skips exited or sandbox-less launching runs without claiming', async () => {
    mockFindFirstRun.mockResolvedValueOnce({
      ...activeParent,
      status: RunStatus.Completed,
    });

    await notifySourceRunOnSettle(makeSettledRun(), RunStatus.Completed);

    expect(mockClaimReturning).not.toHaveBeenCalled();
    expect(mockWithSandboxServerRpcClient).not.toHaveBeenCalled();

    mockFindFirstRun.mockResolvedValueOnce({
      ...activeParent,
      sandboxServerUrl: null,
    });

    await notifySourceRunOnSettle(makeSettledRun(), RunStatus.Completed);

    expect(mockClaimReturning).not.toHaveBeenCalled();
    expect(mockWithSandboxServerRpcClient).not.toHaveBeenCalled();
  });

  it('never throws when delivery fails, and records the failure', async () => {
    mockFindFirstRun.mockResolvedValueOnce(activeParent);
    mockWithSandboxServerRpcClient.mockRejectedValueOnce(
      new Error('sandbox unreachable'),
    );

    await expect(
      notifySourceRunOnSettle(makeSettledRun(), RunStatus.Completed),
    ).resolves.toBeUndefined();

    expect(mockClaimReturning).toHaveBeenCalledTimes(1);
    expect(mockRecordTaskRunLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        message: expect.stringContaining('Failed to deliver'),
      }),
    );
  });
});
