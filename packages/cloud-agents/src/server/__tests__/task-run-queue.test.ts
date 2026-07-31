// pnpm --filter @roomote/cloud-agents test src/server/__tests__/task-run-queue.test.ts
import Redis from 'ioredis-mock';

import { TASK_TIMEOUT_MS } from '@roomote/types';

import { TaskRunQueue, type TaskRunQueueEntry } from '../task-run-queue';

const QUEUE_KEY = 'queue:cloud-jobs:v2';
const SCOPES_KEY = 'queue:cloud-jobs:v2:scopes';
const ENTRIES_KEY = 'queue:cloud-jobs:v2:entries';
const ENTRY_SCOPES_KEY = 'queue:cloud-jobs:v2:entry-scopes';

// Keep copies of the pre-change scripts here to prove a controller or producer
// from the previous release honors delays created by the new implementation.
const PREVIOUS_V2_ENQUEUE_SCRIPT = `
local incomingId = ARGV[1]
local incomingScope = ARGV[2]
local incomingRaw = ARGV[3]
local existingId = redis.call('HGET', KEYS[2], incomingScope)
local evictedId = ''

if existingId then
  redis.call('LREM', KEYS[1], 0, existingId)

  if existingId ~= incomingId then
    evictedId = existingId
    redis.call('HDEL', KEYS[3], existingId)
    redis.call('HDEL', KEYS[4], existingId)
  end
end

redis.call('HSET', KEYS[2], incomingScope, incomingId)
redis.call('HSET', KEYS[3], incomingId, incomingRaw)
redis.call('HSET', KEYS[4], incomingId, incomingScope)
redis.call('RPUSH', KEYS[1], incomingId)

return evictedId
`;

const PREVIOUS_V2_DEQUEUE_SCRIPT = `
local queueLength = redis.call('LLEN', KEYS[1])
local lockTtlSeconds = tonumber(ARGV[1])

for _ = 1, queueLength do
  local entryId = redis.call('LPOP', KEYS[1])

  if entryId then
    local rawValue = redis.call('HGET', KEYS[3], entryId)
    local entryScope = redis.call('HGET', KEYS[4], entryId)

    if rawValue and entryScope then
      local acquired = redis.call(
        'SET',
        entryScope,
        entryId,
        'EX',
        lockTtlSeconds,
        'NX'
      )

      if acquired then
        redis.call('HDEL', KEYS[3], entryId)
        redis.call('HDEL', KEYS[4], entryId)

        if redis.call('HGET', KEYS[2], entryScope) == entryId then
          redis.call('HDEL', KEYS[2], entryScope)
        end

        return rawValue
      end

      redis.call('RPUSH', KEYS[1], entryId)
    end
  end
end

return nil
`;

function createMockRedis() {
  return new Redis();
}

function createTestQueue(timeout = 1) {
  const redis = createMockRedis();
  return { queue: new TaskRunQueue({ redis, timeout }), redis };
}

function createTestEntry(id: number, scope: string): TaskRunQueueEntry {
  return { id, scope };
}

