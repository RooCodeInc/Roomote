import {
  MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE,
  type ManagedDeploymentAccess,
} from '@roomote/types';

export function getTaskLaunchDisabledReason(
  managedAccess: ManagedDeploymentAccess,
): string | undefined {
  return managedAccess.state === 'read_only'
    ? MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE
    : undefined;
}
