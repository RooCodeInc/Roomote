import type {
  CommunicationChannelMessagesResult,
  CommunicationMessage,
  CommunicationPostMessageInput,
  CommunicationPostMessageResult,
  CommunicationProviderAdapter,
  CommunicationReactionResult,
  CommunicationThreadLookupResult,
} from './provider';
import { UnsupportedCommunicationOperationError } from './provider';
import {
  TeamsBotFrameworkClient,
  type TeamsBotFrameworkClientOptions,
} from './teams-bot-framework-client';
import type { TeamsActivityImageAttachment } from './teams-activity';
import { normalizePromptImageMimeType } from './teams-image-mime';
import { TeamsGraphClient, type TeamsGraphMessage } from './teams-graph-client';

export type TeamsCommunicationProviderOptions =
  TeamsBotFrameworkClientOptions & {
    serviceUrl?: string;
    /**
     * Returns a delegated Microsoft Graph access token for history reads,
     * typically minted from the acting user's linked Entra refresh token.
     * When absent, thread/channel history reads report an unsupported
     * operation.
     */
    graphTokenProvider?: () => Promise<string>;
    /** Graph base URL override for tests. */
    graphBaseUrl?: string;
  };

export type TeamsDirectMessageInput = {
  botName?: string;
  serviceUrl: string;
  tenantId: string;
  text: string;
  textFormat?: 'plain' | 'markdown' | 'xml';
  userId: string;
};

const MAX_TEAMS_IMAGE_ATTACHMENTS = 10;
const MAX_TEAMS_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEAMS_IMAGE_TOTAL_BYTES = 25 * 1024 * 1024;

function inferPromptImageMimeTypeFromBytes(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  if (
    bytes.length >= 6 &&
    bytes
      .subarray(0, 6)
      .toString('ascii')
      .match(/^GIF8[79]a$/)
  ) {
    return 'image/gif';
  }

  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return undefined;
}

function isGenericBinaryContentType(contentType: string | undefined): boolean {
  const normalized = contentType?.split(';')[0]?.trim().toLowerCase();

  return (
    !normalized ||
    normalized === 'application/octet-stream' ||
    normalized === 'binary/octet-stream'
  );
}

function toPromptImageDataUrl(input: {
  bytes: Buffer;
  contentType?: string;
  fallbackContentType?: string;
}): string | null {
  const contentType =
    normalizePromptImageMimeType(input.contentType) ??
    inferPromptImageMimeTypeFromBytes(input.bytes) ??
    (isGenericBinaryContentType(input.contentType)
      ? normalizePromptImageMimeType(input.fallbackContentType)
      : undefined);

  return contentType
    ? `data:${contentType};base64,${input.bytes.toString('base64')}`
    : null;
}

export class TeamsCommunicationProvider implements CommunicationProviderAdapter {
  readonly provider = 'teams' as const;

  private readonly client: TeamsBotFrameworkClient;
  private readonly graphClient: TeamsGraphClient | null;

