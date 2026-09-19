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
  hasUserDirectMessageIdentity,
} from '@roomote/sdk/server';
import {
  CHAT_DESTINATION_LOOKUP_DEFAULT_LIMIT,
  communicationProviders,
  getCommunicationProviderDisplayName,
  chatDestinationLookupInputSchema,
  type ChatDestination,
  type ChatDestinationKind,
  type ChatDestinationLookupInput,
  type ChatDestinationLookupProvider,
  type ChatDestinationLookupResponse,
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

async function getSlackInstallations(slackTeamId: string | null): Promise<
  Array<{
    botAccessToken: string;
    teamId: string;
    teamName: string;
  }>
> {
  return (
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
}

async function discoverSlackChannels(
  installations: Awaited<ReturnType<typeof getSlackInstallations>>,
): Promise<DiscoveredCommunicationChannel[]> {
  return (
    await Promise.all(
      installations.map(async (installation) => {
        const slack = new SlackNotifier(installation.botAccessToken);
        return (await slack.listPublicChannels())
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
          }));
      }),
    )
  ).flat();
}

async function discoverSlackRecipients(
  installations: Awaited<ReturnType<typeof getSlackInstallations>>,
  actingUserId: string | null,
): Promise<DiscoveredDirectMessageRecipient[]> {
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
  return (
    await Promise.all(
      installations.map(async (installation) => {
        if (!actingWorkspaceIds.has(installation.teamId)) return [];
        const linkedRecipients = await db.query.slackUserMappings.findMany({
          columns: { slackUserId: true, userId: true },
          where: eq(slackUserMappings.slackTeamId, installation.teamId),
          with: {
            user: { columns: { name: true, deletedAt: true } },
          },
        });
        return linkedRecipients.flatMap((mapping) =>
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
        );
      }),
    )
  ).flat();
}

async function listSlackChannels(
  actingUserId: string | null,
  slackTeamId: string | null,
): Promise<CommunicationPlatformChannels> {
  const installations = await getSlackInstallations(slackTeamId);
  const [channels, directMessageRecipients] = await Promise.all([
    discoverSlackChannels(installations),
    discoverSlackRecipients(installations, actingUserId),
  ]);

  return {
    provider: 'slack',
    platform: getCommunicationProviderDisplayName('slack'),
    connected: installations.length > 0,
    discoverySupported: true,
    channels,
    directMessageRecipients,
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

function matchesDestinationQuery(
  destination: ChatDestination,
  query: string,
): boolean {
  const searchable = [
    destination.name,
    destination.workspaceName,
    destination.destination,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/u)
    .every((term) => searchable.includes(term));
}

function paginateDestinations(params: {
  provider: ChatDestinationLookupProvider;
  kind: ChatDestinationKind;
  destinations: ChatDestination[];
  offset?: number;
  limit?: number;
  limitations?: ChatDestinationLookupResponse['limitations'];
}): ChatDestinationLookupResponse {
  const offset = params.offset ?? 0;
  const limit = params.limit ?? CHAT_DESTINATION_LOOKUP_DEFAULT_LIMIT;
  const sorted = [...params.destinations].sort((left, right) =>
    [left.workspaceName ?? '', left.name, left.destination]
      .join('\u0000')
      .localeCompare(
        [right.workspaceName ?? '', right.name, right.destination].join(
          '\u0000',
        ),
      ),
  );
  const destinations = sorted.slice(offset, offset + limit);
  const nextOffset =
    offset + destinations.length < sorted.length
      ? offset + destinations.length
      : undefined;
  return {
    provider: params.provider,
    kind: params.kind,
    destinations,
    totalCount: sorted.length,
    returnedCount: destinations.length,
    offset,
    limit,
    hasMore: nextOffset !== undefined,
    truncated: offset > 0 || nextOffset !== undefined,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    limitations: params.limitations ?? [],
  };
}

export async function listCommunicationDestinations(
  options: ChatDestinationLookupInput & { actingUserId: string },
): Promise<ChatDestinationLookupResponse> {
  const { actingUserId: rawActingUserId, ...rawInput } = options;
  const input = chatDestinationLookupInputSchema.parse(rawInput);
  const actingUserId = rawActingUserId.trim();

  if (input.kind === 'self') {
    const linked = await hasUserDirectMessageIdentity(
      input.provider,
      actingUserId,
    );
    return paginateDestinations({
      provider: input.provider,
      kind: input.kind,
      destinations: linked
        ? [
            {
              destination: `${input.provider}:me`,
              provider: input.provider,
              kind: 'self',
              name: `Me on ${getCommunicationProviderDisplayName(input.provider)}`,
            },
          ]
        : [],
      offset: input.offset,
      limit: input.limit,
      limitations: linked
        ? []
        : [
            {
              provider: input.provider,
              reason: `The authenticated member does not have a linked ${getCommunicationProviderDisplayName(input.provider)} identity.`,
            },
          ],
    });
  }

  const installations = await getSlackInstallations(input.workspaceId ?? null);
  const destinations: ChatDestination[] =
    input.kind === 'channel'
      ? (await discoverSlackChannels(installations)).flatMap((channel) =>
          channel.workspaceId
            ? [
                {
                  destination: `slack:${channel.workspaceId}:channel:${channel.id}`,
                  provider: 'slack',
                  kind: 'channel',
                  name: channel.name,
                  workspaceId: channel.workspaceId,
                  workspaceName: channel.workspaceName,
                },
              ]
            : [],
        )
      : (await discoverSlackRecipients(installations, actingUserId)).map(
          (recipient) => ({
            destination: `slack:${recipient.workspaceId}:member:${recipient.id}`,
            provider: 'slack',
            kind: 'person',
            name: recipient.name,
            workspaceId: recipient.workspaceId,
            workspaceName: recipient.workspaceName,
          }),
        );
  const filtered = destinations.filter((destination) =>
    input.destination
      ? destination.destination === input.destination
      : matchesDestinationQuery(destination, input.query!),
  );
  return paginateDestinations({
    provider: input.provider,
    kind: input.kind,
    destinations: filtered,
    offset: input.offset,
    limit: input.limit,
  });
}