describe('TaskRunQueue - Basic Operations', () => {
  let queue: TaskRunQueue;
  let redis: InstanceType<typeof Redis>;

  beforeEach(() => {
    const setup = createTestQueue(1);
    queue = setup.queue;
    redis = setup.redis;
  });

  afterEach(async () => {
    await redis.flushall();
  });

  describe('enqueue', () => {
    it('should enqueue a single entry', async () => {
      const entry = createTestEntry(1, 'scope-1');

      await queue.enqueue(entry);
      const dequeued = await queue.dequeue(false);

      expect(dequeued).toEqual(entry);
    });

    it('should enqueue multiple entries', async () => {
      const entries = [
        createTestEntry(1, 'scope-1'),
        createTestEntry(2, 'scope-2'),
        createTestEntry(3, 'scope-3'),
      ];

      for (const entry of entries) {
        await queue.enqueue(entry);
      }

      const dequeued1 = await queue.dequeue(false);
      const dequeued2 = await queue.dequeue(false);
      const dequeued3 = await queue.dequeue(false);

      expect(dequeued1).toEqual(entries[0]);
      expect(dequeued2).toEqual(entries[1]);
      expect(dequeued3).toEqual(entries[2]);
    });

    it('should preserve entry data', async () => {
      const entry = createTestEntry(42, 'test-scope-with-special-chars-!@#');

      await queue.enqueue(entry);
      const dequeued = await queue.dequeue(false);

      expect(dequeued?.id).toBe(42);
      expect(dequeued?.scope).toBe('test-scope-with-special-chars-!@#');
    });
  });

  describe('dequeue', () => {
    it('should dequeue entry in FIFO order', async () => {
      await queue.enqueue(createTestEntry(1, 'scope-1'));
      await queue.enqueue(createTestEntry(2, 'scope-2'));
      await queue.enqueue(createTestEntry(3, 'scope-3'));

      const first = await queue.dequeue(false);
      const second = await queue.dequeue(false);
      const third = await queue.dequeue(false);

      expect(first?.id).toBe(1);
      expect(second?.id).toBe(2);
      expect(third?.id).toBe(3);
    });

    it('should return null from empty queue immediately', async () => {
      const result = await queue.dequeue(false);

      expect(result).toBeNull();
    });

    it('leaves delayed entries queued while dequeuing ready work behind them', async () => {
      const delayed = {
        ...createTestEntry(1, 'delayed-scope'),
        availableAt: Date.now() + 60_000,
      };
      const ready = createTestEntry(2, 'ready-scope');
      await queue.enqueue(delayed);
      await queue.enqueue(ready);

      await expect(queue.dequeue(false)).resolves.toEqual(ready);
      await expect(queue.dequeue(false)).resolves.toBeNull();
      await expect(redis.llen(QUEUE_KEY)).resolves.toBe(1);

      const nowReady = { ...delayed, availableAt: Date.now() - 1 };
      await queue.enqueue(nowReady);
      await expect(queue.dequeue(false)).resolves.toEqual(nowReady);
    });

    it('resets a delayed scope to the newest debounce deadline', async () => {
      const scope = 'debounced-scope';
      const older = {
        ...createTestEntry(1, scope),
        availableAt: Date.now() - 1,
      };
      const newer = {
        ...createTestEntry(2, scope),
        availableAt: Date.now() + 60_000,
      };

      await queue.enqueue(older);
      await expect(queue.enqueue(newer)).resolves.toEqual([
        { id: older.id, scope },
      ]);
      await expect(queue.dequeue(false)).resolves.toBeNull();
      await expect(redis.llen(QUEUE_KEY)).resolves.toBe(1);
    });

    it('preserves the existing entry when the incoming run requests first-wins semantics', async () => {
      const scope = 'first-wins-scope';
      const existing = createTestEntry(1, scope);
      const incoming = {
        ...createTestEntry(2, scope),
        preserveExisting: true,
      };

      await queue.enqueue(existing);
      await expect(queue.enqueue(incoming)).resolves.toEqual([
        { id: incoming.id, scope },
      ]);
      await expect(queue.dequeue(false)).resolves.toEqual(existing);
      await expect(queue.dequeue(false)).resolves.toBeNull();
    });

    it('should handle multiple enqueue/dequeue cycles', async () => {
      // Cycle 1
      await queue.enqueue(createTestEntry(1, 'scope-1'));
      const result1 = await queue.dequeue(false);
      expect(result1?.id).toBe(1);

      // Cycle 2
      await queue.enqueue(createTestEntry(2, 'scope-2'));
      const result2 = await queue.dequeue(false);
      expect(result2?.id).toBe(2);

      // Cycle 3
      await queue.enqueue(createTestEntry(3, 'scope-3'));
      const result3 = await queue.dequeue(false);
      expect(result3?.id).toBe(3);
    });
  });
});

