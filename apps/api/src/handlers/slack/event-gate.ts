import { randomUUID } from 'node:crypto';

import { getRedis } from '@roomote/redis';

import {
  EVENT_DEDUP_TTL_SECONDS,
  SLACK_EVENT_DEDUP_PREFIX,
} from './constants.js';

const COMPLETE_EVENT_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return false
end
redis.call('SET', KEYS[1], 'done', 'EX', ARGV[2])
return true
`;

const RELEASE_EVENT_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return false
end
return redis.call('DEL', KEYS[1])
`;

export type SlackEventClaim = {
  key: string;
  token: string;
};

export async function claimSlackEvent(
  eventId: string,
): Promise<SlackEventClaim | null> {
  const key = `${SLACK_EVENT_DEDUP_PREFIX}${eventId}`;
  const token = `processing:${randomUUID()}`;
  const claimed = await getRedis().set(
    key,
    token,
    'EX',
    EVENT_DEDUP_TTL_SECONDS,
    'NX',
  );

  return claimed ? { key, token } : null;
}

export async function completeSlackEventClaim(
  claim: SlackEventClaim,
): Promise<boolean> {
  const completed = await getRedis().eval(
    COMPLETE_EVENT_SCRIPT,
    1,
    claim.key,
    claim.token,
    EVENT_DEDUP_TTL_SECONDS.toString(),
  );

  return completed === 1;
}

export async function releaseSlackEventClaim(
  claim: SlackEventClaim,
): Promise<boolean> {
  const released = await getRedis().eval(
    RELEASE_EVENT_SCRIPT,
    1,
    claim.key,
    claim.token,
  );

  return released === 1;
}
