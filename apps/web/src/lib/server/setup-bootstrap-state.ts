import { db, deploymentSettings, eq } from '@roomote/db/server';

export async function getSetupBootstrapState(): Promise<{
  setupOpen: boolean;
}> {
  const [deployment] = await db
    .select({
      setupCompletedAt: deploymentSettings.setupCompletedAt,
    })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, 'default'))
    .limit(1);

  return {
    setupOpen: deployment?.setupCompletedAt == null,
  };
}
