import type { Queue } from 'bullmq';

const SCHEDULER_PAGE_SIZE = 100;

/**
 * bullmq keeps an `every` scheduler's stored offset when its interval changes,
 * and adds that whole offset when it catches up on missed iterations. A
 * scheduler that once ran hourly and now runs every minute therefore keeps
 * firing about once an hour: the heartbeat goes stale between runs and
 * per-minute work runs late.
 *
 * Removes every scheduler whose offset is not smaller than its interval so the
 * upserts that follow re-create it with a fresh offset. Returns the removed
 * scheduler keys.
 */
export async function removeSchedulersWithStaleOffsets(
  queue: Pick<Queue, 'getJobSchedulers' | 'removeJobScheduler'>,
): Promise<string[]> {
  const removed: string[] = [];

  for (let start = 0; ; start += SCHEDULER_PAGE_SIZE) {
    const page = await queue.getJobSchedulers(
      start,
      start + SCHEDULER_PAGE_SIZE - 1,
      true,
    );

    for (const scheduler of page) {
      const every = Number(scheduler.every);
      const offset = Number(scheduler.offset);

      if (every > 0 && Number.isFinite(offset) && offset >= every) {
        await queue.removeJobScheduler(scheduler.key);
        removed.push(scheduler.key);
      }
    }

    if (page.length < SCHEDULER_PAGE_SIZE) {
      return removed;
    }
  }
}
