import {
  db,
  discordInstallationChannels,
  discordInstallations,
} from '@roomote/db/server';
import type { FeatureFlag } from '@roomote/feature-flags';

import type { UserAuthSuccess } from '@/types';

import { listAutomationDiscordChannelsCommand } from '../discord-channels';

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

async function insertInstallation(params: {
  guildId: string;
  guildName: string | null;
  isActive: boolean;
}) {
  const [installation] = await db
    .insert(discordInstallations)
    .values({
      guildId: params.guildId,
      guildName: params.guildName,
      applicationId: 'app-1',
      botUserId: 'bot-1',
      isActive: params.isActive,
    })
    .returning();

  if (!installation) {
    throw new Error('Failed to insert Discord installation fixture.');
  }

  return installation;
}

async function insertChannel(params: {
  installationId: string;
  channelId: string;
  channelName: string;
  channelType: number;
  isAvailable?: boolean;
  position?: number;
}) {
  await db.insert(discordInstallationChannels).values({
    discordInstallationId: params.installationId,
    channelId: params.channelId,
    channelName: params.channelName,
    channelType: params.channelType,
    position: params.position ?? null,
    isAvailable: params.isAvailable ?? true,
  });
}

describe('listAutomationDiscordChannelsCommand', () => {
  beforeEach(async () => {
    // Cascades to discord_installation_channels.
    await db.delete(discordInstallations);
  });

  it('rejects non-admin users', async () => {
    await expect(
      listAutomationDiscordChannelsCommand({ ...adminAuth, isAdmin: false }),
    ).rejects.toThrow('Unauthorized');
  });

  it('only lists available text and announcement channels of active installations', async () => {
    const active = await insertInstallation({
      guildId: 'guild-active',
      guildName: 'Acme',
      isActive: true,
    });
    const inactive = await insertInstallation({
      guildId: 'guild-inactive',
      guildName: 'Retired',
      isActive: false,
    });

    await insertChannel({
      installationId: active.id,
      channelId: 'D-text',
      channelName: 'general',
      channelType: 0,
      position: 1,
    });
    await insertChannel({
      installationId: active.id,
      channelId: 'D-announcements',
      channelName: 'announcements',
      channelType: 5,
      position: 2,
    });
    // Forum channels cannot take plain automation messages.
    await insertChannel({
      installationId: active.id,
      channelId: 'D-forum',
      channelName: 'ideas-forum',
      channelType: 15,
      position: 3,
    });
    // No longer visible to the bot.
    await insertChannel({
      installationId: active.id,
      channelId: 'D-hidden',
      channelName: 'hidden',
      channelType: 0,
      isAvailable: false,
      position: 4,
    });
    // Belongs to a deactivated installation.
    await insertChannel({
      installationId: inactive.id,
      channelId: 'D-stale',
      channelName: 'stale',
      channelType: 0,
      position: 1,
    });

    const { channels } = await listAutomationDiscordChannelsCommand(adminAuth);

    expect(channels).toEqual([
      {
        id: 'D-text',
        name: 'general',
        label: '#general',
        guildId: 'guild-active',
        guildName: 'Acme',
      },
      {
        id: 'D-announcements',
        name: 'announcements',
        label: '#announcements',
        guildId: 'guild-active',
        guildName: 'Acme',
      },
    ]);
  });

  it('appends the guild name to labels when several active guilds exist', async () => {
    const first = await insertInstallation({
      guildId: 'guild-a',
      guildName: 'Alpha',
      isActive: true,
    });
    const second = await insertInstallation({
      guildId: 'guild-b',
      guildName: 'Beta',
      isActive: true,
    });

    await insertChannel({
      installationId: first.id,
      channelId: 'D-alpha',
      channelName: 'general',
      channelType: 0,
      position: 1,
    });
    await insertChannel({
      installationId: second.id,
      channelId: 'D-beta',
      channelName: 'general',
      channelType: 0,
      position: 1,
    });

    const { channels } = await listAutomationDiscordChannelsCommand(adminAuth);

    expect(channels.map((channel) => channel.label)).toEqual([
      '#general — Alpha',
      '#general — Beta',
    ]);
  });
});