describe('TaskRunQueue - Rolling Deploy Compatibility', () => {
  let queue: TaskRunQueue;
  let redis: InstanceType<typeof Redis>;

  beforeEach(() => {
    const setup = createTestQueue(1);
    queue = setup.queue;
    redis = setup.redis;
  });

  afterEach(async () => {
    await redis.flushall();
  });

  it('uses the shared scope lock to keep delayed work from old v2 consumers', async () => {
    const delayed = {
      ...createTestEntry(43, 'shared-v2-scope'),
      availableAt: Date.now() + 60_000,
    };
    await queue.enqueue(delayed);

    const oldConsumerResult = await redis.eval(
      PREVIOUS_V2_DEQUEUE_SCRIPT,
      4,
      QUEUE_KEY,
      SCOPES_KEY,
      ENTRIES_KEY,
      ENTRY_SCOPES_KEY,
      Math.ceil(TASK_TIMEOUT_MS / 1000).toString(),
    );

    expect(oldConsumerResult).toBeUndefined();
    await expect(redis.llen(QUEUE_KEY)).resolves.toBe(1);
  });

  it('keeps the delay when an old v2 producer replaces the queued entry', async () => {
    const first = {
      ...createTestEntry(44, 'shared-v2-scope'),
      availableAt: Date.now() + 60_000,
    };
    const replacement = createTestEntry(45, first.scope);
    await queue.enqueue(first);

    await expect(
      redis.eval(
        PREVIOUS_V2_ENQUEUE_SCRIPT,
        4,
        QUEUE_KEY,
        SCOPES_KEY,
        ENTRIES_KEY,
        ENTRY_SCOPES_KEY,
        replacement.id.toString(),
        replacement.scope,
        JSON.stringify(replacement),
      ),
    ).resolves.toBe(first.id.toString());

    await expect(queue.dequeue(false)).resolves.toBeNull();
    await expect(redis.llen(QUEUE_KEY)).resolves.toBe(1);

    await redis.del(first.scope);
    await expect(queue.dequeue(false)).resolves.toEqual(replacement);
    await expect(queue.dequeue(false)).resolves.toBeNull();
  });
});

describe('TaskRunQueue - Scope-Based Locking', () => {
  let queue: TaskRunQueue;
  let redis: InstanceType<typeof Redis>;

  beforeEach(() => {
    const setup = createTestQueue(1);
    queue = setup.queue;
    redis = setup.redis;
  });

  afterEach(async () => {
    await redis.flushall();
  });

  describe('lock acquisition', () => {
    it('should successfully dequeue when no lock exists', async () => {
      const entry = createTestEntry(1, 'new-scope');

      await queue.enqueue(entry);
      const dequeued = await queue.dequeue(false);

      expect(dequeued).toEqual(entry);
    });

    it('should acquire lock for dequeued entry', async () => {
      const scope = 'test-scope';

      await queue.enqueue(createTestEntry(1, scope));
      await queue.dequeue(false);

      // Verify lock exists in Redis
      const lockValue = await redis.get(scope);
      expect(lockValue).toBe('1');
    });

    it('should fail to dequeue second entry with same scope', async () => {
      const scope = 'repo:123';

      await queue.enqueue(createTestEntry(1, scope));
      await queue.enqueue(createTestEntry(2, scope)); // Replaces id:1 due to deduplication

      // First dequeue should succeed and acquire lock (gets id:2 since it replaced id:1)
      const first = await queue.dequeue(false);
      expect(first?.id).toBe(2);
      expect(first?.scope).toBe(scope);

      // Second dequeue should return null (no more entries)
      const second = await queue.dequeue(false);
      expect(second).toBeNull();
    });
  });

  describe('lock collision handling', () => {
    it('should re-enqueue entry when lock acquisition fails', async () => {
      const scope = 'locked-scope';

      await queue.enqueue(createTestEntry(1, scope));
      await queue.enqueue(createTestEntry(2, scope)); // Replaces id:1

      // Dequeue first (acquires lock, gets id:2)
      const first = await queue.dequeue(false);
      expect(first?.id).toBe(2);

      // Queue should be empty now
      const queueLength = await redis.llen(QUEUE_KEY);
      expect(queueLength).toBe(0);

      // Attempt to dequeue from empty queue
      const second = await queue.dequeue(false);
      expect(second).toBeNull();
    });

    it('should dequeue second entry after lock is released', async () => {
      const scope = 'repo:123';

      await queue.enqueue(createTestEntry(1, scope));

      // First dequeue should succeed
      const first = await queue.dequeue(false);
      expect(first?.id).toBe(1);

      // Enqueue new entry with same scope while lock is held
      await queue.enqueue(createTestEntry(2, scope));

      // Second dequeue should timeout (lock collision) and re-enqueue
      const second = await queue.dequeue(false);
      expect(second).toBeNull();

      // Release lock
      await queue.releaseLock(scope, 1);

      // Now third dequeue should get the re-enqueued entry
      const third = await queue.dequeue(false);
      expect(third?.id).toBe(2);
    });

    it('should handle multiple entries with same scope', async () => {
      const scope = 'same-scope';

      await queue.enqueue(createTestEntry(1, scope));
      await queue.enqueue(createTestEntry(2, scope)); // Replaces id:1
      await queue.enqueue(createTestEntry(3, scope)); // Replaces id:2

      // Dequeue first (gets id:3, the only entry)
      const first = await queue.dequeue(false);
      expect(first?.id).toBe(3);

      // Next dequeue should return null (queue is empty)
      const second = await queue.dequeue(false);
      expect(second).toBeNull();

      // Release lock
      await queue.releaseLock(scope, 3);

      // Enqueue new entry
      await queue.enqueue(createTestEntry(4, scope));

      // Should get the new entry
      const third = await queue.dequeue(false);
      expect(third?.id).toBe(4);
    });
  });

  describe('concurrent scopes', () => {
    it('should allow concurrent dequeue of different scopes', async () => {
      await queue.enqueue(createTestEntry(1, 'scope-1'));
      await queue.enqueue(createTestEntry(2, 'scope-2'));
      await queue.enqueue(createTestEntry(3, 'scope-3'));

      // All three should be dequeueable immediately since scopes are different
      const first = await queue.dequeue(false);
      const second = await queue.dequeue(false);
      const third = await queue.dequeue(false);

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(third).not.toBeNull();

      const ids = [first?.id, second?.id, third?.id].sort();
      expect(ids).toEqual([1, 2, 3]);
    });

    it('should handle mixed same and different scopes', async () => {
      await queue.enqueue(createTestEntry(1, 'scope-A'));
      await queue.enqueue(createTestEntry(2, 'scope-A')); // Replaces id:1
      await queue.enqueue(createTestEntry(3, 'scope-B'));
      await queue.enqueue(createTestEntry(4, 'scope-B')); // Replaces id:3

      // Should get latest from each scope (id:2 for scope-A, id:4 for scope-B)
      const first = await queue.dequeue(false);
      const second = await queue.dequeue(false);

      expect(first?.id).toBe(2);
      expect(second?.id).toBe(4);

      // Should return null (queue is empty)
      const third = await queue.dequeue(false);
      expect(third).toBeNull();
    });
  });
});

