import { RunStatus } from '@roomote/types';
import type { TaskRun } from '@roomote/db/server';

const mockFindFirstRun = vi.fn();
const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
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
        where: (...args: unknown[]) => mockUpdateWhere(...args),
      })),
    })),
  },
  eq: vi.fn((...args: unknown[]) => args),
  taskRuns: { id: 'task_runs.id' },
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

function mockParentRunLookup(parent: Record<string, unknown> | null) {
  // First findFirst call re-reads the child row (at-most-once guard); the
  // second resolves the parent run.
  mockFindFirstRun
    .mockResolvedValueOnce({ result: null })
    .mockResolvedValueOnce(parent);
}

const activeParent = {
  id: 100,
  taskId: 'parent-task',
  status: RunStatus.Idle,
  sandboxServerUrl: 'https://sandbox.example.test',
};

describe('notifySourceRunOnSettle', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('delivers a settle prompt to the launching run and records delivery', async () => {
    mockParentRunLookup(activeParent);

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
    expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
    expect(mockRecordTaskRunLifecycleEvent).toHaveBeenCalledTimes(1);
  });

  it('includes the error and setup state for failed runs', async () => {
    mockParentRunLookup(activeParent);

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

  it('skips delivery when it already notified once', async () => {
    mockFindFirstRun.mockResolvedValueOnce({
      result: { sourceRunSettleNotifiedAt: '2026-07-14T00:00:00Z' },
    });

    await notifySourceRunOnSettle(makeSettledRun(), RunStatus.Idle);

    expect(mockWithSandboxServerRpcClient).not.toHaveBeenCalled();
  });

  it('skips same-task resume chains', async () => {
    mockParentRunLookup({ ...activeParent, taskId: 'child-task' });

    await notifySourceRunOnSettle(makeSettledRun(), RunStatus.Completed);

    expect(mockWithSandboxServerRpcClient).not.toHaveBeenCalled();
  });

  it('skips exited or sandbox-less launching runs', async () => {
    mockParentRunLookup({ ...activeParent, status: RunStatus.Completed });

    await notifySourceRunOnSettle(makeSettledRun(), RunStatus.Completed);

    expect(mockWithSandboxServerRpcClient).not.toHaveBeenCalled();

    mockParentRunLookup({ ...activeParent, sandboxServerUrl: null });

    await notifySourceRunOnSettle(makeSettledRun(), RunStatus.Completed);

    expect(mockWithSandboxServerRpcClient).not.toHaveBeenCalled();
  });

  it('never throws when delivery fails, and records the failure', async () => {
    mockParentRunLookup(activeParent);
    mockWithSandboxServerRpcClient.mockRejectedValueOnce(
      new Error('sandbox unreachable'),
    );

    await expect(
      notifySourceRunOnSettle(makeSettledRun(), RunStatus.Completed),
    ).resolves.toBeUndefined();

    expect(mockUpdateWhere).not.toHaveBeenCalled();
    expect(mockRecordTaskRunLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        message: expect.stringContaining('Failed to deliver'),
      }),
    );
  });
});
