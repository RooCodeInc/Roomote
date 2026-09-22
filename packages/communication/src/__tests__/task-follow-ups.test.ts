import { afterEach, describe, expect, it } from 'vitest';
import { getRedis } from '@roomote/redis';

import {
  hasQueuedTaskFollowUps,
  peekTaskFollowUps,
  queueTaskFollowUp,
  removeTaskFollowUp,
  wasTaskFollowUpQueued,
} from '../messages';

const RUN_ID = 987_654_321;

async function cleanup() {
  const redis = getRedis();
  const keys = await redis.keys(`task_follow_ups:*${RUN_ID}*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

describe('task follow-up queue', () => {
  afterEach(cleanup);

  it('queues each client message id once and peeks in FIFO order', async () => {
    expect(
      await queueTaskFollowUp(RUN_ID, {
        clientMessageId: 'client-first',
        deliveryMode: 'send',
        prompt: 'first',
        userId: 'user-a',
      }),
    ).toBe(true);
    expect(
      await queueTaskFollowUp(RUN_ID, {
        clientMessageId: 'client-first',
        deliveryMode: 'send',
        prompt: 'first retry',
      }),
    ).toBe(false);
    await queueTaskFollowUp(RUN_ID, {
      clientMessageId: 'client-second',
      deliveryMode: 'steer',
      prompt: 'second',
    });

    const peeked = await peekTaskFollowUps(RUN_ID);

    expect(peeked.map((entry) => entry.message)).toEqual([
      {
        clientMessageId: 'client-first',
        deliveryMode: 'send',
        prompt: 'first',
        userId: 'user-a',
      },
      {
        clientMessageId: 'client-second',
        deliveryMode: 'steer',
        prompt: 'second',
      },
    ]);
  });

  it('stays open until each delivered entry is removed', async () => {
    await queueTaskFollowUp(RUN_ID, {
      clientMessageId: 'client-only',
      deliveryMode: 'send',
      prompt: 'only',
    });
    const [entry] = await peekTaskFollowUps(RUN_ID);

    // Peeking alone does not consume: undelivered prompts keep later
    // follow-ups queued behind them.
    expect(await hasQueuedTaskFollowUps(RUN_ID)).toBe(true);

    await removeTaskFollowUp(RUN_ID, entry!.raw);

    expect(await hasQueuedTaskFollowUps(RUN_ID)).toBe(false);
  });

  it('confirms admission by client message id', async () => {
    expect(await wasTaskFollowUpQueued(RUN_ID, 'client-confirm')).toBe(false);

    await queueTaskFollowUp(RUN_ID, {
      clientMessageId: 'client-confirm',
      deliveryMode: 'send',
      prompt: 'confirm me',
    });

    expect(await wasTaskFollowUpQueued(RUN_ID, 'client-confirm')).toBe(true);
  });

  it('surfaces unparseable entries as null so the worker can drop them', async () => {
    await getRedis().rpush(`task_follow_ups:${RUN_ID}`, 'not json');

    const [entry] = await peekTaskFollowUps(RUN_ID);

    expect(entry).toEqual({ raw: 'not json', message: null });
  });
});
