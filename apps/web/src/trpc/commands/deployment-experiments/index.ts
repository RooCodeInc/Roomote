import {
  cancelOpenIntegrationToolApprovals,
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
  const result = await setDeploymentExperimentEnabled(input.id, input.enabled);
  // Disabling tool approvals must not strand open requests: cancel pending
  // and approved-but-unclaimed rows with a recorded reason so in-flight
  // waits fail closed and a later re-enable cannot resurrect them.
  if (input.id === 'integrationToolApprovals' && !input.enabled) {
    await cancelOpenIntegrationToolApprovals('experiment_disabled');
  }
  return result;
}
