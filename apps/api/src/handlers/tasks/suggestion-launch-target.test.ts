import { ALL_REPOSITORIES, FAST_EXECUTION } from '@roomote/types';

import { resolveSuggestedTaskLaunchTarget } from './suggestion-launch-target.js';

describe.each(['slack', 'discord', 'teams', 'telegram'])(
  '%s suggestion targets',
  () => {
    it.each([
      [
        { launchTarget: 'env-1', targetEnvironmentId: 'env-1' },
        { kind: 'environment', environmentId: 'env-1' },
      ],
      [{ launchTarget: ALL_REPOSITORIES }, { kind: 'all_repositories' }],
      [{ launchTarget: FAST_EXECUTION }, { kind: 'fast' }],
      [{ usesRouterLaunch: true }, { kind: 'router' }],
      [{ targetRepositoryFullName: 'acme/app' }, { kind: 'legacy_pinned' }],
    ] as const)('resolves %j', (input, expected) => {
      expect(resolveSuggestedTaskLaunchTarget(input)).toEqual(expected);
    });
  },
);
