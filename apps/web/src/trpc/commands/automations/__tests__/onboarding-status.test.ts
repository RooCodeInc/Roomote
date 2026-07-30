import {
  automations,
  db,
  deploymentSettings,
  slackInstallations,
  upsertAutomation,
} from '@roomote/db/server';
import type { FeatureFlag } from '@roomote/feature-flags';

import type { UserAuthSuccess } from '@/types';

import { getAutomationOnboardingStatusCommand } from '../onboarding-status';

const adminAuth: UserAuthSuccess = {
  success: true,
  userType: 'user',
  userId: 'user-admin',
  name: 'Admin',
  primaryEmail: 'admin@example.com',
  isAdmin: true,
  featureFlags: {} as Record<FeatureFlag, boolean>,
  anonymousAnalyticsEnabled: false,
  cloudEnabled: false,
  cookieConsentedAt: null,
  resource: {
    username: null,
    fullName: null,
    firstName: null,
    lastName: null,
    primaryEmailAddress: null,
    emailAddresses: [],
    imageUrl: '',
    createdAt: null,
  },
};

describe('getAutomationOnboardingStatusCommand', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await db.delete(automations);
    await db.delete(deploymentSettings);
    await db.delete(slackInstallations);

    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('no network calls expected'));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('reports no enabled automations on a fresh deployment without calling Slack', async () => {
    await expect(
      getAutomationOnboardingStatusCommand(adminAuth),
    ).resolves.toEqual({ hasEnabledAutomations: false });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports enabled automations once one is scheduled', async () => {
    await upsertAutomation(db, {
      key: 'manager_stats',
      enabled: true,
      schedule: { mode: 'weekly' },
    });

    await expect(
      getAutomationOnboardingStatusCommand(adminAuth),
    ).resolves.toEqual({ hasEnabledAutomations: true });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still reports nothing enabled when an automation exists but is off', async () => {
    await upsertAutomation(db, {
      key: 'manager_stats',
      enabled: false,
      schedule: { mode: 'weekly' },
    });

    await expect(
      getAutomationOnboardingStatusCommand(adminAuth),
    ).resolves.toEqual({ hasEnabledAutomations: false });
  });

  it('rejects non-admins', async () => {
    await expect(
      getAutomationOnboardingStatusCommand({ ...adminAuth, isAdmin: false }),
    ).rejects.toThrow('Unauthorized');
  });
});
