import type { FetchLike } from './teams-bot-framework-client';

export type TeamsGraphClientOptions = {
  /**
   * Returns a Microsoft Graph access token for each request. The default
   * product path exchanges the linked user's Entra refresh token for a
   * delegated Graph token, so history reads run as that user and require no
   * Microsoft protected-API approval.
   */
  getAccessToken: () => Promise<string>;
  baseUrl?: string;
  fetch?: FetchLike;
};

export type TeamsGraphMessageMention = {
  /** AAD object id when the mention targets a user. */
  userId?: string;
  /** Application (bot) id when the mention targets an application. */
  applicationId?: string;
  name?: string;
};

export type TeamsGraphMessage = {
  id: string;
  author: string;
  /** AAD object id of the human author, when Graph reports one. */
  authorUserId?: string;
  /** Application (bot) id of the author for application-authored messages. */
  authorApplicationId?: string;
  text: string;
  createdDateTime?: string;
  attachmentCount: number;
  hostedContentIds: string[];
  mentions: TeamsGraphMessageMention[];
};

export type MicrosoftDelegatedGraphTokenResult = {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds: number;
};

const DEFAULT_GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const DEFAULT_MESSAGE_PAGE_SIZE = 50;
const MAX_MESSAGE_PAGES = 4;

export const DEFAULT_TEAMS_DELEGATED_GRAPH_SCOPES = [
  'https://graph.microsoft.com/ChannelMessage.Read.All',
  'https://graph.microsoft.com/Chat.Read',
  'offline_access',
];

function readStringProperty(
  value: Record<string, unknown>,
  property: string,
): string | undefined {
  const rawValue = value[property];

  return typeof rawValue === 'string' && rawValue.length > 0
    ? rawValue
    : undefined;
}

function readNumberProperty(
  value: Record<string, unknown>,
  property: string,
): number | undefined {
  const rawValue = value[property];

  return typeof rawValue === 'number' && Number.isFinite(rawValue)
    ? rawValue
    : undefined;
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * Converts Graph chatMessage HTML bodies into readable plain text. Graph
 * returns rich HTML for Teams messages; this keeps mentions and line breaks
 * legible without pulling in a full HTML parser.
 */
function stripHtmlTagsRepeatedly(value: string): string {
  let result = value;
  let previous: string;
  do {
    previous = result;
    result = result.replace(/<[^>]*>/g, '');
  } while (result !== previous);
  return result;
}

function decodeHtmlEntitiesOnce(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/gi, (entity) => {
    switch (entity.slice(1, -1).toLowerCase()) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case '#39':
        return "'";
      case 'nbsp':
        return ' ';
      default:
        return entity;
    }
  });
}

