import { db, sql } from '@roomote/db/server';

const AUTOMATION_SETTINGS_TEST_LOCK = [20260910, 2451] as const;

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
  });

  afterAll(async () => {
    releaseLock?.();
    await lockTransaction;
  });
}
