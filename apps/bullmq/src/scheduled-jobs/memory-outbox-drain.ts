export type MemoryOutboxEvent = {
  id: string;
  revision: number;
  attempts: number;
};

export type PreparedMemoryPage<TPage> = {
  page: TPage;
  settledMessage: string;
  supersededMessage: string;
};

export type MemoryOutboxOperations<TEvent extends MemoryOutboxEvent, TPage> = {
  claim: () => Promise<TEvent[]>;
  prepare: (event: TEvent) => Promise<PreparedMemoryPage<TPage> | null>;
  write: (page: TPage) => Promise<void>;
  mark: (
    id: string,
    status: 'pending' | 'skipped',
    lastError?: string,
  ) => Promise<void>;
  release: (ids: string[]) => Promise<void>;
  settle: (
    id: string,
    revision: number,
    outcome: 'done' | 'failed',
    lastError?: string,
  ) => Promise<'settled' | 'superseded'>;
  classifyBackpressure: (error: unknown) => 'rate-limited' | 'not-ready' | null;
  onSettled: (
    prepared: PreparedMemoryPage<TPage>,
    result: 'settled' | 'superseded',
  ) => void;
  onBackpressure: (kind: 'rate-limited' | 'not-ready') => void;
  onFailure: (event: TEvent, terminal: boolean, message: string) => void;
};

/**
 * Drain one revision-fenced memory outbox batch. Lookup and page construction
 * stay domain-owned; settlement, retry budgets, and backpressure are shared.
 */
export async function drainMemoryOutboxBatch<
  TEvent extends MemoryOutboxEvent,
  TPage,
>(
  operations: MemoryOutboxOperations<TEvent, TPage>,
  maxAttempts: number,
): Promise<boolean> {
  const events = await operations.claim();

  if (events.length === 0) {
    return false;
  }

  for (const [index, event] of events.entries()) {
    try {
      const prepared = await operations.prepare(event);

      if (!prepared) {
        continue;
      }

      await operations.write(prepared.page);
      const result = await operations.settle(event.id, event.revision, 'done');
      operations.onSettled(prepared, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const backpressure = operations.classifyBackpressure(error);

      if (backpressure) {
        await operations.mark(event.id, 'pending', message);
        await operations.release([
          event.id,
          ...events.slice(index + 1).map((pending) => pending.id),
        ]);
        operations.onBackpressure(backpressure);
        return false;
      }

      const terminal = event.attempts >= maxAttempts;

      if (terminal) {
        await operations.settle(event.id, event.revision, 'failed', message);
      } else {
        await operations.mark(event.id, 'pending', message);
      }

      operations.onFailure(event, terminal, message);
    }
  }

  return true;
}
