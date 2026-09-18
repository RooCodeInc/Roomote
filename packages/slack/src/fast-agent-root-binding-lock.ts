import { acquireRedisLock } from '@roomote/redis';

const LOCK_TTL_SECONDS = 30;
const LOCK_ATTEMPTS = 200;
const LOCK_RETRY_MS = 25;
const LOCK_PREFIX = 'fast-agent:slack-root-binding:';

export async function acquireSlackFastRootBindingLock(params: {
  teamId: string;
  channelId: string;
}) {
  const key = `${LOCK_PREFIX}${params.teamId}:${params.channelId}`;

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    const release = await acquireRedisLock(key, {
      ttlSeconds: LOCK_TTL_SECONDS,
    });
    if (release) {
      return release;
    }
    if (attempt + 1 < LOCK_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }

  throw new Error('Timed out waiting for Slack automation root binding.');
}
