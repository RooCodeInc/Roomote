import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK_DIRECTORY = join(
  tmpdir(),
  'roomote-web-automation-settings-tests.lock',
);
const OWNER_FILE = join(LOCK_DIRECTORY, 'owner');
const RETRY_INTERVAL_MS = 10;
const STALE_LOCK_MS = 15_000;
const MAX_ATTEMPTS = 3_000;

/** Serializes suites that replace deployment-wide automation settings rows. */
export function registerExclusiveAutomationSettingsDatabaseLock() {
  const owner = randomUUID();
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  beforeAll(async () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        await mkdir(LOCK_DIRECTORY);
        await writeFile(OWNER_FILE, owner);
        heartbeat = setInterval(() => {
          void readFile(OWNER_FILE, 'utf8')
            .then((currentOwner) => {
              if (currentOwner !== owner) return;
              const now = new Date();
              return utimes(LOCK_DIRECTORY, now, now);
            })
            .catch(() => undefined);
        }, STALE_LOCK_MS / 3);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

        const lockStat = await stat(LOCK_DIRECTORY).catch(() => null);
        if (lockStat && Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
          await rm(LOCK_DIRECTORY, { recursive: true, force: true });
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
      }
    }

    throw new Error('Timed out waiting for the automation settings test lock.');
  });

  afterAll(async () => {
    if (heartbeat) clearInterval(heartbeat);
    const currentOwner = await readFile(OWNER_FILE, 'utf8').catch(() => null);
    if (currentOwner === owner) {
      await rm(LOCK_DIRECTORY, { recursive: true, force: true });
    }
  });
}
