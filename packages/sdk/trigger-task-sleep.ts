/**
 * Local demo trigger: gracefully sleeps a task run (snapshot + stop) so the
 * wake-from-sleep paths can be tested without waiting out the keepalive.
 * Untracked; delete after the demo.
 *
 * Usage:
 *   pnpm exec dotenvx run -f ../../.env.local -- pnpm exec tsx trigger-task-sleep.ts <runId>
 */
import { enqueueTaskSleep } from './src/server';

const runId = Number(process.argv[2]);

if (!Number.isFinite(runId)) {
  console.error('Usage: tsx trigger-task-sleep.ts <runId>');
  process.exit(1);
}

enqueueTaskSleep({ runId })
  .then((enqueued) => {
    console.log('sleep enqueued:', enqueued);
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
