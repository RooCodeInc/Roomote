// pnpm --silent --filter @roomote/auth development:create-job-token 123 [timeoutMs]

import { db, taskRuns, eq } from '@roomote/db/server';

import { createJobToken } from '../src';

async function main() {
  if (process.argv.length < 3) {
    console.error(
      'Usage: pnpm --silent --filter @roomote/auth development:create-job-token <cloud-job-id> [timeoutMs]',
    );

    process.exit(1);
  }

  const cloudJobId = parseInt(process.argv[2]!);

  if (isNaN(cloudJobId) || cloudJobId <= 0) {
    console.error('Invalid cloud job id: must be a positive number');
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
    where: eq(taskRuns.id, cloudJobId),
  });

  if (!taskRun) {
    console.error('Task run not found: ', cloudJobId);
    process.exit(1);
  }

  // A null acting user mints a deployment-service-principal token for
  // automation-initiated runs with no human driver.
  const token = await createJobToken({
    cloudJobId: taskRun.id,
    userId: taskRun.actingUserId,
    timeoutMs,
  });

  console.log(token);
}

main().then(() => process.exit(0));