describe('TaskRunQueue - Lock Management', () => {
  let queue: TaskRunQueue;
  let redis: InstanceType<typeof Redis>;

  beforeEach(() => {
    const setup = createTestQueue(1);
    queue = setup.queue;
    redis = setup.redis;
  });

  afterEach(async () => {
    await redis.flushall();
  });

  describe('releaseLock', () => {
    it('should release lock successfully', async () => {
      const scope = 'scope-1';
      const entry = createTestEntry(1, scope);

      await queue.enqueue(entry);
      await queue.dequeue(false); // Acquires lock

      const released = await queue.releaseLock(scope, entry.id);
      expect(released).toBe(true);
    });

    it('should return false for non-existent lock', async () => {
      const released = await queue.releaseLock('non-existent-scope', 1);
      expect(released).toBe(false);
    });

    it('should not release a lock owned by another run', async () => {
      const scope = 'owned-scope';

      await queue.enqueue(createTestEntry(1, scope));
      await queue.dequeue(false);

      expect(await queue.releaseLock(scope, 2)).toBe(false);
      expect(await redis.get(scope)).toBe('1');
    });

    it('should allow re-acquisition after release', async () => {
      const scope = 'reusable-scope';

      // First acquisition
      await queue.enqueue(createTestEntry(1, scope));
      const first = await queue.dequeue(false);
      expect(first?.id).toBe(1);

      // Release
      await queue.releaseLock(scope, 1);

      // Second acquisition should work
      await queue.enqueue(createTestEntry(2, scope));
      const second = await queue.dequeue(false);
      expect(second?.id).toBe(2);
    });

    it('should set lock with correct TTL', async () => {
      const scope = 'ttl-test-scope';

      await queue.enqueue(createTestEntry(1, scope));
      await queue.dequeue(false);

      // Check TTL (should be close to TASK_TIMEOUT_MS / 1000)
      const ttl = await redis.ttl(scope);
      const expectedTtl = Math.ceil(TASK_TIMEOUT_MS / 1000);

      // TTL should be close to expected (allow some variance due to execution time)
      expect(ttl).toBeGreaterThan(expectedTtl - 5);
      expect(ttl).toBeLessThanOrEqual(expectedTtl);
    });
  });
});

