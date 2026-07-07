import { db, deploymentSettings, eq } from '@roomote/db/server';

import { bootstrapWebRuntimeEnv } from './bootstrap-runtime-env';

const DEFAULT_DEPLOYMENT_ID = 'default';

export async function isSetupBootstrapOpen(): Promise<boolean> {
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return false;
  }

  await bootstrapWebRuntimeEnv();

  const deployment = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: {
      setupCompletedAt: true,
    },
  });

  return deployment?.setupCompletedAt == null;
}
