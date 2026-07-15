import { RunStatus, TaskPayloadKind } from '@roomote/types';
import type { TaskRun } from '@roomote/db/server';

const { mockReleaseTaskRun, mockTransaction } = vi.hoisted(() => ({
  mockReleaseTaskRun: vi.fn().mockResolvedValue(true),
  mockTransaction: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  releaseTaskRun: (...args: unknown[]) => mockReleaseTaskRun(...args),
}));

vi.mock('@roomote/db/server', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/db/server')>(
      '@roomote/db/server',
    );

  return {
    ...actual,
    db: {
      transaction: (...args: unknown[]) => mockTransaction(...args),
    },
  };
});

import { getOrphanedTaskRun } from '../orphaned-task-runs';

function makeTaskRun(): TaskRun {
  return {
    id: 42,
    taskId: 'task-42',
    payloadKind: TaskPayloadKind.StandardTask,
    payload: { repo: 'acme/widgets' },
    status: RunStatus.Dequeued,
    queueScope: 'scope-42',
    createdAt: new Date(Date.now() - 60 * 60 * 1000),
    dequeuedAt: new Date(),
  } as TaskRun;
}

function collectStrings(
  value: unknown,
  seen = new WeakSet<object>(),
): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (!value || typeof value !== 'object' || seen.has(value)) {
    return [];
  }

  seen.add(value);
  return Object.values(value).flatMap((entry) => collectStrings(entry, seen));
}

describe('getOrphanedTaskRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('claims a persisted recovery lease before releasing the owned Redis lock', async () => {
    const taskRun = makeTaskRun();
    const execute = vi.fn().mockResolvedValue([{ id: taskRun.id }]);
    const findFirst = vi.fn().mockResolvedValue(taskRun);

    mockTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          execute,
          query: { taskRuns: { findFirst } },
        }),
    );

    await expect(getOrphanedTaskRun()).resolves.toBe(taskRun);
    expect(mockReleaseTaskRun).toHaveBeenCalledWith(taskRun);

    const claimQuery = execute.mock.calls[0]?.[0];
    const claimSql = collectStrings(claimQuery).join(' ');
    expect(claimSql).toContain('FOR UPDATE SKIP LOCKED');
    expect(claimSql).toContain('task_phase IS DISTINCT FROM');
    expect(claimSql).toContain('waiting_for_sandbox_provider');
  });

  it('returns null without touching Redis when no stale row is claimable', async () => {
    const execute = vi.fn().mockResolvedValue([]);

    mockTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          execute,
          query: { taskRuns: { findFirst: vi.fn() } },
        }),
    );

    await expect(getOrphanedTaskRun()).resolves.toBeNull();
    expect(mockReleaseTaskRun).not.toHaveBeenCalled();
  });
});