describe('TaskRunQueue - Edge Cases', () => {
  let queue: TaskRunQueue;
  let redis: InstanceType<typeof Redis>;

  beforeEach(() => {
    const setup = createTestQueue(1);
    queue = setup.queue;
    redis = setup.redis;
  });

  afterEach(async () => {
    await redis.flushall();
  });

  describe('invalid data handling', () => {
    it('should handle invalid JSON gracefully', async () => {
      // Manually push invalid JSON to Redis
      await redis.rpush(QUEUE_KEY, 'invalid-json{');
      await queue.enqueue(createTestEntry(1, 'valid'));

      // Should skip invalid and return valid
      const result = await queue.dequeue(false);
      expect(result?.id).toBe(1);
    });

    it('should skip entries with missing id', async () => {
      await redis.rpush(QUEUE_KEY, JSON.stringify({ scope: 'missing-id' }));
      await queue.enqueue(createTestEntry(1, 'valid'));

      const result = await queue.dequeue(false);
      expect(result?.id).toBe(1);
    });

    it('should skip entries with missing scope', async () => {
      await redis.rpush(QUEUE_KEY, JSON.stringify({ id: 999 }));
      await queue.enqueue(createTestEntry(1, 'valid'));

      const result = await queue.dequeue(false);
      expect(result?.id).toBe(1);
    });

    it('should handle entries with extra properties', async () => {
      const entryWithExtra = {
        id: 1,
        scope: 'valid-scope',
        extraField: 'should-be-ignored',
        anotherExtra: 123,
      };

      await queue.enqueue(entryWithExtra);

      const result = await queue.dequeue(false);
      expect(result?.id).toBe(1);
      expect(result?.scope).toBe('valid-scope');
    });
  });

  describe('retry behavior', () => {
    it('should detect and skip duplicate entries', async () => {
      const entry = createTestEntry(1, 'scope-1');
      await queue.enqueue(entry);
      // Duplicate the queue pointer while retaining the canonical hashes.
      await redis.rpush(QUEUE_KEY, entry.id.toString());

      // First dequeue should get the entry and acquire lock
      const first = await queue.dequeue(false);
      expect(first?.id).toBe(1);

      // Second dequeue should see duplicate and return null
      const second = await queue.dequeue(false);
      expect(second).toBeNull();
    });

    it('should return null on the second dequeue when all entries have the same locked scope', async () => {
      const scope = 'locked-scope';

      // Create a bunch of entries with the same scope (each replaces the previous)
      for (let i = 0; i < 10; i++) {
        await queue.enqueue(createTestEntry(i, scope));
      }

      // Dequeue first (acquires lock, gets id:9 - the last one enqueued)
      const first = await queue.dequeue(false);
      expect(first?.id).toBe(9);

      // Next dequeue should return null (queue is empty)
      const second = await queue.dequeue(false);
      expect(second).toBeNull();
    });
  });

  describe('data types', () => {
    it('should handle numeric scope values correctly', async () => {
      const entry = createTestEntry(1, '12345');

      await queue.enqueue(entry);
      const result = await queue.dequeue(false);

      expect(result?.scope).toBe('12345');
    });

    it('should handle special characters in scope', async () => {
      const specialScopes = [
        'user/repo:123',
        'org:project-name',
        'scope_with_underscores',
        'scope-with-dashes',
        'scope.with.dots',
        'scope:with:colons',
      ];

      for (let i = 0; i < specialScopes.length; i++) {
        const scope = specialScopes[i];
        if (scope) {
          await queue.enqueue(createTestEntry(i, scope));
        }
      }

      for (let i = 0; i < specialScopes.length; i++) {
        const result = await queue.dequeue(false);
        const expectedScope = specialScopes[i];
        if (expectedScope) {
          expect(result?.scope).toBe(expectedScope);
        }
      }
    });

    it('should handle very long scope strings', async () => {
      const longScope = 'a'.repeat(1000);

      await queue.enqueue(createTestEntry(1, longScope));
      const result = await queue.dequeue(false);

      expect(result?.scope).toBe(longScope);
    });
  });
});

