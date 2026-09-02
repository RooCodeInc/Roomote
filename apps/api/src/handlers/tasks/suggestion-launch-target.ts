import { ALL_REPOSITORIES, FAST_EXECUTION } from '@roomote/types';

export type SuggestedTaskLaunchTarget =
  | { kind: 'router' }
  | { kind: 'fast' }
  | { kind: 'all_repositories' }
  | { kind: 'environment'; environmentId: string }
  | { kind: 'legacy_pinned' };

export function resolveSuggestedTaskLaunchTarget(input: {
  launchTarget?: string | null;
  usesRouterLaunch?: boolean;
  targetEnvironmentId?: string | null;
  targetRepositoryFullName?: string | null;
}): SuggestedTaskLaunchTarget {
  const launchTarget = input.launchTarget ?? input.targetRepositoryFullName;
  if (!launchTarget) {
    if (input.targetEnvironmentId) {
      return {
        kind: 'environment',
        environmentId: input.targetEnvironmentId,
      };
    }
    return input.usesRouterLaunch
      ? { kind: 'router' }
      : { kind: 'legacy_pinned' };
  }
  if (launchTarget === FAST_EXECUTION) {
    return { kind: 'fast' };
  }
  if (launchTarget === ALL_REPOSITORIES) {
    return { kind: 'all_repositories' };
  }
  if (launchTarget === input.targetEnvironmentId) {
    return { kind: 'environment', environmentId: launchTarget };
  }
  return { kind: 'legacy_pinned' };
}
