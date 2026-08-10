import { readBoundedResponseBody } from './bounded-response-body';

export type FetchLike = typeof fetch;

export type TeamsBotFrameworkClientOptions = {
  appId: string;
  appPassword: string;
  tenantId?: string;
  tokenEndpoint?: string;
  oauthScope?: string;
  fetch?: FetchLike;
};

export type TeamsSendActivityInput = {
  serviceUrl: string;
  conversationId: string;
  text?: string;
  textFormat?: 'plain' | 'markdown' | 'xml';
  replyToActivityId?: string;
  channelData?: Record<string, unknown>;
  attachments?: unknown[];
};

export type TeamsSendActivityResult = {
  id: string;
};

export type TeamsUpdateActivityInput = {
  serviceUrl: string;
  conversationId: string;
  activityId: string;
  text: string;
  textFormat?: 'plain' | 'markdown' | 'xml';
  attachments?: unknown[];
};

export type TeamsCreateDirectConversationInput = {
  serviceUrl: string;
  tenantId: string;
  userId: string;
  botName?: string;
};

export type TeamsCreateDirectConversationResult = {
  id: string;
};

export type TeamsDownloadAttachmentInput = {
  contentUrl: string;
  /**
   * Hosts (in addition to the default Bot Framework connector hosts) that are
   * trusted to receive the Bot Framework bearer token. Typically the
   * activity's `serviceUrl` host. Attachment URLs on any other host are
   * downloaded without the `Authorization` header so a crafted attachment
   * cannot exfiltrate the bot token.
   */
  trustedHosts?: string[];
  /**
   * Maximum response size in bytes. Responses whose `content-length` exceeds
   * this, or whose buffered body exceeds this, are rejected.
   */
  maxBytes?: number;
};

export type TeamsDownloadAttachmentResult = {
  bytes: Buffer;
  contentType?: string;
};

type CachedToken = {
  accessToken: string;
  expiresAtMs: number;
};

const DEFAULT_BOT_FRAMEWORK_OAUTH_SCOPE =
  'https://api.botframework.com/.default';
const TOKEN_EXPIRY_SKEW_MS = 60_000;

const DEFAULT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

const TRUSTED_ATTACHMENT_HOST_SUFFIXES = [
  '.botframework.com',
  '.trafficmanager.net',
];

function isTrustedAttachmentHost(
  hostname: string,
  extraTrustedHosts: string[],
): boolean {
  const lower = hostname.toLowerCase();

  if (
    TRUSTED_ATTACHMENT_HOST_SUFFIXES.some(
      (suffix) => lower === suffix.slice(1) || lower.endsWith(suffix),
    )
  ) {
    return true;
  }

  return extraTrustedHosts.some((trusted) => trusted.toLowerCase() === lower);
}

