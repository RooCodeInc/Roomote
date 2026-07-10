// npx dotenvx run -f ../../.env.local -- tsx scripts/list-orphaned-task-runs.ts

import { getOrphanedTaskRun } from '../src/orphaned-task-runs';

async function main(): Promise<void> {
  console.log(await getOrphanedTaskRun());
  process.exit(0);
}

main();
