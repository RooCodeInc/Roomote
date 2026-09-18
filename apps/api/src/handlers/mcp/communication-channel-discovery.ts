import {
  db,
  discordInstallationChannels,
  discordUserMappings,
  eq,
  slackUserMappings,
  teamsInstallations,
} from '@roomote/db/server';
import { SlackNotifier } from '@roomote/slack';
import {
  createDiscordCommunicationProviderFromRuntimeCredentials,
  getCommunicationProviderAdapter,
} from '@roomote/sdk/server';
import {
  communicationProviders,
  getCommunicationProviderDisplayName,
  type CommunicationProvider,
} from '@roomote/types';

type DiscoveredCommunicationChannel = {
  id: string;
  name: string;
  kind?: string;
  workspaceId?: string;
  workspaceName?: string;
  parentId?: string;
  nativeChannelId?: string;
};

type DiscoveredDirectMessageRecipient = {
  id: string;
  name: string;
  workspaceId: string;
  workspaceName?: string;
};

type CommunicationPlatformChannels = {
  provider: CommunicationProvider;
  platform: string;
  connected: boolean;
  discoverySupported: boolean;
  channels: DiscoveredCommunicationChannel[];
  directMessageRecipients?: DiscoveredDirectMessageRecipient[];
  limitation?: string;
};

type CommunicationChannelsPayload = {
  channelCount: number;
  platforms: CommunicationPlatformChannels[];
};

const DISCORD_CHANNEL_KINDS: Record<number, string> = {
  0: 'text',
  5: 'announcement',
  15: 'forum',
  16: 'forum',
};

async function listSlackChannels(
  actingUserId: string | null,
  slackTeamId: string | null,
): Promise<CommunicationPlatformChannels> {
  const installations = (
    await db.query.slackInstallations.findMany({
      columns: {
        botAccessToken: true,
        teamId: true,
        teamName: true,
      },
      where: (installation, { eq }) => eq(installation.isActive, true),
    })
  ).filter(
    (installation) => !slackTeamId || installation.teamId === slackTeamId,
  );
  const actingWorkspaceIds = new Set(
    actingUserId
      ? (
          await db.query.slackUserMappings.findMany({
            columns: { slackTeamId: true },
            where: eq(slackUserMappings.userId, actingUserId),
          })
        ).map(({ slackTeamId }) => slackTeamId)
      : [],
  );
  const destinations = await Promise.all(
    installations.map(async (installation) => {
      const slack = new SlackNotifier(installation.botAccessToken);
      const [visibleChannels, linkedRecipients] = await Promise.all([
        slack.listPublicChannels(),
        actingWorkspaceIds.has(installation.teamId)
          ? db.query.slackUserMappings.findMany({
              columns: { slackUserId: true, userId: true },
              where: eq(slackUserMappings.slackTeamId, installation.teamId),
              with: {
                user: { columns: { name: true, deletedAt: true } },
              },
            })
          : [],
      ]);

      return {
        channels: visibleChannels
          .filter(
            (channel) =>
              channel.isMember === true && channel.isPrivate === false,
          )
          .map((channel) => ({
            id: channel.id,
            name: channel.name,
            kind: channel.isPrivate ? 'private' : 'public',
            workspaceId: installation.teamId,
            workspaceName: installation.teamName,
          })),
        directMessageRecipients: linkedRecipients.flatMap((mapping) =>
          mapping.userId !== actingUserId &&
          mapping.user &&
          !mapping.user.deletedAt
            ? [
                {
                  id: mapping.slackUserId,
                  name: mapping.user.name,
                  workspaceId: installation.teamId,
                  workspaceName: installation.teamName,
                },
              ]
            : [],
        ),
      };
    }),
  );

  return {
    provider: 'slack',
    platform: getCommunicationProviderDisplayName('slack'),
    connected: installations.length > 0,
    discoverySupported: true,
    channels: destinations.flatMap(({ channels }) => channels),
    directMessageRecipients: destinations.flatMap(
      ({ directMessageRecipients }) => directMessageRecipients,
    ),
  };
}

