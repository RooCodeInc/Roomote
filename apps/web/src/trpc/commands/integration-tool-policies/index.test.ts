import type { UserAuthSuccess } from '@/types';

import {
  getIntegrationToolAutoSettingsCommand,
  setIntegrationToolAutoSettingsCommand,
} from './index';

describe('Auto settings nightly access', () => {
  const customerAdmin = {
    userId: 'admin',
    isAdmin: true,
    nightlyExperimentsEnabled: false,
  } as UserAuthSuccess;

  it('keeps old Auto settings unavailable on deployments without nightly opt-in', async () => {
    await expect(
      getIntegrationToolAutoSettingsCommand(customerAdmin),
    ).rejects.toThrow('Auto tool approvals are not enabled.');

    await expect(
      setIntegrationToolAutoSettingsCommand(customerAdmin, {
        mode: 'on',
        policy: '',
      }),
    ).rejects.toThrow('Auto tool approvals are not enabled.');
  });
});
