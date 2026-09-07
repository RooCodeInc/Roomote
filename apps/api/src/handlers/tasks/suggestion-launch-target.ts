import { ALL_REPOSITORIES, FAST_EXECUTION } from '@roomote/types';

export type SuggestedTaskLaunchTarget =
  | { kind: 'router' }
  | { kind: 'fast' }
  | { kind: 'all_repositories' }
  | { kind: 'environment'; environmentId: string }
  | { kind: 'legacy_pinned' };

/**
 * Classify how a claimed suggestion should launch.
 *
 * `launchTarget` is the card's explicit target (an environment id or a
 * platform sentinel) and wins when present; it is never a repository name.
 * Without it the persisted work-item columns decide: a sentinel stored in
 * `targetRepositoryFullName`, an environment-only pin, a router card, or a
 * legacy pinned card (repository plus optional environment).
 */
export function resolveSuggestedTaskLaunchTarget(input: {
  launchTarget?: string | null;
  usesRouterLaunch?: boolean;
  targetEnvironmentId?: string | null;
  targetRepositoryFullName?: string | null;
}): SuggestedTaskLaunchTarget {
  const explicitTarget = input.launchTarget || null;
  const sentinelSource = explicitTarget ?? input.targetRepositoryFullName;
  if (sentinelSource === FAST_EXECUTION) {
    return { kind: 'fast' };
  }
  if (sentinelSource === ALL_REPOSITORIES) {
    return { kind: 'all_repositories' };
  }
  if (explicitTarget) {
    // An explicit environment target stays an environment target even when
    // the work item's `targetEnvironmentId` was cleared (for example by the
    // environment FK's ON DELETE SET NULL); the launcher then reports the
    // environment as unavailable instead of silently launching elsewhere.
    return { kind: 'environment', environmentId: explicitTarget };
  }
  if (!input.targetRepositoryFullName && input.targetEnvironmentId) {
    return {
      kind: 'environment',
      environmentId: input.targetEnvironmentId,
    };
  }
  return input.usesRouterLaunch
    ? { kind: 'router' }
    : { kind: 'legacy_pinned' };
}

/**
 * The environment a suggestion launch must run in, or null when the target
 * does not pin one. Explicit environment targets pin their own id; legacy
 * pinned cards pin the work item's `targetEnvironmentId` when it has one.
 * Launchers must fail (not fall back to routing) when this environment cannot
 * be resolved.
 */
export function resolveSuggestedTaskPinnedEnvironmentId(
  target: SuggestedTaskLaunchTarget,
  suggestion: { targetEnvironmentId?: string | null },
): string | null {
  if (target.kind === 'environment') {
    return target.environmentId;
  }
  if (target.kind === 'legacy_pinned') {
    return suggestion.targetEnvironmentId || null;
  }
  return null;
}
