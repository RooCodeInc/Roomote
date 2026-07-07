import { fetchSlackGetJson } from './slack-api-fetch';

const SLACK_CONVERSATIONS_LIST_LIMIT = 999;
const MAX_SLACK_CONVERSATIONS_LIST_PUBLIC_CHANNEL_RATE_LIMIT_RETRIES = 3;

type SlackConversationListChannel = {
  id?: string;
  name?: string;
  is_private?: boolean;
  is_member?: boolean;
};

type SlackConversationsListContext =
  | 'listAccessibleChannels'
  | 'listPublicChannels'
  | 'resolveChannelId';

function getConversationsListRateLimitRetries(
  context: SlackConversationsListContext,
): number {
  switch (context) {
    case 'listPublicChannels':
      return MAX_SLACK_CONVERSATIONS_LIST_PUBLIC_CHANNEL_RATE_LIMIT_RETRIES;
    case 'listAccessibleChannels':
    case 'resolveChannelId':
      // Interactive settings flows should fail fast when Slack rate-limits
      // channel discovery instead of waiting through multi-minute retry windows.
      return 0;
  }
}

type SlackConversationsListResponse = {
  ok: boolean;
  error?: string;
  channels?: SlackConversationListChannel[];
  response_metadata?: {
    next_cursor?: string;
  };
};

export class SlackChannelDiscovery {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async fetchConversationsListPage(params: {
    context: SlackConversationsListContext;
    cursor?: string;
    types: string;
  }): Promise<SlackConversationsListResponse | null> {
    const { context, cursor, types } = params;
    const query = new URLSearchParams({
      exclude_archived: 'true',
      limit: String(SLACK_CONVERSATIONS_LIST_LIMIT),
      types,
    });

    if (cursor) {
      query.set('cursor', cursor);
    }

    return fetchSlackGetJson<SlackConversationsListResponse>({
      token: this.token,
      endpoint: 'conversations.list',
      context,
      query,
      fetchImpl: this.fetchImpl,
      maxRateLimitRetries: getConversationsListRateLimitRetries(context),
    });
  }

  private async listChannels(params: {
    context: Extract<
      SlackConversationsListContext,
      'listAccessibleChannels' | 'listPublicChannels'
    >;
    types: string;
  }): Promise<
    Array<{
      id: string;
      name: string;
      isPrivate: boolean;
      isMember: boolean | null;
    }>
  > {
    const channelsById = new Map<
      string,
      {
        id: string;
        name: string;
        isPrivate: boolean;
        isMember: boolean | null;
      }
    >();
    let cursor: string | undefined;

    try {
      do {
        const result = await this.fetchConversationsListPage({
          context: params.context,
          cursor,
          types: params.types,
        });

        if (!result) {
          break;
        }

        for (const channel of result.channels ?? []) {
          if (channel.id && channel.name && !channelsById.has(channel.id)) {
            channelsById.set(channel.id, {
              id: channel.id,
              name: channel.name,
              isPrivate: channel.is_private === true,
              isMember:
                typeof channel.is_member === 'boolean'
                  ? channel.is_member
                  : null,
            });
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);
    } catch (error) {
      console.error(
        `[${params.context}] Failed to list channels: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return [...channelsById.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  public async listAccessibleChannels(): Promise<
    Array<{
      id: string;
      name: string;
      isPrivate: boolean;
      isMember: boolean | null;
    }>
  > {
    return this.listChannels({
      context: 'listAccessibleChannels',
      types: 'public_channel,private_channel',
    });
  }

  public async listPublicChannels(): Promise<
    Array<{
      id: string;
      name: string;
      isPrivate: boolean;
      isMember: boolean | null;
    }>
  > {
    return this.listChannels({
      context: 'listPublicChannels',
      types: 'public_channel',
    });
  }

  public async resolveChannelId(input: string): Promise<string | null> {
    const trimmed = input.trim();

    if (!trimmed) {
      return null;
    }

    if (/^[CGD][A-Z0-9]+$/i.test(trimmed)) {
      return trimmed;
    }

    if (!trimmed.startsWith('#')) {
      return null;
    }

    const target = trimmed.slice(1).toLowerCase();

    if (!target) {
      return null;
    }

    let cursor: string | undefined;

    try {
      do {
        const result = await this.fetchConversationsListPage({
          context: 'resolveChannelId',
          cursor,
          types: 'public_channel,private_channel',
        });

        if (!result) {
          return null;
        }

        const match = result.channels?.find(
          (channel) => channel.name?.toLowerCase() === target && channel.id,
        );

        if (match?.id) {
          return match.id;
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);
    } catch (error) {
      console.error(
        `[resolveChannelId] Failed to resolve channel ID: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }

    return null;
  }
}