export function teamsGraphHtmlToText(content: string): string {
  const withBreaks = content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<at\b[^>]*>([^<]*)<\/at>/gi, '@$1');

  return decodeHtmlEntitiesOnce(stripHtmlTagsRepeatedly(withBreaks))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractTeamsGraphHostedContentIds(content: string): string[] {
  const ids: string[] = [];
  const pattern = /(?:^|[./])hostedContents\/([^/"'<>\s?#]+)\/\$value/gi;

  for (const match of content.matchAll(pattern)) {
    const rawId = match[1];

    if (!rawId) {
      continue;
    }

    try {
      ids.push(decodeURIComponent(rawId));
    } catch {
      ids.push(rawId);
    }
  }

  return Array.from(new Set(ids));
}

function readRecordProperty(
  value: Record<string, unknown>,
  property: string,
): Record<string, unknown> | undefined {
  const rawValue = value[property];

  return rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
    ? (rawValue as Record<string, unknown>)
    : undefined;
}

function parseGraphMessageMentions(raw: unknown): TeamsGraphMessageMention[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const mentions: TeamsGraphMessageMention[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const mentionRecord = entry as Record<string, unknown>;
    const mentioned = readRecordProperty(mentionRecord, 'mentioned');
    const mentionedUser = mentioned
      ? readRecordProperty(mentioned, 'user')
      : undefined;
    const mentionedApplication = mentioned
      ? readRecordProperty(mentioned, 'application')
      : undefined;
    const userId = mentionedUser
      ? readStringProperty(mentionedUser, 'id')
      : undefined;
    const applicationId = mentionedApplication
      ? readStringProperty(mentionedApplication, 'id')
      : undefined;
    const name =
      readStringProperty(mentionRecord, 'mentionText') ??
      (mentionedUser
        ? readStringProperty(mentionedUser, 'displayName')
        : undefined) ??
      (mentionedApplication
        ? readStringProperty(mentionedApplication, 'displayName')
        : undefined);

    if (!userId && !applicationId && !name) {
      continue;
    }

    mentions.push({
      ...(userId ? { userId } : {}),
      ...(applicationId ? { applicationId } : {}),
      ...(name ? { name } : {}),
    });
  }

  return mentions;
}

function parseGraphMessage(raw: unknown): TeamsGraphMessage | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const message = raw as Record<string, unknown>;
  const id = readStringProperty(message, 'id');

  if (!id) {
    return null;
  }

  const from =
    message.from && typeof message.from === 'object'
      ? (message.from as Record<string, unknown>)
      : undefined;
  const fromUser =
    from?.user && typeof from.user === 'object'
      ? (from.user as Record<string, unknown>)
      : undefined;
  const fromApplication =
    from?.application && typeof from.application === 'object'
      ? (from.application as Record<string, unknown>)
      : undefined;
  const author =
    (fromUser ? readStringProperty(fromUser, 'displayName') : undefined) ??
    (fromApplication
      ? readStringProperty(fromApplication, 'displayName')
      : undefined) ??
    'Teams user';
  const authorUserId = fromUser
    ? readStringProperty(fromUser, 'id')
    : undefined;
  const authorApplicationId = fromApplication
    ? readStringProperty(fromApplication, 'id')
    : undefined;
  const body =
    message.body && typeof message.body === 'object'
      ? (message.body as Record<string, unknown>)
      : undefined;
  const rawContent = body ? (readStringProperty(body, 'content') ?? '') : '';
  const contentType = body
    ? readStringProperty(body, 'contentType')
    : undefined;
  const text =
    contentType?.toLowerCase() === 'html'
      ? teamsGraphHtmlToText(rawContent)
      : rawContent.trim();
  const attachments = Array.isArray(message.attachments)
    ? message.attachments
    : [];

  return {
    id,
    author,
    ...(authorUserId ? { authorUserId } : {}),
    ...(authorApplicationId ? { authorApplicationId } : {}),
    text,
    ...(readStringProperty(message, 'createdDateTime')
      ? { createdDateTime: readStringProperty(message, 'createdDateTime') }
      : {}),
    attachmentCount: attachments.length,
    hostedContentIds: extractTeamsGraphHostedContentIds(rawContent),
    mentions: parseGraphMessageMentions(message.mentions),
  };
}

export class TeamsGraphClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(private readonly options: TeamsGraphClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? DEFAULT_GRAPH_BASE_URL).replace(
      /\/$/,
      '',
    );
  }

  async getChannelMessage(input: {
    teamGroupId: string;
    channelId: string;
    messageId: string;
  }): Promise<TeamsGraphMessage | null> {
    const raw = await this.graphGet(
      `/teams/${encodeURIComponent(input.teamGroupId)}/channels/${encodeURIComponent(
        input.channelId,
      )}/messages/${encodeURIComponent(input.messageId)}`,
    );

    return parseGraphMessage(raw);
  }

  async getChannelMessageReply(input: {
    teamGroupId: string;
    channelId: string;
    messageId: string;
    replyId: string;
  }): Promise<TeamsGraphMessage | null> {
    const raw = await this.graphGet(
      `/teams/${encodeURIComponent(input.teamGroupId)}/channels/${encodeURIComponent(
        input.channelId,
      )}/messages/${encodeURIComponent(input.messageId)}/replies/${encodeURIComponent(
        input.replyId,
      )}`,
    );

    return parseGraphMessage(raw);
  }

  async getChatMessage(input: {
    chatId: string;
    messageId: string;
  }): Promise<TeamsGraphMessage | null> {
    const raw = await this.graphGet(
      `/chats/${encodeURIComponent(input.chatId)}/messages/${encodeURIComponent(
        input.messageId,
      )}`,
    );

    return parseGraphMessage(raw);
  }

  async getChannelMessageHostedContentValue(input: {
    teamGroupId: string;
    channelId: string;
    messageId: string;
    hostedContentId: string;
    replyId?: string;
  }): Promise<{ bytes: Buffer; contentType?: string }> {
    const messagePath = `/teams/${encodeURIComponent(
      input.teamGroupId,
    )}/channels/${encodeURIComponent(input.channelId)}/messages/${encodeURIComponent(
      input.messageId,
    )}`;
    const hostedContentPath = input.replyId
      ? `${messagePath}/replies/${encodeURIComponent(
          input.replyId,
        )}/hostedContents/${encodeURIComponent(input.hostedContentId)}/$value`
      : `${messagePath}/hostedContents/${encodeURIComponent(
          input.hostedContentId,
        )}/$value`;

    return this.graphGetBytes(hostedContentPath);
  }

  async getChatMessageHostedContentValue(input: {
    chatId: string;
    messageId: string;
    hostedContentId: string;
  }): Promise<{ bytes: Buffer; contentType?: string }> {
    return this.graphGetBytes(
      `/chats/${encodeURIComponent(input.chatId)}/messages/${encodeURIComponent(
        input.messageId,
      )}/hostedContents/${encodeURIComponent(input.hostedContentId)}/$value`,
    );
  }

  async listChannelMessageReplies(input: {
    teamGroupId: string;
    channelId: string;
    messageId: string;
    top?: number;
  }): Promise<TeamsGraphMessage[]> {
    const raw = await this.graphGet(
      `/teams/${encodeURIComponent(input.teamGroupId)}/channels/${encodeURIComponent(
        input.channelId,
      )}/messages/${encodeURIComponent(input.messageId)}/replies?$top=${
        input.top ?? DEFAULT_MESSAGE_PAGE_SIZE
      }`,
    );

    return this.collectPagedMessages(raw);
  }

  async listChannelMessages(input: {
    teamGroupId: string;
    channelId: string;
    top?: number;
  }): Promise<TeamsGraphMessage[]> {
    const raw = await this.graphGet(
      `/teams/${encodeURIComponent(input.teamGroupId)}/channels/${encodeURIComponent(
        input.channelId,
      )}/messages?$top=${input.top ?? DEFAULT_MESSAGE_PAGE_SIZE}`,
    );

    return this.collectPagedMessages(raw);
  }

  async listChatMessages(input: {
    chatId: string;
    top?: number;
  }): Promise<TeamsGraphMessage[]> {
    const raw = await this.graphGet(
      `/chats/${encodeURIComponent(input.chatId)}/messages?$top=${
        input.top ?? DEFAULT_MESSAGE_PAGE_SIZE
      }`,
    );

    return this.collectPagedMessages(raw);
  }

  private parseGraphMessageList(raw: unknown): TeamsGraphMessage[] {
    if (!raw || typeof raw !== 'object') {
      return [];
    }

    const value = (raw as Record<string, unknown>).value;

    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((entry) => parseGraphMessage(entry))
      .filter((message): message is TeamsGraphMessage => message !== null);
  }

  /**
   * Follows `@odata.nextLink` paging up to a bounded number of pages so long
   * threads are not silently capped at one page of history.
   */
  private async collectPagedMessages(
    raw: unknown,
  ): Promise<TeamsGraphMessage[]> {
    const messages: TeamsGraphMessage[] = [];
    let current: unknown = raw;

    for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
      messages.push(...this.parseGraphMessageList(current));

      const nextLink =
        current && typeof current === 'object'
          ? readStringProperty(
              current as Record<string, unknown>,
              '@odata.nextLink',
            )
          : undefined;

      if (!nextLink || page === MAX_MESSAGE_PAGES - 1) {
        break;
      }

      current = await this.graphGetUrl(nextLink);
    }

    return messages;
  }

  private async graphGet(path: string): Promise<unknown> {
    return this.graphGetUrl(`${this.baseUrl}${path}`);
  }

  private async graphGetUrl(url: string): Promise<unknown> {
    const accessToken = await this.options.getAccessToken();
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const responseBody = await readResponseText(response);
      throw new Error(
        `Teams Graph request ${url} failed with ${response.status}: ${responseBody}`,
      );
    }

    return (await response.json()) as unknown;
  }

  private async graphGetBytes(
    path: string,
  ): Promise<{ bytes: Buffer; contentType?: string }> {
    const accessToken = await this.options.getAccessToken();
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const responseBody = await readResponseText(response);
      throw new Error(
        `Teams Graph request ${this.baseUrl}${path} failed with ${response.status}: ${responseBody}`,
      );
    }

    const contentType =
      response.headers.get('content-type')?.split(';')[0]?.trim() || undefined;

    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      ...(contentType ? { contentType } : {}),
    };
  }
}

