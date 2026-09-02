import { ALL_REPOSITORIES, FAST_EXECUTION } from '@roomote/types';

import {
  resolveSuggestedTaskLaunchTarget,
  resolveSuggestedTaskPinnedEnvironmentId,
} from './suggestion-launch-target.js';

describe.each(['slack', 'discord', 'teams', 'telegram'])(
  '%s suggestion targets',
  () => {
    it.each([
      [
        { launchTarget: 'env-1', targetEnvironmentId: 'env-1' },
        { kind: 'environment', environmentId: 'env-1' },
      ],
      // The environment FK nulls `targetEnvironmentId` when the environment
      // is deleted; the explicit target must still classify as that
      // environment so the launcher reports it unavailable.
      [
        { launchTarget: 'env-1', targetEnvironmentId: null },
        { kind: 'environment', environmentId: 'env-1' },
      ],
      [{ launchTarget: ALL_REPOSITORIES }, { kind: 'all_repositories' }],
      [{ launchTarget: FAST_EXECUTION }, { kind: 'fast' }],
      [
        { targetRepositoryFullName: ALL_REPOSITORIES },
        { kind: 'all_repositories' },
      ],
      [{ targetRepositoryFullName: FAST_EXECUTION }, { kind: 'fast' }],
      [{ usesRouterLaunch: true }, { kind: 'router' }],
      [
        { targetEnvironmentId: 'env-1' },
        { kind: 'environment', environmentId: 'env-1' },
      ],
      [{ targetRepositoryFullName: 'acme/app' }, { kind: 'legacy_pinned' }],
      [
        { targetRepositoryFullName: 'acme/app', targetEnvironmentId: 'env-1' },
        { kind: 'legacy_pinned' },
      ],
    ] as const)('resolves %j', (input, expected) => {
      expect(resolveSuggestedTaskLaunchTarget(input)).toEqual(expected);
    });
  },
);

describe('resolveSuggestedTaskPinnedEnvironmentId', () => {
  it.each([
    [
      { kind: 'environment', environmentId: 'env-1' },
      { targetEnvironmentId: null },
      'env-1',
    ],
    [{ kind: 'legacy_pinned' }, { targetEnvironmentId: 'env-2' }, 'env-2'],
    [{ kind: 'legacy_pinned' }, { targetEnvironmentId: null }, null],
    [{ kind: 'router' }, { targetEnvironmentId: 'env-2' }, null],
    [{ kind: 'all_repositories' }, { targetEnvironmentId: 'env-2' }, null],
    [{ kind: 'fast' }, { targetEnvironmentId: 'env-2' }, null],
  ] as const)('pins %j with %j to %s', (target, suggestion, expected) => {
    expect(resolveSuggestedTaskPinnedEnvironmentId(target, suggestion)).toBe(
      expected,
    );
  });
});
