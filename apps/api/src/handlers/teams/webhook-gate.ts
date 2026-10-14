import { randomUUID } from 'node:crypto';

import { getRedis } from '@roomote/redis';

const TEAMS_ACTIVITY_DEDUP_PREFIX = 'teams:activity:';
const TEAMS_ACTIVITY_DEDUP_TTL_SECONDS = 5 * 60;
const RELEASE_OWNED_ACTIVITY_CLAIM = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export type TeamsActivityClaim = { activityId: string; owner: string };

export async function claimTeamsActivity(
  activityId: string,
): Promise<TeamsActivityClaim | null> {
  const owner = randomUUID();
  const claimed = await getRedis().set(
    `${TEAMS_ACTIVITY_DEDUP_PREFIX}${activityId}`,
    owner,
    'EX',
    TEAMS_ACTIVITY_DEDUP_TTL_SECONDS,
    'NX',
  );
  return claimed ? { activityId, owner } : null;
}

export async function releaseTeamsActivityClaim(
  claim: TeamsActivityClaim,
): Promise<void> {
  await getRedis().eval(
    RELEASE_OWNED_ACTIVITY_CLAIM,
    1,
    `${TEAMS_ACTIVITY_DEDUP_PREFIX}${claim.activityId}`,
    claim.owner,
  );
}
