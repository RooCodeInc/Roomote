import { mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK_DIRECTORY = join(
  tmpdir(),
  'roomote-web-automation-settings-tests.lock',
);
const STALE_LOCK_MS = 5 * 60 * 1000;

/** Serializes suites that replace deployment-wide automation settings rows. */
export function useExclusiveAutomationSettingsDatabaseLock() {
  beforeAll(async () => {
    for (let attempt = 0; attempt < 3_000; attempt += 1) {
      try {
        await mkdir(LOCK_DIRECTORY);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

        const lockStat = await stat(LOCK_DIRECTORY).catch(() => null);
        if (lockStat && Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
          await rm(LOCK_DIRECTORY, { recursive: true, force: true });
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    throw new Error('Timed out waiting for the automation settings test lock.');
  });

  afterAll(async () => {
    await rm(LOCK_DIRECTORY, { recursive: true, force: true });
  });
}
