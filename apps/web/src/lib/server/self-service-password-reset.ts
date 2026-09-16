import { createHash } from 'node:crypto';

import { resolveAgentMailRuntimeCredentials } from '@roomote/db/server';
import { getRedis } from '@roomote/redis';

import { isEmailChannelEnabled } from './env';
import { bootstrapWebRuntimeEnv } from './bootstrap-runtime-env';

const EMAIL_WINDOW_SECONDS = 60 * 60;
const EMAIL_MAX_ATTEMPTS = 3;
const CLIENT_WINDOW_SECONDS = 60 * 60;
const CLIENT_MAX_ATTEMPTS = 20;
const GLOBAL_WINDOW_SECONDS = 60;
const GLOBAL_MAX_ATTEMPTS = 100;

const RATE_LIMIT_SCRIPT = `local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count`;

function hashRateLimitValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function incrementRateLimit(key: string, windowSeconds: number) {
  return Number(
    await getRedis().eval(RATE_LIMIT_SCRIPT, 1, key, String(windowSeconds)),
  );
}

export async function isSelfServicePasswordResetAvailable(): Promise<boolean> {
  await bootstrapWebRuntimeEnv();
  if (!isEmailChannelEnabled()) {
    return false;
  }

  const credentials = await resolveAgentMailRuntimeCredentials();
  return Boolean(credentials.apiKey && credentials.inboxId);
}

export async function isSelfServicePasswordResetAllowed(input: {
  email: string;
  clientAddress: string | null;
}): Promise<boolean> {
  const normalizedEmail = input.email.trim().toLowerCase();
  const limits = await Promise.all([
    incrementRateLimit(
      `password-reset:email:${hashRateLimitValue(normalizedEmail)}`,
      EMAIL_WINDOW_SECONDS,
    ).then((count) => count <= EMAIL_MAX_ATTEMPTS),
    incrementRateLimit('password-reset:global', GLOBAL_WINDOW_SECONDS).then(
      (count) => count <= GLOBAL_MAX_ATTEMPTS,
    ),
    incrementRateLimit(
      `password-reset:client:${hashRateLimitValue(input.clientAddress ?? 'unknown')}`,
      CLIENT_WINDOW_SECONDS,
    ).then((count) => count <= CLIENT_MAX_ATTEMPTS),
  ]);

  return limits.every(Boolean);
}
