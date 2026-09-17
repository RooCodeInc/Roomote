import { randomUUID } from 'node:crypto';

import { getRedis } from '@roomote/redis';

import {
  EVENT_DEDUP_TTL_SECONDS,
  SLACK_EVENT_DEDUP_PREFIX,
} from './constants.js';

const SLACK_EVENT_PROCESSING_TTL_SECONDS = 30;

export const slackEventLeaseRenewal = {
  intervalMs: 10 * 1000,
  maxDurationMs: 3 * 60 * 1000,
};

const CLAIM_EVENT_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing == 'done' then
  return 'completed'
end
if existing then
  return 'processing'
end
local stored = redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX')
if stored then
  return 'claimed'
end
existing = redis.call('GET', KEYS[1])
if existing == 'done' then
  return 'completed'
end
return 'processing'
`;

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

const RENEW_EVENT_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return false
end
return redis.call('EXPIRE', KEYS[1], ARGV[2])
`;

export type SlackEventClaim = {
  key: string;
  token: string;
};

type SlackEventClaimResult =
  | { status: 'claimed'; claim: SlackEventClaim }
  | { status: 'processing' }
  | { status: 'completed' };

export async function claimSlackEvent(
  eventId: string,
): Promise<SlackEventClaimResult> {
  const key = `${SLACK_EVENT_DEDUP_PREFIX}${eventId}`;
  const token = `processing:${randomUUID()}`;
  const result = await getRedis().eval(
    CLAIM_EVENT_SCRIPT,
    1,
    key,
    token,
    SLACK_EVENT_PROCESSING_TTL_SECONDS.toString(),
  );

  if (result === 'claimed') {
    return { status: 'claimed', claim: { key, token } };
  }
  if (result === 'completed') {
    return { status: 'completed' };
  }
  return { status: 'processing' };
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

export async function renewSlackEventClaim(
  claim: SlackEventClaim,
): Promise<boolean> {
  const renewed = await getRedis().eval(
    RENEW_EVENT_SCRIPT,
    1,
    claim.key,
    claim.token,
    SLACK_EVENT_PROCESSING_TTL_SECONDS.toString(),
  );

  return renewed === 1;
}
