const { queryFindFirst, updateReturning, enqueueTask, releaseTaskWaitResume } =
  vi.hoisted(() => ({
    queryFindFirst: vi.fn(),
    updateReturning: vi.fn(),
    enqueueTask: vi.fn(),
    releaseTaskWaitResume: vi.fn(),
  }));

vi.mock('@roomote/cloud-agents/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/cloud-agents/server')>()),
  enqueueTask,
}));
vi.mock('@roomote/db/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/db/server')>();
  return {
    ...actual,
    db: {
      ...actual.db,
      query: { ...actual.db.query, taskRuns: { findFirst: queryFindFirst } },
    },
    releaseTaskWaitResume,
  };
});

import { TaskRunQueueEnqueueError } from '@roomote/cloud-agents/server';
import { wakeTaskJob } from './task-wake-queue';

describe('task wake queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    releaseTaskWaitResume.mockResolvedValue(true);
    queryFindFirst.mockResolvedValue({
      id: 42,
      taskId: 'task-1',
      status: 'completed',
      snapshotId: 'snapshot-42',
      snapshotCreatedAt: new Date(),
      waitUntil: new Date('2026-08-13T16:00:00.000Z'),
      waitReason: 'Check deployment',
      waitResumedAt: null,
      waitResumeRunId: null,
      payload: {
        repo: 'RooCodeInc/Roomote',
        communicationProvider: 'discord',
        communicationChannelId: 'thread-1',
      },
      port: 3000,
      actingUserId: 'user-1',
    });
    updateReturning.mockResolvedValue([{ id: 42 }]);
    enqueueTask.mockImplementation(async (_input, options) => {
      const tx = {
        execute: vi.fn(),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({ returning: updateReturning })),
          })),
        })),
      };
      await options.afterCreateInTransaction(tx, { id: 99 });
      return { id: 99 };
    });
  });

  it('creates one hidden continuation from the persisted snapshot', async () => {
    await wakeTaskJob({
      data: { runId: 42, waitUntil: '2026-08-13T16:00:00.000Z' },
    } as never);

    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: 'snapshot_resume',
          payload: expect.objectContaining({
            taskWaitWake: true,
            resumePromptSource: 'task-wait',
            resumePrompt: expect.stringContaining('Check deployment'),
          }),
        }),
      }),
      expect.objectContaining({ launchClass: 'human' }),
    );
  });

  it('no-ops after the wait has already resumed', async () => {
    queryFindFirst.mockResolvedValueOnce({
      waitUntil: new Date('2026-08-13T16:00:00.000Z'),
      waitResumedAt: new Date(),
      waitResumeRunId: 99,
    });

    await wakeTaskJob({
      data: { runId: 42, waitUntil: '2026-08-13T16:00:00.000Z' },
    } as never);

    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it('reopens the wait claim when the resume child cannot be queued', async () => {
    enqueueTask.mockRejectedValueOnce(
      new TaskRunQueueEnqueueError({
        runId: 99,
        taskId: 'task-1',
        originalError: new Error('redis unavailable'),
      }),
    );

    await expect(
      wakeTaskJob({
        data: { runId: 42, waitUntil: '2026-08-13T16:00:00.000Z' },
      } as never),
    ).rejects.toThrow('Failed to enqueue task run 99');
    expect(releaseTaskWaitResume).toHaveBeenCalledWith({
      runId: 42,
      waitUntil: new Date('2026-08-13T16:00:00.000Z'),
      resumeRunId: 99,
    });
  });

  it('recovers a canceled claimed child on a queue retry', async () => {
    queryFindFirst
      .mockResolvedValueOnce({
        id: 42,
        taskId: 'task-1',
        status: 'completed',
        snapshotId: 'snapshot-42',
        snapshotCreatedAt: new Date(),
        waitUntil: new Date('2026-08-13T16:00:00.000Z'),
        waitReason: 'Check deployment',
        waitResumedAt: new Date(),
        waitResumeRunId: 98,
        payload: { repo: 'RooCodeInc/Roomote' },
        port: 3000,
        actingUserId: 'user-1',
      })
      .mockResolvedValueOnce({ status: 'canceled' });

    await wakeTaskJob({
      attemptsMade: 1,
      data: { runId: 42, waitUntil: '2026-08-13T16:00:00.000Z' },
    } as never);

    expect(releaseTaskWaitResume).toHaveBeenCalledWith({
      runId: 42,
      waitUntil: new Date('2026-08-13T16:00:00.000Z'),
      resumeRunId: 98,
    });
    expect(enqueueTask).toHaveBeenCalledOnce();
  });
});
