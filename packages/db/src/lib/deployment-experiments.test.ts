import { rehydrateEnv } from '@roomote/env';
import { eq, sql } from 'drizzle-orm';

import { getDeploymentExperimentAudience } from '@roomote/feature-flags';

import { db } from '../db';
import { deploymentSettings } from '../schema';

import {
  getDeploymentExperiments,
  isDeploymentExperimentEnabled,
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

  it('treats internal-nightly experiments as disabled without the deployment opt-in', async () => {
    const database = {
      query: {
        deploymentSettings: {
          findFirst: vi.fn().mockResolvedValue({
            metadata: { automation_launch_criteria_experiment_enabled: true },
          }),
        },
      },
    } as never;

    try {
      vi.stubEnv('R_NIGHTLY_EXPERIMENTS_ENABLED', 'false');
      rehydrateEnv();
      expect(getDeploymentExperimentAudience('automationLaunchCriteria')).toBe(
        'internal-nightly',
      );
      await expect(
        isDeploymentExperimentEnabled('automationLaunchCriteria', database),
      ).resolves.toBe(false);

      vi.stubEnv('R_NIGHTLY_EXPERIMENTS_ENABLED', 'true');
      rehydrateEnv();
      await expect(
        isDeploymentExperimentEnabled('automationLaunchCriteria', database),
      ).resolves.toBe(true);
    } finally {
      vi.unstubAllEnvs();
      rehydrateEnv();
    }
  });
});