async function listDiscordChannels(
  actingUserId: string | null,
): Promise<CommunicationPlatformChannels> {
  const installations = await db.query.discordInstallations.findMany({
    columns: {
      guildId: true,
      guildName: true,
    },
    where: (installation, { eq }) => eq(installation.isActive, true),
    with: {
      channels: {
        where: eq(discordInstallationChannels.isAvailable, true),
      },
    },
  });
  const linkedUser = actingUserId
    ? await db.query.discordUserMappings.findFirst({
        columns: { discordUserId: true },
        where: eq(discordUserMappings.userId, actingUserId),
      })
    : null;
  const provider = linkedUser
    ? await createDiscordCommunicationProviderFromRuntimeCredentials()
    : null;
  const linkedDiscordUserId = linkedUser?.discordUserId;
  const channels =
    provider && linkedDiscordUserId
      ? (
          await Promise.all(
            installations.map(async (installation) => {
              const supportedChannels = installation.channels.filter(
                (channel) => DISCORD_CHANNEL_KINDS[channel.channelType],
              );
              const accessibleChannelIds = new Set(
                await provider.listPublicAccessibleChannelIds({
                  guildId: installation.guildId,
                  userId: linkedDiscordUserId,
                  channelIds: supportedChannels.map(
                    (channel) => channel.channelId,
                  ),
                }),
              );
              return supportedChannels.flatMap((channel) => {
                const kind = DISCORD_CHANNEL_KINDS[channel.channelType];
                return kind && accessibleChannelIds.has(channel.channelId)
                  ? [
                      {
                        id: channel.channelId,
                        name: channel.channelName ?? channel.channelId,
                        kind,
                        workspaceId: installation.guildId,
                        workspaceName: installation.guildName ?? undefined,
                        parentId: channel.parentId ?? undefined,
                      },
                    ]
                  : [];
              });
            }),
          )
        ).flat()
      : [];

  return {
    provider: 'discord',
    platform: getCommunicationProviderDisplayName('discord'),
    connected: installations.length > 0,
    discoverySupported: true,
    channels,
  };
}

async function listTeamsChannels(
  _actingUserId: string | null,
): Promise<CommunicationPlatformChannels> {
  const installations = await db.query.teamsInstallations.findMany({
    columns: {
      tenantId: true,
      teamId: true,
      teamName: true,
      channelId: true,
      channelName: true,
      conversationId: true,
      conversationType: true,
    },
    where: eq(teamsInstallations.isActive, true),
  });
  return {
    provider: 'teams',
    platform: getCommunicationProviderDisplayName('teams'),
    connected: installations.length > 0,
    discoverySupported: false,
    channels: [],
    limitation:
      'Microsoft Teams does not currently expose a safe deployment-wide channel list with acting-user access checks.',
  };
}

export async function listCommunicationChannels(options: {
  actingUserId?: string | null;
  slackTeamId?: string | null;
}): Promise<CommunicationChannelsPayload> {
  const actingUserId = options.actingUserId?.trim() || null;
  const slackTeamId = options.slackTeamId?.trim() || null;
  const discovered = await Promise.all([
    listSlackChannels(actingUserId, slackTeamId),
    listTeamsChannels(actingUserId),
    listDiscordChannels(actingUserId),
  ]);
  const platformsByProvider = new Map(
    discovered.map((platform) => [platform.provider, platform]),
  );
  const telegram = await getCommunicationProviderAdapter('telegram');
  platformsByProvider.set('telegram', {
    provider: 'telegram',
    platform: getCommunicationProviderDisplayName('telegram'),
    connected: telegram !== null,
    discoverySupported: false,
    channels: [],
    limitation:
      'Telegram Bot API does not provide a way to enumerate chats available to a bot.',
  });
  const agentmail = await getCommunicationProviderAdapter('agentmail');
  platformsByProvider.set('agentmail', {
    provider: 'agentmail',
    platform: getCommunicationProviderDisplayName('agentmail'),
    connected: agentmail !== null,
    discoverySupported: false,
    channels: [],
    limitation:
      'Email runs through a single Roomote inbox and conversations are inbound-initiated; there are no enumerable channels.',
  });
  const platforms = communicationProviders.map(
    (provider) => platformsByProvider.get(provider)!,
  );

  return {
    channelCount: platforms.reduce(
      (count, platform) => count + platform.channels.length,
      0,
    ),
    platforms,
  };
}
