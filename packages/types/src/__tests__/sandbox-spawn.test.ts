import {
  ORPHANED_AFTER_DEQUEUE_THRESHOLD_MS,
  SANDBOX_ORPHAN_SCAN_INTERVAL_MS,
  SANDBOX_SPAWN_MAX_DURATION_MS,
  STUCK_AFTER_DEQUEUE_THRESHOLD_MS,
  STUCK_AFTER_DEQUEUE_THRESHOLD_MINUTES,
} from '../sandbox-spawn';

describe('sandbox spawn timing budgets', () => {
  it('keeps orphan recovery behind the worst-case bounded spawn duration', () => {
    expect(ORPHANED_AFTER_DEQUEUE_THRESHOLD_MS).toBe(
      SANDBOX_SPAWN_MAX_DURATION_MS + SANDBOX_ORPHAN_SCAN_INTERVAL_MS,
    );
  });

  it('keeps the health check behind orphan recovery', () => {
    expect(STUCK_AFTER_DEQUEUE_THRESHOLD_MS).toBe(
      ORPHANED_AFTER_DEQUEUE_THRESHOLD_MS + SANDBOX_ORPHAN_SCAN_INTERVAL_MS,
    );
    expect(STUCK_AFTER_DEQUEUE_THRESHOLD_MINUTES).toBe(
      Math.ceil(STUCK_AFTER_DEQUEUE_THRESHOLD_MS / 60_000),
    );
  });
});
