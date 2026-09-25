import type { UserAuthSuccess } from '@/types';

import { appRouter } from './_app';

describe('nightly experiment API access', () => {
  it('blocks direct reads and writes when the deployment opt-in is off', async () => {
    const caller = appRouter.createCaller({
      auth: {
        success: true,
        userType: 'user',
        userId: 'member',
        isAdmin: true,
        nightlyExperimentsEnabled: false,
      } as UserAuthSuccess,
    });

    await expect(caller.nightlyExperiments.get()).rejects.toThrow(
      'Unauthorized',
    );
    await expect(
      caller.nightlyExperiments.set({
        id: 'automationLaunchCriteria',
        enabled: true,
      }),
    ).rejects.toThrow('Unauthorized');
    await expect(
      caller.nightlyExperiments.runtime({
        id: 'integrationToolAutoApprovals',
      }),
    ).rejects.toThrow('Unauthorized');
  });

  it('keeps management routes admin-only on opted-in deployments', async () => {
    const caller = appRouter.createCaller({
      auth: {
        success: true,
        userType: 'user',
        userId: 'member',
        isAdmin: false,
        nightlyExperimentsEnabled: true,
      } as UserAuthSuccess,
    });

    await expect(caller.nightlyExperiments.get()).rejects.toThrow(
      'Unauthorized',
    );
    await expect(
      caller.nightlyExperiments.set({
        id: 'automationLaunchCriteria',
        enabled: true,
      }),
    ).rejects.toThrow('Unauthorized');
  });
});
