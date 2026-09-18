import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, Worker } from 'bullmq';
import Redis from 'ioredis';

const prepareDelivery = vi.hoisted(() => vi.fn());
vi.mock('@roomote/sdk/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/sdk/server')>()),
  preparePrReviewNotificationDelivery: prepareDelivery,
}));

import {
  claimDueCanonicalPrReviewDeliveries,
  db,
  eq,
  persistPrReviewEvent,
  prReviewNotificationDeliveries,
  runFactory,
  taskFactory,
  taskPullRequests,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import {
  finalizePrReviewNotificationRequest,
  prReviewNotificationRequestSchema,
  type PrReviewNotificationRequest,
} from '@roomote/sdk/server';
import { RunStatus } from '@roomote/types';

import { prReviewNotificationJob } from './pr-review-notification';

it.each([false, true])(
  'uses the real queue retry without a scheduler drain and respects invalidated claims (invalidated: %s)',
  async (invalidateClaim) => {
    const task = await taskFactory.create();
    await runFactory.create({ taskId: task.id, status: RunStatus.Completed });
    const repository = `owner/retry-${task.id}`;
    const prUrl = `https://github.com/${repository}/pull/1`;
    await db.insert(taskPullRequests).values({
      taskId: task.id,
      sourceControlProvider: 'github',
      repository,
      prNumber: 1,
      prUrl,
      status: 'open',
    });
    await persistPrReviewEvent({
      eventKey: `retry-${task.id}`,
      sourceControlProvider: 'github',
      repository,
      prNumber: 1,
      prUrl,
      event: { kind: 'review_comment', authorLogin: 'reviewer' },
      batchKind: 'human',
      batchId: null,
      dueAt: new Date(0),
      observedAt: new Date(),
    });
    const [claim] = await claimDueCanonicalPrReviewDeliveries(new Date(), {
      repository,
    });
    expect(claim).toBeDefined();
    const request = prReviewNotificationRequestSchema.parse({
      ...claim,
      deliveryState: claim!.state,
    });
    const readDelivery = () =>
      db.query.prReviewNotificationDeliveries.findFirst({
        where: eq(prReviewNotificationDeliveries.id, request.deliveryId!),
      });

    prepareDelivery.mockReset();
    prepareDelivery
      .mockRejectedValueOnce(new Error('simulated triage timeout'))
      .mockResolvedValue({ post: false, reason: 'not_worth_notifying' });
    const connection = new Redis(Env.REDIS_URL, { maxRetriesPerRequest: null });
    const queueName = `pr-review-retry-test-${randomUUID()}`;
    const queue = new Queue<PrReviewNotificationRequest>(queueName, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      },
    });
    const queueEvents = new QueueEvents(queueName, { connection });
    const worker = new Worker(queueName, prReviewNotificationJob, {
      connection,
    });
    try {
      await queueEvents.waitUntilReady();
      const job = await queue.add('notify-pr-review-activity', request);
      await vi.waitFor(async () => {
        expect(await job.getState()).toBe('delayed');
      });
      expect(await readDelivery()).toMatchObject({
        status: 'claimed',
        leaseToken: request.leaseToken,
      });
      if (invalidateClaim) {
        await finalizePrReviewNotificationRequest(request, 'suppressed');
      }

      await job.waitUntilFinished(queueEvents, 10_000);
      expect(prepareDelivery).toHaveBeenCalledTimes(invalidateClaim ? 1 : 2);
      expect(await readDelivery()).toMatchObject({
        status: 'suppressed',
        leaseToken: null,
      });
    } finally {
      await worker.close();
      await queueEvents.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await connection.quit();
    }
  },
  15_000,
);
