import {
  getDeploymentExperiments,
  setDeploymentExperimentEnabled,
} from '@roomote/db/server';
import type { DeploymentExperimentId } from '@roomote/feature-flags';

import type { UserAuthSuccess } from '@/types';

import { assertAdmin } from '../setup/shared';

export async function getDeploymentExperimentsCommand(_auth: UserAuthSuccess) {
  return getDeploymentExperiments();
}

export async function setDeploymentExperimentCommand(
  auth: UserAuthSuccess,
  input: { id: DeploymentExperimentId; enabled: boolean },
) {
  assertAdmin(auth);
  return setDeploymentExperimentEnabled(input.id, input.enabled);
}
