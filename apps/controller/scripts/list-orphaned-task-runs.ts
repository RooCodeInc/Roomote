// npx dotenvx run -f ../../.env.local -- tsx scripts/list-orphaned-task-runs.ts

// Read-only snapshot of the oldest 100 candidates; recovery belongs to the controller.
import { listOrphanedTaskRuns } from '../src/orphaned-task-runs';

async function main(): Promise<void> {
  console.log(JSON.stringify(await listOrphanedTaskRuns(), null, 2));
  process.exit(0);
}

main();
