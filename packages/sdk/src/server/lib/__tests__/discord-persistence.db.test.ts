import { randomUUID } from 'node:crypto';

import { db, discordGatewaySessions, users } from '@roomote/db/server';

import {
  captureDiscordDefaultDestination,
  clearDiscordGatewayResumeState,
  deactivateDiscordInstallation,
  findDiscordDefaultDestination,
  findDiscordGatewayResumeState,
  findDiscordInstallationByGuildId,
  findDiscordMappedUserId,
  listDiscordInstallationChannels,
  listDiscordInstallations,
  recordDiscordGatewayHeartbeatAck,
  reconcileDiscordInstallations,
  saveDiscordGatewayResumeState,
  syncDiscordInstallationChannels,
  updateDiscordGatewaySequence,
  upsertDiscordInstallation,
  upsertDiscordUserMapping,
} from '../discord-persistence';

async function createUser() {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    name: 'Discord Test User',
    email: `${id}@example.test`,
    imageUrl: '',
    entity: {},
    metadata: {},
  });
  return id;
}

describe('Discord persistence (real database)', () => {
  it('tracks a guild channel catalog and selected default destination', async () => {
    const userId = await createUser();
    await upsertDiscordInstallation({
      guildId: 'guild-1',
      guildName: 'Engineering',
      applicationId: 'application-1',
      botUserId: 'bot-1',
      installedByUserId: userId,
    });

    await syncDiscordInstallationChannels({
      guildId: 'guild-1',
      channels: [
        { channelId: 'general', channelName: 'general', channelType: 0 },
        { channelId: 'tasks', channelName: 'tasks', channelType: 15 },
      ],
    });
    expect(
      await listDiscordInstallationChannels({ guildId: 'guild-1' }),
    ).toHaveLength(2);

    await syncDiscordInstallationChannels({
      guildId: 'guild-1',
      channels: [
        { channelId: 'tasks', channelName: 'agent-tasks', channelType: 15 },
      ],
    });
    const available = await listDiscordInstallationChannels({
      guildId: 'guild-1',
    });
    const all = await listDiscordInstallationChannels({
      guildId: 'guild-1',
      includeUnavailable: true,
    });
    expect(available.map((channel) => channel.channelId)).toEqual(['tasks']);
    expect(
      all.find((channel) => channel.channelId === 'general')?.isAvailable,
    ).toBe(false);

    await captureDiscordDefaultDestination({
      guildId: 'guild-1',
      channelId: 'tasks',
      channelName: 'agent-tasks',
      channelType: 15,
    });
    await expect(
      findDiscordDefaultDestination('guild-1'),
    ).resolves.toMatchObject({
      guildId: 'guild-1',
      channelId: 'tasks',
      channelType: 15,
    });

    await expect(deactivateDiscordInstallation('guild-1')).resolves.toBe(true);
    await expect(listDiscordInstallations()).resolves.toEqual([]);
    await expect(
      listDiscordInstallations({ includeInactive: true }),
    ).resolves.toHaveLength(1);
  });

  it('keeps the default destination deployment-wide: picking one clears the rest', async () => {
    const userId = await createUser();
    const suffix = randomUUID();
    const firstGuildId = `guild-default-a-${suffix}`;
    const secondGuildId = `guild-default-b-${suffix}`;
    const firstChannelId = `channel-default-a-${suffix}`;
    const secondChannelId = `channel-default-b-${suffix}`;

    for (const [guildId, channelId] of [
      [firstGuildId, firstChannelId],
      [secondGuildId, secondChannelId],
    ] as const) {
      await upsertDiscordInstallation({
        guildId,
        guildName: guildId,
        applicationId: 'application-default',
        botUserId: 'bot-default',
        installedByUserId: userId,
      });
      await syncDiscordInstallationChannels({
        guildId,
        channels: [{ channelId, channelName: 'roomote', channelType: 0 }],
      });
    }

    await captureDiscordDefaultDestination({
      guildId: firstGuildId,
      channelId: firstChannelId,
      channelName: 'roomote',
      channelType: 0,
    });
    await captureDiscordDefaultDestination({
      guildId: secondGuildId,
      channelId: secondChannelId,
      channelName: 'roomote',
      channelType: 0,
    });

    // The later pick is THE deployment default; the earlier guild's stored
    // default is cleared instead of lingering as a lastUsedAt-race fallback.
    await expect(findDiscordDefaultDestination()).resolves.toMatchObject({
      guildId: secondGuildId,
      channelId: secondChannelId,
    });
    await expect(
      findDiscordInstallationByGuildId(firstGuildId),
    ).resolves.toMatchObject({ defaultChannelId: null });
    await expect(findDiscordDefaultDestination(firstGuildId)).resolves.toBe(
      null,
    );
  });

  it('reconciles live guilds and invalidates destinations after bot identity rotation', async () => {
    const userId = await createUser();
    const suffix = randomUUID();
    const firstGuildId = `guild-a-${suffix}`;
    const secondGuildId = `guild-b-${suffix}`;
    const firstChannelId = `channel-a-${suffix}`;
    const secondChannelId = `channel-b-${suffix}`;

    await reconcileDiscordInstallations({
      applicationId: 'application-original',
      botUserId: 'bot-original',
      installedByUserId: userId,
      guilds: [
        { guildId: firstGuildId, guildName: 'First guild' },
        { guildId: secondGuildId, guildName: 'Second guild' },
      ],
    });
    await syncDiscordInstallationChannels({
      guildId: firstGuildId,
      channels: [
        {
          channelId: firstChannelId,
          channelName: 'roomote',
          channelType: 0,
        },
      ],
    });
    await syncDiscordInstallationChannels({
      guildId: secondGuildId,
      channels: [
        {
          channelId: secondChannelId,
          channelName: 'roomote',
          channelType: 0,
        },
      ],
    });
    await captureDiscordDefaultDestination({
      guildId: firstGuildId,
      channelId: firstChannelId,
      channelName: 'roomote',
      channelType: 0,
    });
    await captureDiscordDefaultDestination({
      guildId: secondGuildId,
      channelId: secondChannelId,
      channelName: 'roomote',
      channelType: 0,
    });

    const removal = await reconcileDiscordInstallations({
      applicationId: 'application-original',
      botUserId: 'bot-original',
      installedByUserId: userId,
      guilds: [{ guildId: firstGuildId, guildName: 'First guild' }],
    });
    expect(removal.deactivatedGuildIds).toContain(secondGuildId);
    await expect(
      findDiscordInstallationByGuildId(secondGuildId),
    ).resolves.toMatchObject({ isActive: false });

    await reconcileDiscordInstallations({
      applicationId: 'application-original',
      botUserId: 'bot-original',
      installedByUserId: userId,
      guilds: [
        { guildId: firstGuildId, guildName: 'First guild' },
        { guildId: secondGuildId, guildName: 'Second guild returned' },
      ],
    });
    await expect(
      findDiscordInstallationByGuildId(secondGuildId),
    ).resolves.toMatchObject({
      guildName: 'Second guild returned',
      isActive: true,
      defaultChannelId: secondChannelId,
    });

    const rotation = await reconcileDiscordInstallations({
      applicationId: 'application-replacement',
      botUserId: 'bot-replacement',
      installedByUserId: userId,
      guilds: [{ guildId: firstGuildId, guildName: 'First guild' }],
    });
    expect(rotation.resetGuildIds).toEqual(
      expect.arrayContaining([firstGuildId, secondGuildId]),
    );
    await expect(
      findDiscordInstallationByGuildId(firstGuildId),
    ).resolves.toMatchObject({
      applicationId: 'application-replacement',
      botUserId: 'bot-replacement',
      isActive: true,
      defaultChannelId: null,
      defaultChannelName: null,
      defaultChannelType: null,
      lastUsedAt: null,
    });
    await expect(
      findDiscordInstallationByGuildId(secondGuildId),
    ).resolves.toMatchObject({
      applicationId: 'application-replacement',
      botUserId: 'bot-replacement',
      isActive: false,
      defaultChannelId: null,
      defaultChannelName: null,
      defaultChannelType: null,
      lastUsedAt: null,
    });
    await expect(
      findDiscordDefaultDestination(firstGuildId),
    ).resolves.toBeNull();
    await expect(
      listDiscordInstallationChannels({
        guildId: firstGuildId,
        includeUnavailable: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        channelId: firstChannelId,
        isAvailable: false,
      }),
    ]);
  });

  it('invalidates a destination when an inbound guild upsert observes a new bot identity', async () => {
    const userId = await createUser();
    const suffix = randomUUID();
    const guildId = `guild-upsert-${suffix}`;
    const channelId = `channel-upsert-${suffix}`;

    await upsertDiscordInstallation({
      guildId,
      applicationId: 'application-before-upsert',
      botUserId: 'bot-before-upsert',
      installedByUserId: userId,
    });
    await syncDiscordInstallationChannels({
      guildId,
      channels: [{ channelId, channelType: 0 }],
    });
    await captureDiscordDefaultDestination({
      guildId,
      channelId,
      channelType: 0,
    });

    await upsertDiscordInstallation({
      guildId,
      applicationId: 'application-after-upsert',
      botUserId: 'bot-after-upsert',
      installedByUserId: userId,
    });

    await expect(
      findDiscordInstallationByGuildId(guildId),
    ).resolves.toMatchObject({
      applicationId: 'application-after-upsert',
      botUserId: 'bot-after-upsert',
      defaultChannelId: null,
      lastUsedAt: null,
    });
    await expect(findDiscordDefaultDestination(guildId)).resolves.toBeNull();
    await expect(
      listDiscordInstallationChannels({
        guildId,
        includeUnavailable: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ channelId, isAvailable: false }),
    ]);
  });

  it('relinks a Discord identity to the latest Roomote user', async () => {
    const firstUserId = await createUser();
    const secondUserId = await createUser();

    await upsertDiscordUserMapping({
      discordUserId: 'discord-user-1',
      discordUsername: 'ada',
      discordGlobalName: 'Ada',
      userId: firstUserId,
    });
    await expect(findDiscordMappedUserId('discord-user-1')).resolves.toBe(
      firstUserId,
    );

    await upsertDiscordUserMapping({
      discordUserId: 'discord-user-1',
      discordUsername: 'ada-renamed',
      discordDmChannelId: 'dm-1',
      userId: secondUserId,
    });
    await expect(findDiscordMappedUserId('discord-user-1')).resolves.toBe(
      secondUserId,
    );
  });

  it('persists, advances, and invalidates Gateway resume state', async () => {
    const key = {
      tokenFingerprint: randomUUID(),
      shardId: 0,
    };
    await saveDiscordGatewayResumeState({
      ...key,
      sessionId: 'session-1',
      resumeGatewayUrl: 'wss://gateway.discord.example',
      sequence: 10,
      shardCount: 1,
    });
    await updateDiscordGatewaySequence({ ...key, sequence: 11 });
    await recordDiscordGatewayHeartbeatAck({
      ...key,
      acknowledgedAt: new Date('2026-07-12T20:00:00.000Z'),
    });

    await expect(findDiscordGatewayResumeState(key)).resolves.toEqual({
      sessionId: 'session-1',
      resumeGatewayUrl: 'wss://gateway.discord.example',
      sequence: 11,
      shardId: 0,
      shardCount: 1,
    });
    await expect(
      db.query.discordGatewaySessions.findFirst({
        where: (session, { eq }) => eq(session.id, `${key.tokenFingerprint}:0`),
      }),
    ).resolves.toMatchObject({
      lastHeartbeatAckAt: new Date('2026-07-12T20:00:00.000Z'),
    });

    await clearDiscordGatewayResumeState({
      ...key,
      lastError: 'invalid session',
    });
    await expect(findDiscordGatewayResumeState(key)).resolves.toBeNull();
    await expect(
      db.query.discordGatewaySessions.findFirst({
        where: (session, { eq }) => eq(session.id, `${key.tokenFingerprint}:0`),
      }),
    ).resolves.toMatchObject({
      id: `${key.tokenFingerprint}:0`,
      sessionId: null,
      lastError: 'invalid session',
    } satisfies Partial<typeof discordGatewaySessions.$inferSelect>);
  });
});
