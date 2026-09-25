import type { UserAuthSuccess } from '@/types';

import {
  getDeploymentExperimentsCommand,
  getIntegrationToolAutoApprovalsEnabledCommand,
  getNightlyExperimentsCommand,
  setDeploymentExperimentCommand,
  setNightlyExperimentCommand,
} from './index';

function auth(
  userId: string,
  isAdmin: boolean,
  nightlyExperimentsEnabled = false,
): UserAuthSuccess {
  return { userId, isAdmin, nightlyExperimentsEnabled } as UserAuthSuccess;
}

describe('Auto tool approvals nightly experiment', () => {
  const admin = auth('auto-admin', true, true);
  const member = auth('auto-member', false, true);

  it('keeps Auto out of customer-preview reads and writes', async () => {
    await expect(
      getDeploymentExperimentsCommand(admin),
    ).resolves.not.toHaveProperty('integrationToolAutoApprovals');
    await expect(
      setDeploymentExperimentCommand(admin, {
        id: 'integrationToolAutoApprovals',
        enabled: true,
      }),
    ).rejects.toThrow('Unauthorized');
  });

  it('defaults off in Nightly and exposes the runtime value to opted-in members', async () => {
    await setNightlyExperimentCommand(admin, {
      id: 'integrationToolAutoApprovals',
      enabled: false,
    });
    await expect(getNightlyExperimentsCommand(admin)).resolves.toMatchObject({
      integrationToolAutoApprovals: false,
    });
    await expect(
      getIntegrationToolAutoApprovalsEnabledCommand(member),
    ).resolves.toBe(false);
    await expect(
      getIntegrationToolAutoApprovalsEnabledCommand(
        auth('customer-member', false, false),
      ),
    ).rejects.toThrow('Unauthorized');

    try {
      await setNightlyExperimentCommand(admin, {
        id: 'integrationToolAutoApprovals',
        enabled: true,
      });
      await expect(
        getIntegrationToolAutoApprovalsEnabledCommand(member),
      ).resolves.toBe(true);
    } finally {
      await setNightlyExperimentCommand(admin, {
        id: 'integrationToolAutoApprovals',
        enabled: false,
      });
    }
  });
});
