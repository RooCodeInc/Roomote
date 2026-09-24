import {
  getDeploymentExperiments,
  setDeploymentExperimentEnabled,
} from '@roomote/db/server';
import {
  getDeploymentExperimentAudience,
  selectDeploymentExperimentValuesForAudiences,
  type DeploymentExperimentId,
} from '@roomote/feature-flags';

import type { UserAuthSuccess } from '@/types';

import { assertAdmin } from '../setup/shared';

export async function getDeploymentExperimentsCommand(_auth: UserAuthSuccess) {
  return selectDeploymentExperimentValuesForAudiences(
    await getDeploymentExperiments(),
    ['customer-preview', 'generally-available'],
  );
}

export async function setDeploymentExperimentCommand(
  auth: UserAuthSuccess,
  input: { id: DeploymentExperimentId; enabled: boolean },
) {
  assertAdmin(auth);
  if (getDeploymentExperimentAudience(input.id) !== 'customer-preview') {
    throw new Error('Unauthorized');
  }

  return selectDeploymentExperimentValuesForAudiences(
    await setDeploymentExperimentEnabled(input.id, input.enabled),
    ['customer-preview', 'generally-available'],
  );
}

function assertNightlyExperimentsAccess(auth: UserAuthSuccess) {
  assertAdmin(auth);
  if (auth.nightlyExperimentsEnabled !== true) {
    throw new Error('Unauthorized');
  }
}

export async function getNightlyExperimentsCommand(auth: UserAuthSuccess) {
  assertNightlyExperimentsAccess(auth);

  return selectDeploymentExperimentValuesForAudiences(
    await getDeploymentExperiments(),
    ['internal-nightly'],
  );
}

/**
 * The logo animation is a deployment-wide runtime effect, so every signed-in
 * user on an explicitly opted-in internal deployment can read this one bit.
 * Management reads and writes remain admin-only above.
 */
export async function getDizzyExperimentEnabledCommand(
  auth: UserAuthSuccess,
): Promise<boolean> {
  if (auth.nightlyExperimentsEnabled !== true) {
    throw new Error('Unauthorized');
  }

  return (await getDeploymentExperiments()).dizzy;
}

export async function setNightlyExperimentCommand(
  auth: UserAuthSuccess,
  input: { id: DeploymentExperimentId; enabled: boolean },
) {
  assertNightlyExperimentsAccess(auth);
  if (getDeploymentExperimentAudience(input.id) !== 'internal-nightly') {
    throw new Error('Unauthorized');
  }

  return selectDeploymentExperimentValuesForAudiences(
    await setDeploymentExperimentEnabled(input.id, input.enabled),
    ['internal-nightly'],
  );
}
