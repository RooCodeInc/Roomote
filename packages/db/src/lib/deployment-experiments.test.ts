import { eq, sql } from 'drizzle-orm';

import { db } from '../db';
import { deploymentSettings } from '../schema';

import {
  getDeploymentExperiments,
  setDeploymentExperimentEnabled,
} from './deployment-experiments';

describe('deployment experiments', () => {
  it('stores one flag without replacing unrelated deployment metadata', async () => {
    await setDeploymentExperimentEnabled('privateSessions', false);
    await db
      .update(deploymentSettings)
      .set({
        metadata: sql`${deploymentSettings.metadata} || '{"preserved":true,"results_page_enabled":true}'::jsonb`,
      })
      .where(eq(deploymentSettings.id, 'default'));
    await setDeploymentExperimentEnabled('privateSessions', true);

    await expect(getDeploymentExperiments()).resolves.toMatchObject({
      privateSessions: true,
    });
    await expect(
      db.query.deploymentSettings.findFirst({
        where: eq(deploymentSettings.id, 'default'),
        columns: { metadata: true },
      }),
    ).resolves.toMatchObject({
      metadata: {
        preserved: true,
        results_page_enabled: true,
        private_sessions_experiment_enabled: true,
      },
    });
  });
});
