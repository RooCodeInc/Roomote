import { and, db, deploymentSettings, eq, isNull } from '@roomote/db/server';

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

/** Atomically consumes the one-time pre-verified email bootstrap claim. */
export async function claimPreVerifiedEmailBootstrap(
  deploymentId = DEFAULT_DEPLOYMENT_ID,
): Promise<boolean> {
  const now = new Date();
  const claimed = await db
    .insert(deploymentSettings)
    .values({ id: deploymentId, preVerifiedEmailClaimedAt: now })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: { preVerifiedEmailClaimedAt: now, updatedAt: now },
      setWhere: and(
        isNull(deploymentSettings.setupCompletedAt),
        isNull(deploymentSettings.preVerifiedEmailClaimedAt),
      ),
    })
    .returning({ id: deploymentSettings.id });

  return claimed.length > 0;
}
