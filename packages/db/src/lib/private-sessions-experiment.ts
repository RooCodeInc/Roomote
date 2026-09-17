import {
  DEPLOYMENT_EXPERIMENT_METADATA_KEYS,
  getDeploymentExperimentValues,
} from '@roomote/feature-flags';

import {
  isDeploymentExperimentEnabled,
  setDeploymentExperimentEnabled,
} from './deployment-experiments';

export const PRIVATE_SESSIONS_EXPERIMENT_METADATA_KEY =
  DEPLOYMENT_EXPERIMENT_METADATA_KEYS.privateSessions;

export function isPrivateSessionsExperimentEnabledInMetadata(
  metadata: unknown,
): boolean {
  return getDeploymentExperimentValues(metadata).privateSessions;
}

export async function isPrivateSessionsExperimentEnabled(): Promise<boolean> {
  return isDeploymentExperimentEnabled('privateSessions');
}

export async function setPrivateSessionsExperimentEnabled(
  enabled: boolean,
): Promise<void> {
  await setDeploymentExperimentEnabled('privateSessions', enabled);
}
