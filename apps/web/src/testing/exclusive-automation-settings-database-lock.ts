import { db, sql } from '@roomote/db/server';

const AUTOMATION_SETTINGS_TEST_LOCK = [20260910, 2451] as const;
const EXCLUSIVE_LOCK_HOOK_TIMEOUT_MS = 60_000;

/** Serializes suites that replace deployment-wide automation settings rows. */
export function registerExclusiveAutomationSettingsDatabaseLock() {
  let releaseLock: (() => void) | undefined;
  let lockTransaction: Promise<void> | undefined;

  beforeAll(async () => {
    let markAcquired: (() => void) | undefined;
    let rejectAcquired: ((error: unknown) => void) | undefined;
    const acquired = new Promise<void>((resolve, reject) => {
      markAcquired = resolve;
      rejectAcquired = reject;
    });
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    lockTransaction = db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${AUTOMATION_SETTINGS_TEST_LOCK[0]}, ${AUTOMATION_SETTINGS_TEST_LOCK[1]})`,
      );
      markAcquired?.();
      await released;
    });
    void lockTransaction.catch((error) => rejectAcquired?.(error));
    await acquired;
  }, EXCLUSIVE_LOCK_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    releaseLock?.();
    await lockTransaction;
  }, EXCLUSIVE_LOCK_HOOK_TIMEOUT_MS);
}