/**
 * Exchanges a linked Microsoft user's Entra refresh token for a delegated
 * Microsoft Graph access token. Delegated Graph message reads only require
 * admin-consented delegated permissions on the app registration; they do not
 * require Microsoft's protected-API approval that app-only reads need.
 */
export async function exchangeMicrosoftDelegatedGraphToken(input: {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  refreshToken: string;
  scopes?: string[];
  fetch?: FetchLike;
}): Promise<MicrosoftDelegatedGraphTokenResult> {
  const fetchImpl = input.fetch ?? fetch;
  const tokenEndpoint = `https://login.microsoftonline.com/${input.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
    scope: (input.scopes ?? DEFAULT_TEAMS_DELEGATED_GRAPH_SCOPES).join(' '),
  });
  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    const responseBody = await readResponseText(response);
    throw new Error(
      `Microsoft delegated Graph token exchange failed with ${response.status}: ${responseBody}`,
    );
  }

  const tokenResponse = (await response.json()) as unknown;

  if (!tokenResponse || typeof tokenResponse !== 'object') {
    throw new Error(
      'Microsoft delegated Graph token exchange returned a non-object body.',
    );
  }

  const tokenData = tokenResponse as Record<string, unknown>;
  const accessToken = readStringProperty(tokenData, 'access_token');

  if (!accessToken) {
    throw new Error(
      'Microsoft delegated Graph token response did not include access_token.',
    );
  }

  const refreshToken = readStringProperty(tokenData, 'refresh_token');

  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiresInSeconds: readNumberProperty(tokenData, 'expires_in') ?? 3600,
  };
}