describe('TaskRunQueue - Re-enqueue Behavior', () => {
  let queue: TaskRunQueue;
  let redis: InstanceType<typeof Redis>;

  beforeEach(() => {
    const setup = createTestQueue(1);
    queue = setup.queue;
    redis = setup.redis;
  });

  afterEach(async () => {
    await redis.flushall();
  });

  it('should re-enqueue entry when lock acquisition fails', async () => {
    const scope = 'retry-scope';

    // Enqueue entry
    await queue.enqueue(createTestEntry(1, scope));

    // Dequeue first (acquires lock)
    const first = await queue.dequeue(false);
    expect(first?.id).toBe(1);

    // Enqueue new entry with same scope while lock is held
    await queue.enqueue(createTestEntry(2, scope));

    // Second dequeue should fail (lock held) and re-enqueue the entry
    const second = await queue.dequeue(false);
    expect(second).toBeNull();

    // Verify entry is still in queue
    const queueLength = await redis.llen(QUEUE_KEY);
    expect(queueLength).toBe(1);

    // Release lock and verify we can get the re-enqueued entry
    await queue.releaseLock(scope, 1);
    const third = await queue.dequeue(false);
    expect(third?.id).toBe(2);
  });
});

describe('TaskRunQueue - Scope Deduplication', () => {
  let queue: TaskRunQueue;
  let redis: InstanceType<typeof Redis>;

  beforeEach(() => {
    const setup = createTestQueue(1);
    queue = setup.queue;
    redis = setup.redis;
  });

  afterEach(async () => {
    await redis.flushall();
  });

  describe('basic deduplication', () => {
    it('should replace existing entry with same scope when enqueueing', async () => {
      const scope = 'same-scope';

      // Enqueue first entry
      await queue.enqueue(createTestEntry(1, scope));

      // Enqueue second entry with same scope
      const evicted = await queue.enqueue(createTestEntry(2, scope));

      expect(evicted).toEqual([createTestEntry(1, scope)]);

      // Should only get the latest entry (id: 2)
      const result = await queue.dequeue(false);
      expect(result?.id).toBe(2);
      expect(result?.scope).toBe(scope);

      // Queue should be empty
      const nextResult = await queue.dequeue(false);
      expect(nextResult).toBeNull();
    });

    it('should keep only the latest entry when multiple entries with same scope are enqueued', async () => {
      const scope = 'duplicate-scope';

      // Enqueue multiple entries with the same scope
      await queue.enqueue(createTestEntry(1, scope));
      await queue.enqueue(createTestEntry(2, scope));
      await queue.enqueue(createTestEntry(3, scope));

      // Should only have one entry (the latest one)
      const queueLength = await redis.llen(QUEUE_KEY);
      expect(queueLength).toBe(1);

      // Should get the latest entry
      const result = await queue.dequeue(false);
      expect(result?.id).toBe(3);
    });

    it('atomically keeps one winner across concurrent producers', async () => {
      const scope = 'concurrent-scope';

      await Promise.all(
        Array.from({ length: 25 }, (_, index) =>
          queue.enqueue(createTestEntry(index + 1, scope)),
        ),
      );

      expect(await redis.llen(QUEUE_KEY)).toBe(1);
      expect((await queue.dequeue(false))?.scope).toBe(scope);
      expect(await queue.dequeue(false)).toBeNull();
    });

    it('should preserve entries with different scopes', async () => {
      // Enqueue entries with different scopes
      await queue.enqueue(createTestEntry(1, 'scope-A'));
      await queue.enqueue(createTestEntry(2, 'scope-B'));
      await queue.enqueue(createTestEntry(3, 'scope-C'));

      // All three should be preserved
      const queueLength = await redis.llen(QUEUE_KEY);
      expect(queueLength).toBe(3);

      // Should dequeue in FIFO order
      const first = await queue.dequeue(false);
      const second = await queue.dequeue(false);
      const third = await queue.dequeue(false);

      expect(first?.id).toBe(1);
      expect(second?.id).toBe(2);
      expect(third?.id).toBe(3);
    });
  });

  describe('mixed scopes', () => {
    it('should handle mix of duplicate and unique scopes', async () => {
      await queue.enqueue(createTestEntry(1, 'scope-A'));
      await queue.enqueue(createTestEntry(2, 'scope-B'));
      await queue.enqueue(createTestEntry(3, 'scope-A')); // Replaces id: 1
      await queue.enqueue(createTestEntry(4, 'scope-C'));
      await queue.enqueue(createTestEntry(5, 'scope-B')); // Replaces id: 2

      // Should have 3 entries (scope-A: 3, scope-C: 4, scope-B: 5)
      const queueLength = await redis.llen(QUEUE_KEY);
      expect(queueLength).toBe(3);

      // Dequeue all and verify we get the latest for each scope
      const results = [];
      for (let i = 0; i < 3; i++) {
        const result = await queue.dequeue(false);
        if (result) {
          results.push(result);
        }
      }

      // Should have entries with ids 3, 4, 5
      const ids = results.map((r) => r.id).sort();
      expect(ids).toEqual([3, 4, 5]);
    });

    it('should maintain FIFO order for entries with different scopes after deduplication', async () => {
      await queue.enqueue(createTestEntry(1, 'scope-A'));
      await queue.enqueue(createTestEntry(2, 'scope-B'));
      await queue.enqueue(createTestEntry(3, 'scope-C'));
      await queue.enqueue(createTestEntry(4, 'scope-B')); // Replaces scope-B

      // Should dequeue in order: scope-A (1), scope-C (3), scope-B (4)
      const first = await queue.dequeue(false);
      const second = await queue.dequeue(false);
      const third = await queue.dequeue(false);

      expect(first?.id).toBe(1);
      expect(first?.scope).toBe('scope-A');
      expect(second?.id).toBe(3);
      expect(second?.scope).toBe('scope-C');
      expect(third?.id).toBe(4);
      expect(third?.scope).toBe('scope-B');
    });
  });

  describe('deduplication with locking', () => {
    it('should deduplicate even when lock is held', async () => {
      const scope = 'locked-scope';

      // Enqueue and dequeue to acquire lock
      await queue.enqueue(createTestEntry(1, scope));
      const first = await queue.dequeue(false);
      expect(first?.id).toBe(1);

      // Enqueue new entry with same scope (should replace any existing)
      await queue.enqueue(createTestEntry(2, scope));

      // Verify only one entry in queue
      const queueLength = await redis.llen(QUEUE_KEY);
      expect(queueLength).toBe(1);

      // Release lock
      await queue.releaseLock(scope, 1);

      // Should get the new entry
      const result = await queue.dequeue(false);
      expect(result?.id).toBe(2);
    });

    it('should handle deduplication during re-enqueue', async () => {
      const scope = 'test-scope';

      // Enqueue two entries with same scope
      await queue.enqueue(createTestEntry(1, scope));
      await queue.enqueue(createTestEntry(2, scope)); // Only id:2 should remain

      // Dequeue first (gets lock)
      const first = await queue.dequeue(false);
      expect(first?.id).toBe(2);

      // Try to dequeue again (will fail and re-enqueue)
      const second = await queue.dequeue(false);
      expect(second).toBeNull();

      // Enqueue a newer entry with same scope
      await queue.enqueue(createTestEntry(3, scope)); // Should replace re-enqueued entry

      // Release lock
      await queue.releaseLock(scope, 2);

      // Should get the newest entry (id: 3)
      const third = await queue.dequeue(false);
      expect(third?.id).toBe(3);
    });
  });

  describe('edge cases', () => {
    it('should handle deduplication with invalid entries in queue', async () => {
      const scope = 'valid-scope';

      // Add invalid entry
      await redis.rpush(QUEUE_KEY, 'invalid-json');

      // Add valid entry
      await queue.enqueue(createTestEntry(1, scope));

      // Add another valid entry with same scope
      await queue.enqueue(createTestEntry(2, scope));

      // Invalid entry should be preserved, only id:2 should remain for the scope
      const queueLength = await redis.llen(QUEUE_KEY);
      expect(queueLength).toBe(2);

      // Dequeue should skip invalid and get valid entry
      const result = await queue.dequeue(false);
      expect(result?.id).toBe(2);
    });

    it('should handle empty queue deduplication', async () => {
      // Enqueue into empty queue
      await queue.enqueue(createTestEntry(1, 'scope-1'));

      const queueLength = await redis.llen(QUEUE_KEY);
      expect(queueLength).toBe(1);

      const result = await queue.dequeue(false);
      expect(result?.id).toBe(1);
    });

    it('should handle deduplication with special character scopes', async () => {
      const scope = 'repo/name:pr-123';

      await queue.enqueue(createTestEntry(1, scope));
      await queue.enqueue(createTestEntry(2, scope));

      const result = await queue.dequeue(false);
      expect(result?.id).toBe(2);
      expect(result?.scope).toBe(scope);

      const nextResult = await queue.dequeue(false);
      expect(nextResult).toBeNull();
    });
  });
});
