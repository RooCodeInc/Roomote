import { RunStatus } from '@roomote/types';

const mocks = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock('bullmq', () => ({
  Queue: class {
    add = mocks.add;
  },
}));
vi.mock('@roomote/redis', () => ({ getRedis: () => ({}) }));

import {
  WEB_TASK_INITIATOR_SETTLE_NOTIFICATION_JOB,
  enqueueWebTaskInitiatorSettleNotification,
} from './enqueue-web-task-initiator-settle-notification';

it('enqueues retryable deduplicated settlement delivery', async () => {
  mocks.add.mockResolvedValue(undefined);

  await expect(
    enqueueWebTaskInitiatorSettleNotification({
      runId: 42,
      taskId: 'task-1',
      status: RunStatus.Completed,
    }),
  ).resolves.toBe(true);

  expect(mocks.add).toHaveBeenCalledWith(
    WEB_TASK_INITIATOR_SETTLE_NOTIFICATION_JOB,
    { runId: 42, taskId: 'task-1', status: RunStatus.Completed },
    expect.objectContaining({
      jobId: 'web-task-initiator-settle:42:completed',
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
    }),
  );
});

it('reports queue admission failure without rejecting terminal finalization', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.add.mockRejectedValueOnce(new Error('redis unavailable'));

  await expect(
    enqueueWebTaskInitiatorSettleNotification({
      runId: 42,
      taskId: 'task-1',
      status: RunStatus.Completed,
    }),
  ).resolves.toBe(false);
  expect(error).toHaveBeenCalledWith(
    '[enqueueWebTaskInitiatorSettleNotification] Failed to enqueue retry for run 42: redis unavailable',
  );
  error.mockRestore();
});
