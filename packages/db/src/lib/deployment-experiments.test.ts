import { eq } from 'drizzle-orm';

import { db } from '../db';
import { deploymentSettings } from '../schema';

import {
  getDeploymentExperiments,
  setDeploymentExperimentEnabled,
} from './deployment-experiments';

describe('deployment experiments', () => {
  it('defaults every absent flag off and preserves stored values on updates', async () => {
    await expect(getDeploymentExperiments()).resolves.toEqual({
      results: false,
      slackPeerConversations: false,
      homeComposerSuggestions: false,
      serviceCredentialTools: false,
      privateSessions: false,
    });

    await db
      .update(deploymentSettings)
      .set({
        metadata: {
          preserved: true,
          private_sessions_experiment_enabled: true,
        },
      })
      .where(eq(deploymentSettings.id, 'default'));
    await setDeploymentExperimentEnabled('results', true);

    await expect(getDeploymentExperiments()).resolves.toMatchObject({
      results: true,
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
        private_sessions_experiment_enabled: true,
        results_page_enabled: true,
      },
    });
  });
});