  constructor(private readonly options: TeamsCommunicationProviderOptions) {
    this.client = new TeamsBotFrameworkClient(options);
    this.graphClient = options.graphTokenProvider
      ? new TeamsGraphClient({
          getAccessToken: options.graphTokenProvider,
          ...(options.graphBaseUrl ? { baseUrl: options.graphBaseUrl } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        })
      : null;
  }

  async postMessage(
    input: CommunicationPostMessageInput,
  ): Promise<CommunicationPostMessageResult> {
    const serviceUrl = input.serviceUrl ?? this.options.serviceUrl;

    if (!serviceUrl) {
      throw new Error('Teams postMessage requires a Bot Framework serviceUrl.');
    }

    const imageAttachments =
      input.images?.map((image) => ({
        contentType: image.contentType ?? 'image/*',
        contentUrl: image.url,
        name: image.altText,
      })) ?? [];
    const attachments = [...(input.attachments ?? []), ...imageAttachments];

    const result = await this.client.sendActivity({
      serviceUrl,
      conversationId: input.channelId,
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.textFormat ? { textFormat: input.textFormat } : {}),
      ...((input.replyToMessageId ?? input.threadId)
        ? { replyToActivityId: input.replyToMessageId ?? input.threadId }
        : {}),
      ...(input.channelData ? { channelData: input.channelData } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    });

    return {
      provider: 'teams',
      channelId: input.channelId,
      messageId: result.id,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    };
  }

  async postDirectMessage(
    input: TeamsDirectMessageInput,
  ): Promise<CommunicationPostMessageResult> {
    const conversation = await this.client.createDirectConversation({
      serviceUrl: input.serviceUrl,
      tenantId: input.tenantId,
      userId: input.userId,
      ...(input.botName ? { botName: input.botName } : {}),
    });
    const result = await this.client.sendActivity({
      serviceUrl: input.serviceUrl,
      conversationId: conversation.id,
      text: input.text,
      ...(input.textFormat ? { textFormat: input.textFormat } : {}),
    });

    return {
      provider: 'teams',
      channelId: conversation.id,
      messageId: result.id,
    };
  }

  async updateMessage(input: {
    channelId: string;
    messageId: string;
    serviceUrl?: string;
    text: string;
    textFormat?: 'plain' | 'markdown' | 'xml';
    images?: Array<{ url: string; altText: string; contentType?: string }>;
  }): Promise<void> {
    const serviceUrl = input.serviceUrl ?? this.options.serviceUrl;

    if (!serviceUrl) {
      throw new Error(
        'Teams updateMessage requires a Bot Framework serviceUrl.',
      );
    }

    const imageAttachments =
      input.images?.map((image) => ({
        contentType: image.contentType ?? 'image/*',
        contentUrl: image.url,
        name: image.altText,
      })) ?? [];

    await this.client.updateActivity({
      serviceUrl,
      conversationId: input.channelId,
      activityId: input.messageId,
      text: input.text,
      ...(input.textFormat ? { textFormat: input.textFormat } : {}),
      ...(imageAttachments.length > 0 ? { attachments: imageAttachments } : {}),
    });
  }

  async processImageAttachments(
    attachments: TeamsActivityImageAttachment[],
    options?: { serviceUrl?: string },
  ): Promise<string[]> {
    const images: string[] = [];
    const trustedHosts = options?.serviceUrl
      ? [new URL(options.serviceUrl).hostname]
      : [];
    const cappedAttachments = attachments.slice(0, MAX_TEAMS_IMAGE_ATTACHMENTS);
    let totalBytes = 0;

    for (const attachment of cappedAttachments) {
      try {
        const downloaded = await this.client.downloadAttachment({
          contentUrl: attachment.contentUrl,
          trustedHosts,
          maxBytes: MAX_TEAMS_IMAGE_BYTES,
        });

        if (
          totalBytes + downloaded.bytes.length >
          MAX_TEAMS_IMAGE_TOTAL_BYTES
        ) {
          console.warn(
            `[teams] Skipping remaining image attachments after total byte cap (${MAX_TEAMS_IMAGE_TOTAL_BYTES}) reached`,
          );
          break;
        }

        totalBytes += downloaded.bytes.length;

        const image = toPromptImageDataUrl({
          bytes: downloaded.bytes,
          contentType: downloaded.contentType,
          fallbackContentType: attachment.contentType,
        });

        if (!image) {
          console.warn(
            `[teams] Skipping image attachment ${attachment.name ?? attachment.contentUrl} because downloaded content type ${
              downloaded.contentType ?? 'unknown'
            } is not a supported prompt image`,
          );
          continue;
        }

        images.push(image);
      } catch (error) {
        console.error(
          `[teams] Failed to process image attachment ${attachment.name ?? attachment.contentUrl}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return images;
  }

  async fetchMessageImageDataUrls(input: {
    channelId: string;
    messageId: string;
    serviceUrl?: string;
    teamId?: string;
    threadId?: string;
  }): Promise<string[]> {
    const graph = this.getGraphClient('fetchThreadMessages');
    const { conversationBaseId } = splitTeamsConversationId(input.channelId);
    let hostedContentIds: string[] = [];

    if (input.teamId) {
      const teamGroupId = await this.resolveTeamGroupId({
        operation: 'fetchThreadMessages',
        serviceUrl: input.serviceUrl,
        teamId: input.teamId,
      });
      const isReply = Boolean(
        input.threadId && input.threadId !== input.messageId,
      );
      const rootMessageId = isReply ? input.threadId! : input.messageId;
      const message = isReply
        ? await graph.getChannelMessageReply({
            teamGroupId,
            channelId: conversationBaseId,
            messageId: rootMessageId,
            replyId: input.messageId,
          })
        : await graph.getChannelMessage({
            teamGroupId,
            channelId: conversationBaseId,
            messageId: input.messageId,
          });

      hostedContentIds = message?.hostedContentIds ?? [];

      return this.downloadGraphHostedContentImages({
        hostedContentIds,
        download: (hostedContentId) =>
          graph.getChannelMessageHostedContentValue({
            teamGroupId,
            channelId: conversationBaseId,
            messageId: rootMessageId,
            hostedContentId,
            ...(isReply ? { replyId: input.messageId } : {}),
          }),
      });
    }

    const message = await graph.getChatMessage({
      chatId: conversationBaseId,
      messageId: input.messageId,
    });
    hostedContentIds = message?.hostedContentIds ?? [];

    return this.downloadGraphHostedContentImages({
      hostedContentIds,
      download: (hostedContentId) =>
        graph.getChatMessageHostedContentValue({
          chatId: conversationBaseId,
          messageId: input.messageId,
          hostedContentId,
        }),
    });
  }

  private async downloadGraphHostedContentImages(input: {
    hostedContentIds: string[];
    download: (
      hostedContentId: string,
    ) => Promise<{ bytes: Buffer; contentType?: string }>;
  }): Promise<string[]> {
    const images: string[] = [];
    let totalBytes = 0;

    for (const hostedContentId of input.hostedContentIds.slice(
      0,
      MAX_TEAMS_IMAGE_ATTACHMENTS,
    )) {
      try {
        const downloaded = await input.download(hostedContentId);

        if (downloaded.bytes.length > MAX_TEAMS_IMAGE_BYTES) {
          console.warn(
            `[teams] Skipping hosted image content ${hostedContentId} because it exceeds max size of ${MAX_TEAMS_IMAGE_BYTES} bytes`,
          );
          continue;
        }

        if (
          totalBytes + downloaded.bytes.length >
          MAX_TEAMS_IMAGE_TOTAL_BYTES
        ) {
          console.warn(
            `[teams] Skipping remaining hosted image contents after total byte cap (${MAX_TEAMS_IMAGE_TOTAL_BYTES}) reached`,
          );
          break;
        }

        totalBytes += downloaded.bytes.length;

        const image = toPromptImageDataUrl(downloaded);

        if (image) {
          images.push(image);
        } else {
          console.warn(
            `[teams] Skipping hosted image content ${hostedContentId} because content type ${
              downloaded.contentType ?? 'unknown'
            } is not a supported prompt image`,
          );
        }
      } catch (error) {
        console.error(
          `[teams] Failed to process hosted image content ${hostedContentId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return images;
  }

  /**
   * Fetches the raw Graph messages for a Teams thread (channel thread when a
   * teamId is provided, otherwise the whole group/personal chat), sorted
   * oldest first. Exposes author identity and mention data that the mapped
   * `CommunicationMessage` shape drops.
   */
  async fetchThreadGraphMessages(input: {
    channelId: string;
    messageId: string;
    serviceUrl?: string;
    teamId?: string;
  }): Promise<{ threadId: string; messages: TeamsGraphMessage[] }> {
    const graph = this.getGraphClient('fetchThreadMessages');
    const { conversationBaseId } = splitTeamsConversationId(input.channelId);
    let graphMessages: TeamsGraphMessage[];
    let threadId = input.messageId;

    // Channel threads require the Bot Framework team id to resolve the Graph
    // team; group and personal chats share id formats with channels (both use
    // `19:...@thread.v2`), so teamId presence is the reliable discriminator.
    if (input.teamId) {
      const teamGroupId = await this.resolveTeamGroupId({
        operation: 'fetchThreadMessages',
        serviceUrl: input.serviceUrl,
        teamId: input.teamId,
      });
      const [root, replies] = await Promise.all([
        graph
          .getChannelMessage({
            teamGroupId,
            channelId: conversationBaseId,
            messageId: input.messageId,
          })
          .catch(() => null),
        graph.listChannelMessageReplies({
          teamGroupId,
          channelId: conversationBaseId,
          messageId: input.messageId,
        }),
      ]);

      graphMessages = [...(root ? [root] : []), ...replies];
    } else {
      graphMessages = await graph.listChatMessages({
        chatId: conversationBaseId,
      });
      threadId = conversationBaseId;
    }

    return { threadId, messages: sortGraphMessagesAscending(graphMessages) };
  }

  async fetchThreadMessages(input: {
    channelId: string;
    messageId: string;
    serviceUrl?: string;
    teamId?: string;
  }): Promise<CommunicationThreadLookupResult> {
    const { threadId, messages: graphMessages } =
      await this.fetchThreadGraphMessages(input);
    const messages = graphMessages.map((message) =>
      toCommunicationMessage(message, input.channelId, threadId),
    );
    const matchedMessageIndex = messages.findIndex(
      (message) => message.id === input.messageId,
    );

    return {
      provider: 'teams',
      channelId: input.channelId,
      requestedMessageId: input.messageId,
      threadId,
      matchedMessageIndex,
      messageCount: messages.length,
      messages,
    };
  }

  async fetchChannelMessages(input: {
    channelId: string;
    oldest?: string;
    latest?: string;
    serviceUrl?: string;
    teamId?: string;
  }): Promise<CommunicationChannelMessagesResult> {
    const graph = this.getGraphClient('fetchChannelMessages');
    const { conversationBaseId } = splitTeamsConversationId(input.channelId);
    let graphMessages: TeamsGraphMessage[];

    if (input.teamId) {
      const teamGroupId = await this.resolveTeamGroupId({
        operation: 'fetchChannelMessages',
        serviceUrl: input.serviceUrl,
        teamId: input.teamId,
      });

      graphMessages = await graph.listChannelMessages({
        teamGroupId,
        channelId: conversationBaseId,
      });
    } else {
      graphMessages = await graph.listChatMessages({
        chatId: conversationBaseId,
      });
    }

    const messages = sortGraphMessagesAscending(graphMessages)
      .filter((message) =>
        isWithinDateRange(message.createdDateTime, input.oldest, input.latest),
      )
      .map((message) => toCommunicationMessage(message, input.channelId));

    return {
      provider: 'teams',
      channelId: input.channelId,
      ...(input.oldest ? { requestedOldest: input.oldest } : {}),
      ...(input.latest ? { requestedLatest: input.latest } : {}),
      messageCount: messages.length,
      messages,
    };
  }

  async addReaction(input: {
    channelId: string;
    messageId: string;
    name: string;
    serviceUrl?: string;
    threadId?: string;
  }): Promise<CommunicationReactionResult> {
    const emoji = resolveTeamsReactionEmoji(input.name);

    if (!emoji) {
      throw new UnsupportedCommunicationOperationError({
        provider: 'teams',
        operation: 'addReaction',
        message: `Teams does not support the reaction "${input.name}".`,
        help: `Use one of: ${Object.keys(TEAMS_REACTION_EMOJI_BY_NAME).join(', ')}.`,
      });
    }

    const serviceUrl = input.serviceUrl ?? this.options.serviceUrl;
    if (!serviceUrl) {
      throw new UnsupportedCommunicationOperationError({
        provider: 'teams',
        operation: 'addReaction',
        message:
          'Teams emoji reaction messages require a Bot Framework serviceUrl.',
      });
    }

    await this.postMessage({
      channelId: input.channelId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      replyToMessageId: input.threadId ?? input.messageId,
      serviceUrl,
      text: emoji,
      textFormat: 'plain',
    });

    return {
      provider: 'teams',
      channelId: input.channelId,
      messageId: input.messageId,
      name: input.name,
    };
  }

  private getGraphClient(
    operation: 'fetchThreadMessages' | 'fetchChannelMessages',
  ): TeamsGraphClient {
    if (!this.graphClient) {
      throw new UnsupportedCommunicationOperationError({
        provider: 'teams',
        operation,
        message: `Teams ${
          operation === 'fetchThreadMessages' ? 'thread' : 'channel'
        } history reads require a delegated Microsoft Graph token.`,
        help: 'Teams history reads run as the linked Microsoft user. Grant the app registration delegated Graph permissions (ChannelMessage.Read.All, Chat.Read) with admin consent, and have the user link their Microsoft account so a Graph token can be minted from their sign-in.',
      });
    }

    return this.graphClient;
  }

  private async resolveTeamGroupId(input: {
    operation: 'fetchThreadMessages' | 'fetchChannelMessages';
    serviceUrl?: string;
    teamId?: string;
  }): Promise<string> {
    const serviceUrl = input.serviceUrl ?? this.options.serviceUrl;

    if (!input.teamId || !serviceUrl) {
      throw new UnsupportedCommunicationOperationError({
        provider: 'teams',
        operation: input.operation,
        message:
          'Teams channel history reads require the Bot Framework team id and serviceUrl to resolve the Graph team.',
      });
    }

    const details = await this.client.getTeamDetails({
      serviceUrl,
      teamId: input.teamId,
    });

    if (!details.aadGroupId) {
      throw new Error(
        `Teams getTeamDetails did not return an AAD group id for team ${input.teamId}.`,
      );
    }

    return details.aadGroupId;
  }
}

function splitTeamsConversationId(conversationId: string): {
  conversationBaseId: string;
  embeddedMessageId?: string;
} {
  const [conversationBaseId = conversationId, embeddedMessageId] =
    conversationId.split(';messageid=');

  return {
    conversationBaseId,
    ...(embeddedMessageId ? { embeddedMessageId } : {}),
  };
}

function sortGraphMessagesAscending(
  messages: TeamsGraphMessage[],
): TeamsGraphMessage[] {
  return [...messages].sort((a, b) => {
    const aTime = a.createdDateTime ? Date.parse(a.createdDateTime) : NaN;
    const bTime = b.createdDateTime ? Date.parse(b.createdDateTime) : NaN;

    if (Number.isFinite(aTime) && Number.isFinite(bTime)) {
      return aTime - bTime;
    }

    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });
}

function isWithinDateRange(
  createdDateTime: string | undefined,
  oldest: string | undefined,
  latest: string | undefined,
): boolean {
  if (!oldest && !latest) {
    return true;
  }

  const createdMs = createdDateTime ? Date.parse(createdDateTime) : NaN;

  if (!Number.isFinite(createdMs)) {
    return true;
  }

  const oldestMs = oldest ? Date.parse(oldest) : NaN;
  const latestMs = latest ? Date.parse(latest) : NaN;

  if (Number.isFinite(oldestMs) && createdMs < oldestMs) {
    return false;
  }

  if (Number.isFinite(latestMs) && createdMs > latestMs) {
    return false;
  }

  return true;
}

function toCommunicationMessage(
  message: TeamsGraphMessage,
  channelId: string,
  threadId?: string,
): CommunicationMessage {
  return {
    provider: 'teams',
    id: message.id,
    user: message.author,
    text: message.text,
    channelId,
    ...(threadId ? { threadId } : {}),
    fileCount: message.attachmentCount,
  };
}

const TEAMS_REACTION_EMOJI_BY_NAME: Record<string, string> = {
  eyes: '👀',
  thumbsup: '👍',
  '+1': '👍',
  like: '👍',
  thumbsdown: '👎',
  '-1': '👎',
  heart: '❤️',
  tada: '🎉',
  fire: '🔥',
  clap: '👏',
  laugh: '😆',
  joy: '😆',
  smile: '😄',
  surprised: '😮',
  open_mouth: '😮',
  scream: '😱',
  sad: '😢',
  cry: '😢',
  angry: '😠',
  rage: '😡',
  thinking_face: '🤔',
  ok_hand: '👌',
  pray: '🙏',
  '100': '💯',
  trophy: '🏆',
  handshake: '🤝',
  saluting_face: '🫡',
  white_check_mark: '✅',
  rocket: '🚀',
};

function resolveTeamsReactionEmoji(name: string): string | undefined {
  const normalizedName = name.trim().replace(/^:+|:+$/g, '');
  const mapped = TEAMS_REACTION_EMOJI_BY_NAME[normalizedName];

  if (mapped) {
    return mapped;
  }

  return Object.values(TEAMS_REACTION_EMOJI_BY_NAME).includes(normalizedName)
    ? normalizedName
    : undefined;
}

export type TeamsBotEnvConfig = {
  R_TEAMS_BOT_APP_ID?: string;
  R_TEAMS_BOT_APP_PASSWORD?: string;
  R_TEAMS_BOT_TENANT_ID?: string;
  R_TEAMS_BOT_TOKEN_ENDPOINT?: string;
  R_TEAMS_BOT_OAUTH_SCOPE?: string;
};

export type TeamsCommunicationProviderExtraOptions = Pick<
  TeamsCommunicationProviderOptions,
  'graphTokenProvider' | 'serviceUrl' | 'graphBaseUrl'
>;

/**
 * Builds a `TeamsCommunicationProvider` from Teams bot env configuration, or
 * returns `null` when the required bot credentials are not configured.
 */
export function createTeamsCommunicationProviderFromEnv(
  env: TeamsBotEnvConfig,
  extraOptions?: TeamsCommunicationProviderExtraOptions,
): TeamsCommunicationProvider | null {
  if (!env.R_TEAMS_BOT_APP_ID || !env.R_TEAMS_BOT_APP_PASSWORD) {
    return null;
  }

  return new TeamsCommunicationProvider({
    ...extraOptions,
    appId: env.R_TEAMS_BOT_APP_ID,
    appPassword: env.R_TEAMS_BOT_APP_PASSWORD,
    ...(env.R_TEAMS_BOT_TENANT_ID
      ? {
          tenantId: env.R_TEAMS_BOT_TENANT_ID,
        }
      : {}),
    ...(env.R_TEAMS_BOT_TOKEN_ENDPOINT
      ? { tokenEndpoint: env.R_TEAMS_BOT_TOKEN_ENDPOINT }
      : {}),
    ...(env.R_TEAMS_BOT_OAUTH_SCOPE
      ? { oauthScope: env.R_TEAMS_BOT_OAUTH_SCOPE }
      : {}),
  });
}
