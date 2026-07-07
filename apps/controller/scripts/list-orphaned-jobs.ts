// npx dotenvx run -f ../../.env.local -- tsx scripts/list-orphaned-jobs.ts

import { getOrphanedJob } from '../src/orphaned-cloud-jobs';

async function main(): Promise<void> {
  console.log(await getOrphanedJob());
  process.exit(0);
}

main();
