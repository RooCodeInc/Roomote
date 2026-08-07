import type { UserAuthSuccess } from '@/types';

import {
  createCustomAutomationCommand,
  deleteCustomAutomationCommand,
} from '../custom-automations';

const mocks = vi.hoisted(() => ({
  createCustomAutomation: vi.fn(),
  deleteCustomAutomation: vi.fn(),
  getCustomAutomationById: vi.fn(),
  listConnectedCommunicationProviders: vi.fn(),
  captureActivationCustomAutomationChanged: vi.fn(),
}));

vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  createCustomAutomation: mocks.createCustomAutomation,
  deleteCustomAutomation: mocks.deleteCustomAutomation,
  getCustomAutomationById: mocks.getCustomAutomationById,
}));

vi.mock('@roomote/sdk/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/sdk/server')>()),
  listConnectedCommunicationProviders:
    mocks.listConnectedCommunicationProviders,
}));

vi.mock('@roomote/telemetry/server', () => ({
  captureActivationCustomAutomationChanged:
    mocks.captureActivationCustomAutomationChanged,
}));

const adminAuth = {
  success: true,
  userType: 'user',
  userId: 'user-admin',
  name: 'Admin',
  primaryEmail: 'admin@example.com',
  isAdmin: true,
  featureFlags: {},
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
} satisfies UserAuthSuccess;

function customAutomation(target: { provider?: string } = {}) {
  return {
    id: 'automation-id',
    name: 'Private automation name',
    prompt: 'Private prompt',
    enabled: true,
    scheduleMode: 'daily',
    cronExpression: null,
    model: null,
    environmentId: 'environment-id',
    target,
    lastRunAt: null,
    lastSucceededAt: null,
    lastFailedAt: null,
    lastError: null,
    lastLaunchedTaskId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('custom automation activation telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listConnectedCommunicationProviders.mockResolvedValue(['slack']);
  });

  it('tracks creation with only the destination provider classification', async () => {
    mocks.createCustomAutomation.mockResolvedValue(
      customAutomation({ provider: 'slack' }),
    );

    await createCustomAutomationCommand(adminAuth, {
      name: 'Private automation name',
      prompt: 'Private prompt',
      enabled: true,
      scheduleMode: 'daily',
      environmentId: 'environment-id',
      targetProvider: 'slack',
      targetChannelId: 'private-channel-id',
    });

    expect(mocks.captureActivationCustomAutomationChanged).toHaveBeenCalledWith(
      'created',
      'slack',
    );
  });

  it('stores DM me against the automation owner', async () => {
    mocks.createCustomAutomation.mockResolvedValue(
      customAutomation({ provider: 'slack' }),
    );

    await createCustomAutomationCommand(adminAuth, {
      name: 'Private automation name',
      prompt: 'Private prompt',
      enabled: true,
      scheduleMode: 'daily',
      environmentId: 'environment-id',
      targetProvider: 'slack',
      targetMode: 'direct_message',
    });

    expect(mocks.createCustomAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        createdByUserId: 'user-admin',
        target: {
          provider: 'slack',
          targetKind: 'slack_user',
          externalRef: 'user-admin',
        },
      }),
    );
  });

  it('tracks deletion with only the persisted destination provider classification', async () => {
    mocks.getCustomAutomationById.mockResolvedValue(
      customAutomation({ provider: 'discord' }),
    );

    await deleteCustomAutomationCommand(adminAuth, { id: 'automation-id' });

    expect(mocks.captureActivationCustomAutomationChanged).toHaveBeenCalledWith(
      'deleted',
      'discord',
    );
  });
});
