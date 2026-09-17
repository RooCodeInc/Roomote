import { eq } from 'drizzle-orm';

import { db } from '../db';
import { deploymentSettings } from '../schema';

import {
  isPrivateSessionsExperimentEnabled,
  isPrivateSessionsExperimentEnabledInMetadata,
  PRIVATE_SESSIONS_EXPERIMENT_METADATA_KEY,
  setPrivateSessionsExperimentEnabled,
} from './private-sessions-experiment';

describe('Private Sessions deployment experiment', () => {
  it('defaults off and enables only from explicit deployment metadata', async () => {
    expect(isPrivateSessionsExperimentEnabledInMetadata(undefined)).toBe(false);
    expect(isPrivateSessionsExperimentEnabledInMetadata({})).toBe(false);
    expect(
      isPrivateSessionsExperimentEnabledInMetadata({
        [PRIVATE_SESSIONS_EXPERIMENT_METADATA_KEY]: 'true',
      }),
    ).toBe(false);
    await setPrivateSessionsExperimentEnabled(false);
    await expect(isPrivateSessionsExperimentEnabled()).resolves.toBe(false);
    await setPrivateSessionsExperimentEnabled(true);

    await expect(isPrivateSessionsExperimentEnabled()).resolves.toBe(true);
    await expect(
      db.query.deploymentSettings.findFirst({
        where: eq(deploymentSettings.id, 'default'),
        columns: { metadata: true },
      }),
    ).resolves.toMatchObject({
      metadata: {
        [PRIVATE_SESSIONS_EXPERIMENT_METADATA_KEY]: true,
      },
    });
  });
});
