// pnpm --silent --filter @roomote/auth development:create-job-token 123 [timeoutMs]

import { db, cloudJobs, eq } from '@roomote/db/server';

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

  const cloudJob = await db.query.cloudJobs.findFirst({
    where: eq(cloudJobs.id, cloudJobId),
  });

  if (!cloudJob) {
    console.error('Cloud job not found: ', cloudJobId);
    process.exit(1);
  }

  const userId = cloudJob.userId;

  if (!userId) {
    console.error('Cloud job has no associated user: ', cloudJobId);
    process.exit(1);
  }

  const token = await createJobToken({
    cloudJobId: cloudJob.id,
    userId,
    timeoutMs,
  });

  console.log(token);
}

main().then(() => process.exit(0));
