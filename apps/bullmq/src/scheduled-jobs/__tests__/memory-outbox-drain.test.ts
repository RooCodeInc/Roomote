import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  drainMemoryOutboxBatch,
  type MemoryOutboxOperations,
} from '../memory-outbox-drain';

type Event = { id: string; revision: number; attempts: number };
type Page = { slug: string };

const event = { id: 'event-1', revision: 3, attempts: 1 };
const page = { slug: 'memories/one' };

function createOperations(
  overrides: Partial<MemoryOutboxOperations<Event, Page>> = {},
): MemoryOutboxOperations<Event, Page> {
  return {
    claim: vi.fn(async () => [event]),
    prepare: vi.fn(async () => ({
      page,
      settledMessage: 'settled',
      supersededMessage: 'superseded',
    })),
    write: vi.fn(async () => undefined),
    mark: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    settle: vi.fn(async () => 'settled' as const),
    classifyBackpressure: vi.fn(() => null),
    onSettled: vi.fn(),
    onBackpressure: vi.fn(),
    onFailure: vi.fn(),
    ...overrides,
  };
}

describe('shared memory outbox drain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes and revision-fences successful settlement', async () => {
    const operations = createOperations();

    await expect(drainMemoryOutboxBatch(operations, 5)).resolves.toBe(true);

    expect(operations.write).toHaveBeenCalledWith(page);
    expect(operations.settle).toHaveBeenCalledWith('event-1', 3, 'done');
    expect(operations.onSettled).toHaveBeenCalledWith(
      expect.objectContaining({ page }),
      'settled',
    );
  });

  it.each(['rate-limited', 'not-ready'] as const)(
    'refunds the whole remaining batch on %s backpressure',
    async (backpressure) => {
      const error = new Error(backpressure);
      const second = { ...event, id: 'event-2' };
      const operations = createOperations({
        claim: vi.fn(async () => [event, second]),
        write: vi.fn(async () => {
          throw error;
        }),
        classifyBackpressure: vi.fn((candidate) =>
          candidate === error ? backpressure : null,
        ),
      });

      await expect(drainMemoryOutboxBatch(operations, 5)).resolves.toBe(false);

      expect(operations.mark).toHaveBeenCalledWith(
        'event-1',
        'pending',
        backpressure,
      );
      expect(operations.release).toHaveBeenCalledWith(['event-1', 'event-2']);
      expect(operations.prepare).toHaveBeenCalledTimes(1);
      expect(operations.onBackpressure).toHaveBeenCalledWith(backpressure);
    },
  );

  it('requeues an ordinary failure while attempts remain', async () => {
    const operations = createOperations({
      write: vi.fn(async () => {
        throw new Error('transient');
      }),
    });

    await drainMemoryOutboxBatch(operations, 5);

    expect(operations.mark).toHaveBeenCalledWith(
      'event-1',
      'pending',
      'transient',
    );
    expect(operations.settle).not.toHaveBeenCalled();
    expect(operations.onFailure).toHaveBeenCalledWith(
      event,
      false,
      'transient',
    );
  });

  it('settles an exhausted ordinary failure as terminal', async () => {
    const exhausted = { ...event, attempts: 5 };
    const operations = createOperations({
      claim: vi.fn(async () => [exhausted]),
      write: vi.fn(async () => {
        throw new Error('poison row');
      }),
    });

    await drainMemoryOutboxBatch(operations, 5);

    expect(operations.settle).toHaveBeenCalledWith(
      'event-1',
      3,
      'failed',
      'poison row',
    );
    expect(operations.mark).not.toHaveBeenCalled();
    expect(operations.onFailure).toHaveBeenCalledWith(
      exhausted,
      true,
      'poison row',
    );
  });
});
