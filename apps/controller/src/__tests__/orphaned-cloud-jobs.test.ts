import { RunStatus, TaskPayloadKind } from '@roomote/types';
import type { Run } from '@roomote/db/server';

const { mockReleaseCloudTask, mockTransaction } = vi.hoisted(() => ({
  mockReleaseCloudTask: vi.fn().mockResolvedValue(true),
  mockTransaction: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  releaseCloudTask: (...args: unknown[]) => mockReleaseCloudTask(...args),
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

import { getOrphanedJob } from '../orphaned-cloud-jobs';

function makeRun(): Run {
  return {
    id: 42,
    taskId: 'task-42',
    payloadKind: TaskPayloadKind.StandardTask,
    payload: { repo: 'acme/widgets' },
    status: RunStatus.Dequeued,
    queueScope: 'scope-42',
    createdAt: new Date(Date.now() - 60 * 60 * 1000),
    dequeuedAt: new Date(),
  } as Run;
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

describe('getOrphanedJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('claims a persisted recovery lease before releasing the owned Redis lock', async () => {
    const run = makeRun();
    const execute = vi.fn().mockResolvedValue([{ id: run.id }]);
    const findFirst = vi.fn().mockResolvedValue(run);

    mockTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          execute,
          query: { taskRuns: { findFirst } },
        }),
    );

    await expect(getOrphanedJob()).resolves.toBe(run);
    expect(mockReleaseCloudTask).toHaveBeenCalledWith(run);

    const claimQuery = execute.mock.calls[0]?.[0];
    expect(collectStrings(claimQuery).join(' ')).toContain(
      'FOR UPDATE SKIP LOCKED',
    );
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

    await expect(getOrphanedJob()).resolves.toBeNull();
    expect(mockReleaseCloudTask).not.toHaveBeenCalled();
  });
});
