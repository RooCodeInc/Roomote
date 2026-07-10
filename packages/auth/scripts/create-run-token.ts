// pnpm --silent --filter @roomote/auth development:create-run-token 123 [timeoutMs]

import { db, taskRuns, eq } from '@roomote/db/server';

import { createRunToken } from '../src';

async function main() {
  if (process.argv.length < 3) {
    console.error(
      'Usage: pnpm --silent --filter @roomote/auth development:create-run-token <task-run-id> [timeoutMs]',
    );

    process.exit(1);
  }

  const runId = parseInt(process.argv[2]!);

  if (isNaN(runId) || runId <= 0) {
    console.error('Invalid task run id: must be a positive number');
    process.exit(1);
  }

  let timeoutMs = 3600;

  if (process.argv[3]) {
    timeoutMs = parseInt(process.argv[3]);

    if (isNaN(timeoutMs) || timeoutMs <= 0) {
      console.error('Invalid timeout: must be a positive number');
      process.exit(1);
    }
  }

  const taskRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
  });

  if (!taskRun) {
    console.error('Task run not found: ', runId);
    process.exit(1);
  }

  // A null acting user mints a deployment-service-principal token for
  // automation-initiated runs with no human driver.
  const token = await createRunToken({
    runId: taskRun.id,
    userId: taskRun.actingUserId,
    timeoutMs,
  });

  console.log(token);
}

main().then(() => process.exit(0));
