import type { UserAuthSuccess } from '@/types';

import {
  createCustomAutomationCommand,
  deleteCustomAutomationCommand,
  listCustomAutomationsCommand,
  getCustomAutomationOptionsCommand,
  triggerCustomAutomationCommand,
  updateCustomAutomationCommand,
} from '../custom-automations';
import { listSlackChannelsCommand } from '../slack-channels';
import { listAutomationDiscordChannelsCommand } from '../discord-channels';

const mocks = vi.hoisted(() => ({
  createCustomAutomation: vi.fn(),
  deleteCustomAutomation: vi.fn(),
  getCustomAutomationById: vi.fn(),
  listCustomAutomations: vi.fn(),
  getBackgroundAgentSettingsForDeployment: vi.fn(),
  resolveDeploymentTimeZone: vi.fn(),
  updateCustomAutomation: vi.fn(),
  runCustomAutomationNow: vi.fn(),
  listConnectedCommunicationProviders: vi.fn(),
  canStartAgentMailConversationWithUser: vi.fn(),
  listAgentMailOutboundIdentities: vi.fn(),
  captureActivationCustomAutomationChanged: vi.fn(),
}));

vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  createCustomAutomation: mocks.createCustomAutomation,
  deleteCustomAutomation: mocks.deleteCustomAutomation,
  getCustomAutomationById: mocks.getCustomAutomationById,
  listCustomAutomations: mocks.listCustomAutomations,
  getBackgroundAgentSettingsForDeployment:
    mocks.getBackgroundAgentSettingsForDeployment,
  updateCustomAutomation: mocks.updateCustomAutomation,
}));