function normalizeServiceUrl(serviceUrl: string): string {
  const url = new URL(serviceUrl);

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Unsupported Teams serviceUrl protocol: ${url.protocol}`);
  }

  url.hash = '';
  url.search = '';

  return url.toString().replace(/\/$/, '');
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value);
}

function getDefaultTokenEndpoint(tenantId?: string): string {
  const tenant = tenantId ?? 'botframework.com';

  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

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
 * Raised when the client-credentials token request itself fails. Carries the
 * raw status and body so callers can turn Entra's `AADSTS…` codes into copy
 * that names the field an operator got wrong.
 */
export class TeamsOAuthTokenError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly responseBody: string | null,
  ) {
    super(message);
    this.name = 'TeamsOAuthTokenError';
  }
}

export class TeamsBotFrameworkClient {
  private readonly fetchImpl: FetchLike;
  private cachedToken: CachedToken | undefined;

  constructor(private readonly options: TeamsBotFrameworkClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async createDirectConversation(
    input: TeamsCreateDirectConversationInput,
  ): Promise<TeamsCreateDirectConversationResult> {
    const accessToken = await this.getAccessToken();
    const serviceUrl = normalizeServiceUrl(input.serviceUrl);
    const response = await this.fetchImpl(`${serviceUrl}/v3/conversations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        bot: {
          id: this.options.appId,
          ...(input.botName ? { name: input.botName } : {}),
        },
        members: [{ id: input.userId }],
        channelData: {
          tenant: {
            id: input.tenantId,
          },
        },
        tenantId: input.tenantId,
      }),
    });

    if (!response.ok) {
      const responseBody = await readResponseText(response);
      throw new Error(
        `Teams createDirectConversation failed with ${response.status}: ${responseBody}`,
      );
    }

    const responseJson = (await response.json()) as unknown;

    if (!responseJson || typeof responseJson !== 'object') {
      throw new Error(
        'Teams createDirectConversation returned a non-object response.',
      );
    }

    const id = readStringProperty(
      responseJson as Record<string, unknown>,
      'id',
    );

    if (!id) {
      throw new Error('Teams createDirectConversation returned no id.');
    }

    return { id };
  }

  async sendActivity(
    input: TeamsSendActivityInput,
  ): Promise<TeamsSendActivityResult> {
    const accessToken = await this.getAccessToken();
    const serviceUrl = normalizeServiceUrl(input.serviceUrl);
    const baseConversationPath = `${serviceUrl}/v3/conversations/${encodePathPart(
      input.conversationId,
    )}/activities`;
    const url = input.replyToActivityId
      ? `${baseConversationPath}/${encodePathPart(input.replyToActivityId)}`
      : baseConversationPath;
    const body = {
      type: 'message',
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.textFormat ? { textFormat: input.textFormat } : {}),
      ...(input.channelData ? { channelData: input.channelData } : {}),
      ...(input.attachments ? { attachments: input.attachments } : {}),
    };
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const responseBody = await readResponseText(response);
      throw new Error(
        `Teams sendActivity failed with ${response.status}: ${responseBody}`,
      );
    }

    const responseJson = (await response.json()) as unknown;

    if (!responseJson || typeof responseJson !== 'object') {
      throw new Error('Teams sendActivity returned a non-object response.');
    }

    const id = readStringProperty(
      responseJson as Record<string, unknown>,
      'id',
    );

    if (!id) {
      throw new Error('Teams sendActivity returned no activity id.');
    }

    return { id };
  }

  /**
   * Fetches Bot Framework team details for a Teams team id. Used to bridge
   * Bot Framework team ids (`19:...`) to the AAD group id that Microsoft
   * Graph channel APIs require.
   */
  async getTeamDetails(input: {
    serviceUrl: string;
    teamId: string;
  }): Promise<{ aadGroupId?: string }> {
    const accessToken = await this.getAccessToken();
    const serviceUrl = normalizeServiceUrl(input.serviceUrl);
    const response = await this.fetchImpl(
      `${serviceUrl}/v3/teams/${encodePathPart(input.teamId)}`,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      const responseBody = await readResponseText(response);
      throw new Error(
        `Teams getTeamDetails failed with ${response.status}: ${responseBody}`,
      );
    }

    const responseJson = (await response.json()) as unknown;

    if (!responseJson || typeof responseJson !== 'object') {
      throw new Error('Teams getTeamDetails returned a non-object response.');
    }

    const aadGroupId = readStringProperty(
      responseJson as Record<string, unknown>,
      'aadGroupId',
    );

    return aadGroupId ? { aadGroupId } : {};
  }

  async updateActivity(input: TeamsUpdateActivityInput): Promise<void> {
    const accessToken = await this.getAccessToken();
    const serviceUrl = normalizeServiceUrl(input.serviceUrl);
    const url = `${serviceUrl}/v3/conversations/${encodePathPart(
      input.conversationId,
    )}/activities/${encodePathPart(input.activityId)}`;
    const response = await this.fetchImpl(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        type: 'message',
        text: input.text,
        ...(input.textFormat ? { textFormat: input.textFormat } : {}),
        ...(input.attachments ? { attachments: input.attachments } : {}),
      }),
    });

    if (!response.ok) {
      const responseBody = await readResponseText(response);
      throw new Error(
        `Teams updateActivity failed with ${response.status}: ${responseBody}`,
      );
    }
  }

  async downloadAttachment(
    input: TeamsDownloadAttachmentInput,
  ): Promise<TeamsDownloadAttachmentResult> {
    const url = new URL(input.contentUrl);

    if (url.protocol !== 'https:') {
      throw new Error(
        `Unsupported Teams attachment URL protocol: ${url.protocol}`,
      );
    }

    const maxBytes = input.maxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES;
    const headers: Record<string, string> = {};

    if (isTrustedAttachmentHost(url.hostname, input.trustedHosts ?? [])) {
      const accessToken = await this.getAccessToken();
      headers.authorization = `Bearer ${accessToken}`;
    }

    const response = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      const responseBody = await readResponseText(response);
      throw new Error(
        `Teams attachment download failed with ${response.status}: ${responseBody}`,
      );
    }

    const contentLengthHeader = response.headers.get('content-length');

    if (contentLengthHeader) {
      const contentLength = Number.parseInt(contentLengthHeader, 10);

      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new Error(
          `Teams attachment download exceeded max size of ${maxBytes} bytes (content-length: ${contentLength})`,
        );
      }
    }

    const bytes = Buffer.from(
      await readBoundedResponseBody(
        response,
        maxBytes,
        `Teams attachment download exceeded max size of ${maxBytes} bytes`,
      ),
    );

    const contentType =
      response.headers.get('content-type')?.split(';')[0]?.trim() || undefined;

    return {
      bytes,
      ...(contentType ? { contentType } : {}),
    };
  }

  /**
   * Runs the client-credentials token request and discards the token. Callers
   * use it to prove the configured app id / secret / tenant actually
   * authenticate instead of assuming that non-empty values are working ones.
   */
  async verifyCredentials(): Promise<void> {
    await this.getAccessToken();
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();

    if (this.cachedToken && this.cachedToken.expiresAtMs > now) {
      return this.cachedToken.accessToken;
    }

    const tokenEndpoint =
      this.options.tokenEndpoint ??
      getDefaultTokenEndpoint(this.options.tenantId);
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.options.appId,
      client_secret: this.options.appPassword,
      scope: this.options.oauthScope ?? DEFAULT_BOT_FRAMEWORK_OAUTH_SCOPE,
    });
    const response = await this.fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!response.ok) {
      const responseBody = await readResponseText(response);
      throw new TeamsOAuthTokenError(
        `Teams OAuth token request failed with ${response.status}: ${responseBody}`,
        response.status,
        responseBody,
      );
    }

    const tokenResponse = (await response.json()) as unknown;

    if (!tokenResponse || typeof tokenResponse !== 'object') {
      throw new TeamsOAuthTokenError(
        'Teams OAuth token request returned a non-object body.',
        null,
        null,
      );
    }

    const tokenData = tokenResponse as Record<string, unknown>;
    const accessToken = readStringProperty(tokenData, 'access_token');

    if (!accessToken) {
      throw new TeamsOAuthTokenError(
        'Teams OAuth token response did not include access_token.',
        null,
        null,
      );
    }

    const expiresInSeconds =
      readNumberProperty(tokenData, 'expires_in') ?? 3600;
    this.cachedToken = {
      accessToken,
      expiresAtMs: now + expiresInSeconds * 1000 - TOKEN_EXPIRY_SKEW_MS,
    };

    return this.cachedToken.accessToken;
  }
}
