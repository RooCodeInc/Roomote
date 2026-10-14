import { getRedis } from '@roomote/redis';

import { claimTeamsActivity } from '../webhook-gate';

try {
  const claim = await claimTeamsActivity(process.argv[2]!);
  console.log(JSON.stringify({ claimed: claim !== null }));
} finally {
  await getRedis().quit();
}