vi.mock('@roomote/sdk/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/sdk/server')>()),
  listConnectedCommunicationProviders:
    mocks.listConnectedCommunicationProviders,
  canStartAgentMailConversationWithUser:
    mocks.canStartAgentMailConversationWithUser,
  listAgentMailOutboundIdentities: mocks.listAgentMailOutboundIdentities,
  runCustomAutomationNow: mocks.runCustomAutomationNow,
  resolveDeploymentTimeZone: mocks.resolveDeploymentTimeZone,
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
    mocks.canStartAgentMailConversationWithUser.mockResolvedValue(false);
    mocks.listAgentMailOutboundIdentities.mockResolvedValue([]);
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

  it.each([
    ['slack', 'slack_user'],
    ['discord', 'discord_user'],
    ['teams', 'teams_user'],
    ['telegram', 'telegram_user'],
  ] as const)(
    'stores %s DM me against the automation owner',
    async (provider, targetKind) => {
      mocks.listConnectedCommunicationProviders.mockResolvedValue([provider]);
      mocks.createCustomAutomation.mockResolvedValue(
        customAutomation({ provider }),
      );

      await createCustomAutomationCommand(adminAuth, {
        name: 'Private automation name',
        prompt: 'Private prompt',
        enabled: true,
        scheduleMode: 'daily',
        environmentId: 'environment-id',
        targetProvider: provider,
        targetMode: 'direct_message',
      });

      expect(mocks.createCustomAutomation).toHaveBeenCalledWith(
        expect.objectContaining({
          createdByUserId: 'user-admin',
          target: {
            provider,
            targetKind,
            externalRef: 'user-admin',
          },
        }),
      );
    },
  );

  it('stores the exact server-verified Email identity', async () => {
    mocks.canStartAgentMailConversationWithUser.mockResolvedValue(true);
    mocks.createCustomAutomation.mockResolvedValue(
      customAutomation({ provider: 'email' }),
    );

    await createCustomAutomationCommand(adminAuth, {
      name: 'Private automation name',
      prompt: 'Private prompt',
      enabled: true,
      scheduleMode: 'daily',
      environmentId: 'environment-id',
      targetProvider: 'email',
      targetMode: 'direct_message',
      targetChannelId: 'verified:user-admin:digest',
    });

    expect(mocks.canStartAgentMailConversationWithUser).toHaveBeenCalledWith(
      'user-admin',
      'verified:user-admin:digest',
    );
    expect(mocks.createCustomAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          provider: 'email',
          targetKind: 'email_user',
          externalRef: 'verified:user-admin:digest',
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

describe('custom automation ownership', () => {
  const memberAuth = { ...adminAuth, userId: 'member-1', isAdmin: false };
  const input = {
    id: 'automation-id',
    name: 'Report',
    prompt: 'Summarize',
    enabled: true,
    scheduleMode: 'daily',
    environmentId: '__fast__',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canStartAgentMailConversationWithUser.mockResolvedValue(false);
    mocks.listAgentMailOutboundIdentities.mockResolvedValue([]);
  });

  it('returns only member-safe connection flags and timezone without reading admin settings', async () => {
    mocks.listConnectedCommunicationProviders.mockResolvedValue([
      'slack',
      'teams',
    ]);
    mocks.resolveDeploymentTimeZone.mockResolvedValue({
      timeZone: 'America/New_York',
    });
    await expect(
      getCustomAutomationOptionsCommand(memberAuth),
    ).resolves.toEqual({
      capabilities: {
        slackConnected: true,
        discordConnected: false,
        telegramConnected: false,
        teamsConnected: true,
        emailConnected: false,
      },
      managerSlackChannelId: null,
      managerDiscordChannelId: null,
      emailIdentities: [],
      effectiveTimeZone: 'America/New_York',
    });
    expect(
      mocks.getBackgroundAgentSettingsForDeployment,
    ).not.toHaveBeenCalled();
  });

  it('offers only currently usable verified Email identities', async () => {
    mocks.listConnectedCommunicationProviders.mockResolvedValue([]);
    mocks.resolveDeploymentTimeZone.mockResolvedValue({ timeZone: 'UTC' });
    mocks.canStartAgentMailConversationWithUser.mockResolvedValue(true);
    mocks.listAgentMailOutboundIdentities.mockResolvedValue([
      {
        id: 'verified:member-1:digest',
        emailAddress: 'member@example.com',
        kind: 'verified',
      },
    ]);

    await expect(
      getCustomAutomationOptionsCommand(memberAuth),
    ).resolves.toEqual({
      capabilities: {
        slackConnected: false,
        discordConnected: false,
        telegramConnected: false,
        teamsConnected: false,
        emailConnected: true,
      },
      emailIdentities: [
        {
          id: 'verified:member-1:digest',
          emailAddress: 'member@example.com',
          kind: 'verified',
        },
      ],
      managerSlackChannelId: null,
      managerDiscordChannelId: null,
      effectiveTimeZone: 'UTC',
    });
  });

  it('allows admin channel defaults without returning other settings', async () => {
    mocks.listConnectedCommunicationProviders.mockResolvedValue([
      'discord',
      'telegram',
    ]);
    mocks.resolveDeploymentTimeZone.mockResolvedValue({ timeZone: 'UTC' });
    mocks.getBackgroundAgentSettingsForDeployment.mockResolvedValue({
      managerSlackChannelId: 'private-slack',
      managerDiscordChannelId: 'private-discord',
      privateConfiguration: 'must not leak',
    });
    await expect(getCustomAutomationOptionsCommand(adminAuth)).resolves.toEqual(
      {
        capabilities: {
          slackConnected: false,
          discordConnected: true,
          telegramConnected: true,
          teamsConnected: false,
          emailConnected: false,
        },
        managerSlackChannelId: 'private-slack',
        managerDiscordChannelId: 'private-discord',
        emailIdentities: [],
        effectiveTimeZone: 'UTC',
      },
    );
  });

  it('continues denying bot-scoped channel catalogs to members', async () => {
    await expect(listSlackChannelsCommand(memberAuth)).rejects.toThrow(
      'Unauthorized',
    );
    await expect(
      listAutomationDiscordChannelsCommand(memberAuth),
    ).rejects.toThrow('Unauthorized');
  });

  it('excludes other users and ownerless records before loading result history', async () => {
    mocks.listCustomAutomations.mockResolvedValue([
      { ...customAutomation(), createdByUserId: 'other' },
      { ...customAutomation(), createdByUserId: null },
    ]);
    await expect(listCustomAutomationsCommand(memberAuth)).resolves.toEqual([]);
  });

  it.each(['other', null])(
    'rejects update, delete and run for owner %s',
    async (createdByUserId) => {
      mocks.getCustomAutomationById.mockResolvedValue({
        ...customAutomation(),
        createdByUserId,
      });
      await expect(
        updateCustomAutomationCommand(memberAuth, input),
      ).rejects.toThrow('Custom automation was not found.');
      await expect(
        deleteCustomAutomationCommand(memberAuth, input),
      ).rejects.toThrow('Custom automation was not found.');
      await expect(
        triggerCustomAutomationCommand(memberAuth, input),
      ).rejects.toThrow('Custom automation was not found.');
      expect(mocks.updateCustomAutomation).not.toHaveBeenCalled();
      expect(mocks.deleteCustomAutomation).not.toHaveBeenCalled();
      expect(mocks.runCustomAutomationNow).not.toHaveBeenCalled();
    },
  );

  it('derives creation ownership from authentication and preserves it on update', async () => {
    const row = { ...customAutomation(), createdByUserId: memberAuth.userId };
    mocks.createCustomAutomation.mockResolvedValue(row);
    mocks.getCustomAutomationById.mockResolvedValue(row);
    mocks.updateCustomAutomation.mockResolvedValue(row);
    await createCustomAutomationCommand(memberAuth, {
      ...input,
      createdByUserId: 'other',
    } as typeof input);
    expect(mocks.createCustomAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ createdByUserId: memberAuth.userId }),
    );
    await updateCustomAutomationCommand(memberAuth, input);
    expect(mocks.updateCustomAutomation).toHaveBeenCalledWith(
      input.id,
      expect.not.objectContaining({ createdByUserId: expect.anything() }),
    );
  });

  it.each([false, true])(
    'allows an owner or admin to run and delete (admin=%s)',
    async (isAdmin) => {
      mocks.getCustomAutomationById.mockResolvedValue({
        ...customAutomation(),
        createdByUserId: 'member-1',
      });
      const auth = isAdmin ? adminAuth : memberAuth;
      await triggerCustomAutomationCommand(auth, input);
      await deleteCustomAutomationCommand(auth, input);
      expect(mocks.runCustomAutomationNow).toHaveBeenCalledWith(input.id);
      expect(mocks.deleteCustomAutomation).toHaveBeenCalledWith(input.id);
    },
  );
});
