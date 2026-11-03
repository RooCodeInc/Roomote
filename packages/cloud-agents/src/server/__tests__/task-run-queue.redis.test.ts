import { randomUUID } from 'node:crypto';

import { getRedis, type Redis } from '@roomote/redis';
import { TaskPayloadKind } from '@roomote/types';

import { TaskRunQueue, resolvePrReviewQueuePolicy } from '../task-run-queue';

// ioredis-mock does not implement Redis's cjson decoder. Exercise the deadline
// guard on the real service supplied by CI, with an exclusive empty test DB.
const fixtureLock = 'test:task-run-queue:database-15';
const queueKeys = [
  'queue:cloud-jobs:v2',
  'queue:cloud-jobs:v2:scopes',
  'queue:cloud-jobs:v2:entries',
  'queue:cloud-jobs:v2:entry-scopes',
];

describe.skipIf(!process.env.REDIS_URL)(
  'TaskRunQueue native Redis deadlines',
  () => {
    let owner: string;
    let control: Redis;
    let redis: Redis;
    let consumerRedis: Redis;
    let scopes: string[];
    let ownsFixture = false;

    beforeAll(async () => {
      owner = randomUUID();
      control = getRedis();
      expect(await control.set(fixtureLock, owner, 'PX', 60_000, 'NX')).toBe(
        'OK',
      );
      redis = control.duplicate({ db: 15 });
      consumerRedis = control.duplicate({ db: 15 });
      expect(await redis.dbsize()).toBe(0);
      ownsFixture = true;
    });

    beforeEach(() => {
      scopes = [];
    });

    afterEach(async () => {
      if (ownsFixture) await redis.del(...queueKeys, ...scopes);
    });

    afterAll(async () => {
      redis?.disconnect();
      consumerRedis?.disconnect();
      if (control) {
        await control.eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
          1,
          fixtureLock,
          owner,
        );
        control.disconnect();
      }
    });

    it.each(['release', 'expire'])(
      'waits for the actual sync deadline after an active lock %s',
      async (handoff) => {
        const scope = `native-queue:${randomUUID()}`;
        const neighborScope = `native-queue:${randomUUID()}`;
        scopes.push(scope, neighborScope);
        const producer = new TaskRunQueue({ redis, timeout: 1 });
        const consumer = new TaskRunQueue({ redis: consumerRedis, timeout: 1 });
        await producer.enqueue({ id: 1, scope });
        expect(await producer.dequeue(false)).toEqual({ id: 1, scope });
        const policy = resolvePrReviewQueuePolicy({
          payloadKind: TaskPayloadKind.GithubPrReviewSync,
          sourceControlProvider: 'github',
        });
        const delayed = { id: 2, scope, ...policy };
        await producer.enqueue(delayed);
        expect(await consumer.dequeue(false)).toBeNull();
        expect(await redis.get(scope)).toBe('1');
        if (handoff === 'release') {
          expect(await producer.releaseLock(scope, 1)).toBe(true);
        } else {
          await redis.pexpire(scope, 1);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await producer.enqueue({ id: 3, scope: neighborScope });
        expect(await consumer.dequeue(false)).toEqual({
          id: 3,
          scope: neighborScope,
        });
        expect(await consumer.dequeue(false)).toBeNull();
        expect(await redis.llen(queueKeys[0]!)).toBe(1);
        expect(await redis.get(scope)).toBe('delay:2');
        expect(await producer.releaseLock(scope, 1)).toBe(false);
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.max(0, policy.availableAt! - Date.now()) + 50,
          ),
        );
        expect(await consumer.dequeue(false)).toEqual(delayed);
        expect(await consumer.dequeue(false)).toBeNull();
      },
      10_000,
    );
  },
);
