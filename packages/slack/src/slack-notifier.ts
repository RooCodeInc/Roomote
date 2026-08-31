import type {
  SlackChannelMessage,
  SlackConversationMessage,
  SlackMessage,
  SlackMessageMetadata,
  SlackPostMessageResult,
  SlackResponse,
  SlackFile,
  SlackThreadMessage,
  SlackUserInfo,
  WorkObjectUnfurl,
  WorkObjectMetadata,
  WorkObjectMetadataEntity,
} from './types';
import { WebClient } from '@slack/web-api';
import type { WebAPIPlatformError } from '@slack/web-api';
import { convertSlackLinksToMarkdown } from './markdown-converter';
import { logSlackError, slackDebug } from './logging';
import { SlackChannelDiscovery } from './slack-channel-discovery';
import { buildSlackApiUrl } from './slack-api-base-url';
import {
  fetchSlackGetJson,
  getSlackRetryAfterMs,
  slackFetch,
  SLACK_DOWNLOAD_TIMEOUT_MS,
} from './slack-api-fetch';
import type {
  SlackChannelInfo,
  SlackChannelInfoCache,
} from './slack-channel-info-cache';
import { isSlackImageFile } from './thread-image-utils';
import { createSlackWebClient } from './web-client';
import {
  appendSlackAttachmentContext,
  appendSlackForwardedMessageFiles,
  formatSlackAttachmentContext,
} from './forwarded-message-context';

type SlackApiThreadMessage = {
  user?: string;
  username?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  type: string;
  reply_count?: number;
  latest_reply?: string;
  blocks?: unknown[];
  attachments?: unknown[];
  files?: SlackFile[];
  bot_profile?: {
    name?: string;
  };
};

export type SlackAgentSessionRenameResult =
  | { ok: true }
  | { ok: false; error?: string };

function getSlackPlatformError(error: unknown): string | undefined {
  const platformError = error as Partial<WebAPIPlatformError>;
  return platformError?.code === 'slack_webapi_platform_error' &&
    typeof platformError.data?.error === 'string'
    ? platformError.data.error
    : undefined;
}

type SlackApiThreadResponse = {
  ok: boolean;
  messages: SlackApiThreadMessage[];
  has_more: boolean;
  error?: string;
  response_metadata?: {
    next_cursor?: string;
  };
};

type SlackAuthTestResponse = {
  ok: boolean;
  error?: string;
  user_id?: string;
  bot_id?: string;
};

type SlackUsersListResponse = {
  ok: boolean;
  error?: string;
  members?: Array<{
    id?: string;
    deleted?: boolean;
    is_bot?: boolean;
  }>;
  response_metadata?: {
    next_cursor?: string;
  };
};

/** Status values accepted by a Slack `task_card` block. */
export type SlackTaskStreamStatus =
  | 'pending'
  | 'in_progress'
  | 'complete'
  | 'error';

const SLACK_USERS_LIST_LIMIT = 999;
const MAX_SLACK_CONVERSATIONS_REPLIES_RATE_LIMIT_RETRIES = 3;
const MAX_SLACK_UPDATE_RETRIES = 2;
const SLACK_UPDATE_RETRY_DELAY_MS = 250;
const MAX_SLACK_UPDATE_RATE_LIMIT_WAIT_MS = 5_000;

const SLACK_UPDATE_STALE_TARGET_ERRORS = new Set([
  'file_deleted',
  'file_is_deleted',
  'message_not_found',
]);
const SLACK_UPDATE_AUTHORIZATION_ERRORS = new Set([
  'access_denied',
  'account_inactive',
  'invalid_auth',
  'missing_scope',
  'no_permission',
  'not_allowed_token_type',
  'not_authed',
  'team_access_not_granted',
  'token_expired',
  'token_revoked',
]);
const SLACK_UPDATE_TRANSIENT_ERRORS = new Set([
  'edit_conflict',
  'external_channel_migrating',
  'fatal_error',
  'internal_error',
  'ratelimited',
  'request_timeout',
  'service_unavailable',
  'streaming_state_conflict',
  'team_added_to_org',
  'update_failed',
]);

const SUGGESTION_REACTION_START_NOTICE_REGEX =
  /\n\n(?:Started by <@[^>\s]+>(?: via :thumbsup:)?\.|Accepted by <@[^>\s]+>)\s*$/;
const MAX_OLDEST_BOUNDED_CHANNEL_HISTORY_PAGES = 25;

function stripSuggestionReactionStartNotice(text: string): string {
  return text.replace(SUGGESTION_REACTION_START_NOTICE_REGEX, '');
}

function isOwnBotMessage(
  message: SlackApiThreadMessage,
  ownBotIdentity?: {
    userId?: string;
    botId?: string;
  } | null,
): boolean {
  const ownBotId = ownBotIdentity?.botId;
  const ownBotUserId = ownBotIdentity?.userId;

  return (
    (Boolean(ownBotId) && message.bot_id === ownBotId) ||
    (Boolean(ownBotUserId) && message.user === ownBotUserId)
  );
}

function parseSlackTimestamp(value?: string): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldExpandThreadRoot(params: {
  message: SlackApiThreadMessage;
  oldestTs: number | null;
}): boolean {
  const { message, oldestTs } = params;

  if (
    typeof message.ts !== 'string' ||
    typeof message.reply_count !== 'number' ||
    message.reply_count <= 0
  ) {
    return false;
  }

  if (oldestTs === null) {
    return true;
  }

  const rootTs = parseSlackTimestamp(message.ts);
  if (rootTs !== null && rootTs >= oldestTs) {
    return true;
  }

  const latestReplyTs = parseSlackTimestamp(message.latest_reply);
  if (latestReplyTs === null) {
    return true;
  }

  return latestReplyTs >= oldestTs;
}

function normalizeOutboundMessage<T extends object & SlackMessage>(
  message: T,
): T {
  if (!Array.isArray(message.blocks) || message.blocks.length === 0) {
    return message;
  }

  return {
    ...message,
    unfurl_links: false,
    unfurl_media: false,
  };
}

type SlackChannelInfoContext = {
  /** Log prefix, kept per public method so log lines stay recognizable. */
  name: string;
  transportFailureLabel: string;
};

export class SlackNotifier {
  private readonly token: string;
  private readonly channelInfoCache: SlackChannelInfoCache | null;
  private client?: WebClient;
  private channelDiscovery?: SlackChannelDiscovery;
  private ownBotIdentityPromise?: Promise<{
    userId?: string;
    botId?: string;
  } | null>;

  constructor(
    token: string,
    options: { channelInfoCache?: SlackChannelInfoCache } = {},
  ) {
    this.token = token;
    this.channelInfoCache = options.channelInfoCache ?? null;
  }

  private getClient(): WebClient {
    if (!this.client) {
      this.client = createSlackWebClient(this.token);
    }

    return this.client;
  }

  public async setAgentSessionStatus({
    channel,
    threadTs,
    status,
    title,
  }: {
    channel: string;
    threadTs: string;
    status: 'active' | 'processing' | 'suspended' | 'closed';
    title?: string;
  }): Promise<{ ok: boolean; title?: string }> {
    try {
      const response = await this.getClient().apiCall(
        'agents.sessions.setStatus',
        {
          channel_id: channel,
          thread_ts: threadTs,
          status,
          ...(title ? { title } : {}),
        },
      );
      if (response.ok) {
        const responseTitle = (response as { title?: unknown }).title;
        return {
          ok: true,
          ...(typeof responseTitle === 'string'
            ? { title: responseTitle }
            : {}),
        };
      }

      console.warn(
        `[setAgentSessionStatus] Slack rejected status=${status} channel=${channel} thread=${threadTs} error=${response.error ?? 'unknown_error'}`,
      );
      return { ok: false };
    } catch (error) {
      console.warn(
        `[setAgentSessionStatus] Slack status=${status} failed for channel=${channel} thread=${threadTs}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ok: false };
    }
  }

  public async renameAgentSession({
    channel,
    threadTs,
    title,
  }: {
    channel: string;
    threadTs: string;
    title: string;
  }): Promise<SlackAgentSessionRenameResult> {
    try {
      const response = await this.getClient().apiCall(
        'agents.sessions.rename',
        {
          channel_id: channel,
          thread_ts: threadTs,
          title,
        },
      );
      if (response.ok) return { ok: true };

      const responseError =
        typeof response.error === 'string' ? response.error : undefined;
      console.warn(
        `[renameAgentSession] Slack rejected channel=${channel} thread=${threadTs} error=${responseError ?? 'unknown_error'}`,
      );
      return { ok: false, ...(responseError ? { error: responseError } : {}) };
    } catch (error) {
      const platformError = getSlackPlatformError(error);
      console.warn(
        `[renameAgentSession] Slack rename failed for channel=${channel} thread=${threadTs}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        ok: false,
        ...(platformError ? { error: platformError } : {}),
      };
    }
  }

  private getChannelDiscovery(): SlackChannelDiscovery {
    if (!this.channelDiscovery) {
      this.channelDiscovery = new SlackChannelDiscovery(this.token);
    }

    return this.channelDiscovery;
  }

  private async getOwnBotIdentity(): Promise<{
    userId?: string;
    botId?: string;
  } | null> {
    if (!this.ownBotIdentityPromise) {
      this.ownBotIdentityPromise = (async () => {
        try {
          const response = await slackFetch(buildSlackApiUrl('auth.test'), {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.token}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          });

          if (!response.ok) {
            console.error(
              `[getOwnBotIdentity] Slack auth.test failed: ${response.status} ${response.statusText}`,
            );
            return null;
          }

          const result: SlackAuthTestResponse = await response.json();

          if (!result.ok) {
            console.error(
              `[getOwnBotIdentity] Slack auth.test error: ${result.error || 'Unknown error'}`,
            );
            return null;
          }

          if (!result.user_id && !result.bot_id) {
            return null;
          }

          return {
            userId: result.user_id,
            botId: result.bot_id,
          };
        } catch (error) {
          console.error(
            `[getOwnBotIdentity] Failed to fetch Slack bot identity: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }
      })();
    }

    const ownBotIdentity = await this.ownBotIdentityPromise;

    if (!ownBotIdentity) {
      this.ownBotIdentityPromise = undefined;
    }

    return ownBotIdentity;
  }

  private async normalizeFetchedMessages(
    messages: SlackApiThreadMessage[],
    options: {
      excludeOwnBot?: boolean;
    } = {},
  ): Promise<SlackChannelMessage[]> {
    const needsOwnBotId =
      options.excludeOwnBot ||
      messages.some((msg) =>
        SUGGESTION_REACTION_START_NOTICE_REGEX.test(msg.text ?? ''),
      );
    const ownBotIdentity = needsOwnBotId
      ? await this.getOwnBotIdentity()
      : null;

    const normalizedInput = messages
      .map((msg) => {
        const textWithoutSuggestionNotice = isOwnBotMessage(msg, ownBotIdentity)
          ? stripSuggestionReactionStartNotice(msg.text ?? '')
          : (msg.text ?? '');

        return {
          ...msg,
          authoredText: textWithoutSuggestionNotice,
          text: appendSlackAttachmentContext(
            textWithoutSuggestionNotice,
            msg.attachments,
            msg.blocks,
          ),
          files: appendSlackForwardedMessageFiles(
            Array.isArray(msg.files) ? msg.files : undefined,
            msg.attachments,
          ),
        };
      })
      .filter(
        (msg) =>
          msg.ts &&
          (msg.user || msg.bot_id) &&
          (msg.text.length > 0 || Boolean(msg.files?.length)),
      );

    const filteredMessages =
      options.excludeOwnBot && ownBotIdentity
        ? normalizedInput.filter((msg) => !isOwnBotMessage(msg, ownBotIdentity))
        : normalizedInput;

    const userIds = filteredMessages.flatMap((msg) =>
      !msg.bot_id && msg.user ? [msg.user] : [],
    );

    const usernameMap =
      userIds.length > 0
        ? await this.getUsersInfo(userIds)
        : new Map<string, string>();

    return filteredMessages.map((msg) => ({
      user: msg.user ?? msg.bot_id ?? 'unknown-bot',
      username: msg.bot_id
        ? msg.username?.trim() || msg.bot_profile?.name?.trim() || undefined
        : msg.user
          ? usernameMap.get(msg.user)
          : undefined,
      text: msg.text,
      ts: msg.ts,
      ...(typeof msg.thread_ts === 'string'
        ? { thread_ts: msg.thread_ts }
        : {}),
      bot_id: msg.bot_id,
      type: msg.type,
      ...(msg.blocks ? { blocks: msg.blocks } : {}),
      ...(msg.attachments ? { attachments: msg.attachments } : {}),
      ...(msg.files ? { files: msg.files } : {}),
    }));
  }

  /**
   * Lists public channels visible to the bot, returning id + name pairs.
   * Paginates automatically through the full list.
   */
  public async listPublicChannels(): Promise<
    Array<{
      id: string;
      name: string;
      isPrivate: boolean;
      isMember: boolean | null;
    }>
  > {
    return this.getChannelDiscovery().listPublicChannels();
  }

  /**
   * Lists public and private channels visible to the bot, returning id + name
   * pairs. Paginates automatically through the full list.
   */
  public async listAccessibleChannels(): Promise<
    Array<{
      id: string;
      name: string;
      isPrivate: boolean;
      isMember: boolean | null;
    }>
  > {
    return this.getChannelDiscovery().listAccessibleChannels();
  }

  /**
   * Resolves a channel input into a Slack channel ID.
   *
   * - If input is already a channel ID, returns it unchanged.
   * - If input starts with '#', resolves by channel name via conversations.list.
   * - Returns null when the channel cannot be resolved.
   */
  public async resolveChannelId(input: string): Promise<string | null> {
    return this.getChannelDiscovery().resolveChannelId(input);
  }

  /**
   * Fetches the `conversations.info` projection for a channel once, going
   * through the caller-supplied cache when there is one.
   */
  private async getChannelInfo(
    channelId: string,
    context: SlackChannelInfoContext,
  ): Promise<SlackChannelInfo | null> {
    const load = () => this.loadChannelInfo(channelId, context);

    return this.channelInfoCache
      ? this.channelInfoCache.resolve(channelId, load)
      : load();
  }

  private async loadChannelInfo(
    channelId: string,
    context: SlackChannelInfoContext,
  ): Promise<SlackChannelInfo | null> {
    try {
      const params = new URLSearchParams({ channel: channelId });
      const response = await slackFetch(
        `${buildSlackApiUrl('conversations.info')}?${params.toString()}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      if (!response.ok) {
        console.error(
          `[${context.name}] Slack conversations.info failed: ${response.status} ${response.statusText}`,
        );
        return null;
      }

      const result = (await response.json()) as {
        ok: boolean;
        error?: string;
        channel?: {
          name?: string | null;
          is_member?: boolean;
          is_private?: boolean;
        };
      };

      if (!result.ok) {
        if (
          result.error === 'channel_not_found' ||
          result.error === 'not_in_channel'
        ) {
          return {
            name: null,
            isMember: false,
            isPrivate: null,
            notFound: true,
          };
        }

        console.error(
          `[${context.name}] Slack conversations.info error: ${result.error ?? 'unknown_error'}`,
        );
        return null;
      }

      return {
        name: result.channel?.name?.trim() || null,
        isMember:
          typeof result.channel?.is_member === 'boolean'
            ? result.channel.is_member
            : null,
        isPrivate:
          typeof result.channel?.is_private === 'boolean'
            ? result.channel.is_private
            : null,
        notFound: false,
      };
    } catch (error) {
      console.error(
        `[${context.name}] ${context.transportFailureLabel}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Returns whether the Slack app is a member of the given channel.
   *
   * - `true` when the app is already in the channel
   * - `false` when Slack reports the app is not in the channel
   * - `null` when the membership state could not be determined
   */
  public async isAppInChannel(channelId: string): Promise<boolean | null> {
    const trimmed = channelId.trim();

    if (!trimmed) {
      return null;
    }

    const info = await this.getChannelInfo(trimmed, {
      name: 'isAppInChannel',
      transportFailureLabel: 'Failed to inspect channel membership',
    });

    if (!info) {
      return null;
    }

    return info.notFound ? false : info.isMember;
  }

  /**
   * Returns whether the given channel is public.
   *
   * - `true` when Slack confirms the channel is public
   * - `false` when Slack confirms the channel is private
   * - `null` when the channel visibility could not be determined
   */
  public async isPublicChannel(channelId: string): Promise<boolean | null> {
    const trimmed = channelId.trim();

    if (!trimmed) {
      return null;
    }

    const info = await this.getChannelInfo(trimmed, {
      name: 'isPublicChannel',
      transportFailureLabel: 'Failed to inspect channel visibility',
    });

    if (!info || info.isPrivate === null) {
      return null;
    }

    return !info.isPrivate;
  }

  /**
   * Returns the human-readable Slack channel name for a channel ID.
   */
  public async getChannelName(channelId: string): Promise<string | null> {
    const trimmed = channelId.trim();

    if (!trimmed) {
      return null;
    }

    const info = await this.getChannelInfo(trimmed, {
      name: 'getChannelName',
      transportFailureLabel: 'Failed to inspect channel name',
    });

    return info?.name ?? null;
  }

  public async getMessagePermalink(params: {
    channel: string;
    messageTs: string;
  }): Promise<string | null> {
    const channel = params.channel.trim();
    const messageTs = params.messageTs.trim();

    if (!channel || !messageTs) {
      return null;
    }

    try {
      const searchParams = new URLSearchParams({
        channel,
        message_ts: messageTs,
      });
      const response = await slackFetch(
        `${buildSlackApiUrl('chat.getPermalink')}?${searchParams.toString()}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      if (!response.ok) {
        console.error(
          `[getMessagePermalink] Slack chat.getPermalink failed: ${response.status} ${response.statusText}`,
        );
        return null;
      }

      const result = (await response.json()) as {
        ok: boolean;
        error?: string;
        permalink?: string;
      };

      if (!result.ok) {
        console.error(
          `[getMessagePermalink] Slack chat.getPermalink error: ${result.error ?? 'unknown_error'}`,
        );
        return null;
      }

      return typeof result.permalink === 'string' &&
        result.permalink.trim().length > 0
        ? result.permalink
        : null;
    } catch (error) {
      console.error(
        `[getMessagePermalink] Failed to fetch Slack permalink: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Returns whether the given Slack user is a member of the provided channel.
   *
   * - `true` when the user appears in the channel member list
   * - `false` when Slack confirms the user is not a member or the app cannot access the channel
   * - `null` when membership could not be determined
   */
  public async isUserInChannel({
    channelId,
    userId,
  }: {
    channelId: string;
    userId: string;
  }): Promise<boolean | null> {
    const trimmedChannelId = channelId.trim();
    const trimmedUserId = userId.trim();

    if (!trimmedChannelId || !trimmedUserId) {
      return null;
    }

    let cursor: string | undefined;

    try {
      do {
        const params = new URLSearchParams({
          channel: trimmedChannelId,
          limit: '200',
        });

        if (cursor) {
          params.set('cursor', cursor);
        }

        const response = await slackFetch(
          `${buildSlackApiUrl('conversations.members')}?${params.toString()}`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${this.token}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          },
        );

        if (!response.ok) {
          console.error(
            `[isUserInChannel] Slack conversations.members failed: ${response.status} ${response.statusText}`,
          );
          return null;
        }

        const result = (await response.json()) as {
          ok: boolean;
          error?: string;
          members?: string[];
          response_metadata?: { next_cursor?: string };
        };

        if (!result.ok) {
          if (
            result.error === 'channel_not_found' ||
            result.error === 'not_in_channel'
          ) {
            return false;
          }

          console.error(
            `[isUserInChannel] Slack conversations.members error: ${result.error ?? 'unknown_error'}`,
          );
          return null;
        }

        if (result.members?.includes(trimmedUserId)) {
          return true;
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      return false;
    } catch (error) {
      console.error(
        `[isUserInChannel] Failed to inspect user membership: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Fetches the Slack workspace timezone (for scheduler timezone alignment).
   */
  public async getWorkspaceTimezone(): Promise<string | null> {
    try {
      const response = await slackFetch(buildSlackApiUrl('team.info'), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      if (!response.ok) {
        console.error(
          `[getWorkspaceTimezone] Slack team.info failed: ${response.status} ${response.statusText}`,
        );
        return null;
      }

      const result = (await response.json()) as {
        ok: boolean;
        error?: string;
        team?: { tz?: string | null };
      };

      if (!result.ok) {
        console.error(
          `[getWorkspaceTimezone] Slack team.info error: ${result.error ?? 'unknown_error'}`,
        );
        return null;
      }

      return result.team?.tz?.trim() || null;
    } catch (error) {
      console.error(
        `[getWorkspaceTimezone] Failed to fetch workspace timezone: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Fetches a rough count of active human members in the Slack workspace.
   */
  public async getWorkspaceMemberCount(): Promise<number | null> {
    try {
      let cursor: string | undefined;
      let totalMembers = 0;

      do {
        const query = new URLSearchParams({
          limit: String(SLACK_USERS_LIST_LIMIT),
        });
        if (cursor) {
          query.set('cursor', cursor);
        }

        const result = await fetchSlackGetJson<SlackUsersListResponse>({
          token: this.token,
          endpoint: 'users.list',
          context: 'getWorkspaceMemberCount',
          query,
          maxRateLimitRetries: 3,
        });

        if (!result) {
          return null;
        }

        totalMembers +=
          result.members?.filter(
            (member) =>
              !member.deleted && !member.is_bot && member.id !== 'USLACKBOT',
          ).length ?? 0;

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      return totalMembers;
    } catch (error) {
      console.error(
        `[getWorkspaceMemberCount] Failed to fetch workspace members: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Opens or retrieves a direct message channel with a Slack user.
   * Returns the channel ID or null on failure. Requires the app to have
   * the `im:write` scope when calling conversations.open.
   */
  public async openConversation(userId: string): Promise<string | null> {
    try {
      const response = await slackFetch(
        buildSlackApiUrl('conversations.open'),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify({ users: userId }),
        },
      );

      if (!response.ok) {
        console.error(
          `[openConversation] Slack API failed: ${response.status} ${response.statusText}`,
        );

        return null;
      }

      const result: {
        ok: boolean;
        error?: string;
        channel?: { id?: string };
      } = await response.json();

      if (!result.ok) {
        console.error(`[openConversation] Slack error: ${result.error}`);
        return null;
      }

      return result.channel?.id ?? null;
    } catch (error) {
      console.error(
        `[openConversation] Failed to open conversation: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }
  }

  /** Returns the Slack user in a one-to-one DM, or null for other channels. */
  public async getDirectMessageUserId(
    channelId: string,
  ): Promise<string | null> {
    try {
      const params = new URLSearchParams({ channel: channelId });
      const response = await slackFetch(
        `${buildSlackApiUrl('conversations.info')}?${params.toString()}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      if (!response.ok) return null;

      const result = (await response.json()) as {
        ok: boolean;
        channel?: { is_im?: boolean; user?: string };
      };
      return result.ok && result.channel?.is_im === true
        ? (result.channel.user ?? null)
        : null;
    } catch {
      return null;
    }
  }

  private async sendMessage(
    endpoint: 'chat.postMessage' | 'chat.postEphemeral',
    message: SlackMessage & { user?: string },
    messageType: 'regular' | 'ephemeral',
  ): Promise<SlackResponse | null> {
    const normalizedMessage = normalizeOutboundMessage(message);

    try {
      const response = await slackFetch(buildSlackApiUrl(endpoint), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(normalizedMessage),
      });

      if (!response.ok) {
        console.error(
          `[sendMessage] Slack ${endpoint} failed: ${response.status} ${response.statusText}: ${JSON.stringify(normalizedMessage)}`,
        );

        return null;
      }

      const result: SlackResponse = await response.json();

      if (!result.ok) {
        console.error(
          `[sendMessage] Slack ${endpoint} error: ${result.error} - ${JSON.stringify(result)} - ${JSON.stringify(normalizedMessage)}`,
        );
      }

      return result;
    } catch (error) {
      console.error(
        `[sendMessage] Failed to send ${messageType} Slack message: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }
  }

  public async postMessage(message: SlackMessage) {
    return (await this.postMessageDetailed(message)).ts;
  }

  /**
   * Like postMessage, but preserves why a post produced no timestamp: the
   * Slack API error code, a transport failure, or a skipped reply into a
   * deleted thread. Callers that report failures to an agent or decide
   * retryability must use this instead of inferring from a missing ts.
   */
  public async postMessageDetailed(
    message: SlackMessage,
  ): Promise<SlackPostMessageResult> {
    if (message.channel && message.thread_ts) {
      const threadRootExists = await this.hasMessageInThread({
        channel: message.channel,
        threadTs: message.thread_ts,
        messageTs: message.thread_ts,
      });

      if (threadRootExists === false) {
        console.warn(
          `[postMessage] Skipping threaded Slack reply because thread root ${message.thread_ts} is no longer available in channel ${message.channel}`,
        );
        return { skippedMissingThreadRoot: true };
      }
    }

    const response = await this.sendMessage(
      'chat.postMessage',
      message,
      'regular',
    );

    if (!response) {
      return { transportError: true };
    }

    if (!response.ok || !response.ts) {
      return { slackErrorCode: response.error ?? 'unknown_error' };
    }

    return { ts: response.ts };
  }

  public async postEphemeralMessage(message: SlackMessage & { user: string }) {
    const response = await this.sendMessage(
      'chat.postEphemeral',
      message,
      'ephemeral',
    );

    return response?.message_ts;
  }

  public async updateMessage({
    channel,
    ts,
    message: rest,
  }: {
    channel?: string;
    ts: string;
    message: SlackMessage;
  }): Promise<boolean> {
    const message = normalizeOutboundMessage({ channel, ts, ...rest });

    for (let attempt = 0; attempt <= MAX_SLACK_UPDATE_RETRIES; attempt += 1) {
      try {
        const response = await slackFetch(buildSlackApiUrl('chat.update'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify(message),
        });

        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          const reason =
            response.status === 401 || response.status === 403
              ? 'authorization'
              : retryable
                ? 'transport'
                : 'request';

          if (retryable && attempt < MAX_SLACK_UPDATE_RETRIES) {
            const retryAfterMs =
              response.status === 429
                ? Math.min(
                    getSlackRetryAfterMs(response.headers.get('Retry-After')),
                    MAX_SLACK_UPDATE_RATE_LIMIT_WAIT_MS,
                  )
                : SLACK_UPDATE_RETRY_DELAY_MS * 2 ** attempt;
            console.warn(
              `[updateMessage] Slack chat.update retry reason=${reason} status=${response.status} channel=${channel ?? 'unknown'} ts=${ts} attempt=${attempt + 1}`,
            );
            await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
            continue;
          }

          console.error(
            `[updateMessage] Slack chat.update failed reason=${reason} status=${response.status} channel=${channel ?? 'unknown'} ts=${ts} retryable=${retryable}`,
          );
          return false;
        }

        const result: SlackResponse = await response.json();

        if (result.ok) {
          return true;
        }

        const code = result.error ?? 'unknown_error';
        const reason = SLACK_UPDATE_STALE_TARGET_ERRORS.has(code)
          ? 'stale_target'
          : code === 'cant_update_message'
            ? 'ownership'
            : SLACK_UPDATE_AUTHORIZATION_ERRORS.has(code)
              ? 'authorization'
              : SLACK_UPDATE_TRANSIENT_ERRORS.has(code)
                ? 'transient'
                : 'request';
        const retryable = reason === 'transient';

        if (retryable && attempt < MAX_SLACK_UPDATE_RETRIES) {
          console.warn(
            `[updateMessage] Slack chat.update retry reason=${reason} code=${code} channel=${channel ?? 'unknown'} ts=${ts} attempt=${attempt + 1}`,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, SLACK_UPDATE_RETRY_DELAY_MS * 2 ** attempt),
          );
          continue;
        }

        const log = reason === 'stale_target' ? console.warn : console.error;
        log(
          `[updateMessage] Slack chat.update rejected reason=${reason} code=${code} channel=${channel ?? 'unknown'} ts=${ts} retryable=${retryable}`,
        );
        return false;
      } catch (error) {
        if (attempt < MAX_SLACK_UPDATE_RETRIES) {
          console.warn(
            `[updateMessage] Slack chat.update retry reason=transport channel=${channel ?? 'unknown'} ts=${ts} attempt=${attempt + 1}`,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, SLACK_UPDATE_RETRY_DELAY_MS * 2 ** attempt),
          );
          continue;
        }

        console.error(
          `[updateMessage] Slack chat.update failed reason=transport channel=${channel ?? 'unknown'} ts=${ts} retryable=true error=${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
    }

    return false;
  }

  public async hasMessageInThread({
    channel,
    threadTs,
    messageTs,
  }: {
    channel: string;
    threadTs: string;
    messageTs: string;
  }): Promise<boolean | null> {
    try {
      const query = new URLSearchParams({
        channel,
        ts: threadTs,
        oldest: messageTs,
        latest: messageTs,
        inclusive: 'true',
      });
      let retryCount = 0;
      let result: {
        ok: boolean;
        error?: string;
        messages?: Array<{ ts: string }>;
      };

      while (true) {
        const response = await slackFetch(
          `${buildSlackApiUrl('conversations.replies')}?${query.toString()}`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${this.token}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          },
        );

        if (response.status === 429) {
          if (
            retryCount >= MAX_SLACK_CONVERSATIONS_REPLIES_RATE_LIMIT_RETRIES
          ) {
            console.error(
              `[hasMessageInThread] Slack conversations.replies exhausted ${MAX_SLACK_CONVERSATIONS_REPLIES_RATE_LIMIT_RETRIES} rate-limit retries`,
            );
            return null;
          }

          retryCount += 1;
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              getSlackRetryAfterMs(response.headers.get('Retry-After')),
            ),
          );
          continue;
        }

        if (!response.ok) {
          console.error(
            `[hasMessageInThread] Slack API failed: ${response.status} ${response.statusText}`,
          );
          return null;
        }

        result = (await response.json()) as typeof result;
        break;
      }

      if (!result.ok) {
        if (
          result.error === 'message_not_found' ||
          result.error === 'thread_not_found'
        ) {
          return false;
        }

        console.error(
          `[hasMessageInThread] Slack error: ${result.error || 'Unknown error'}`,
        );
        return null;
      }

      if (!Array.isArray(result.messages)) {
        console.error(
          '[hasMessageInThread] Slack returned no messages array for conversations.replies',
        );
        return null;
      }

      return result.messages.some((message) => message.ts === messageTs);
    } catch (error) {
      console.error(
        `[hasMessageInThread] Failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Fetches a single message by its timestamp and returns its blocks.
   * Uses conversations.replies to find thread replies (the started message
   * is always posted as a thread reply with thread_ts).
   */
  public async getMessageBlocks({
    channel,
    messageTs,
    threadTs,
  }: {
    channel: string;
    messageTs: string;
    threadTs: string;
  }): Promise<unknown[] | null> {
    try {
      const response = await slackFetch(
        `${buildSlackApiUrl('conversations.replies')}?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}&oldest=${encodeURIComponent(messageTs)}&latest=${encodeURIComponent(messageTs)}&inclusive=true`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      if (!response.ok) {
        console.error(
          `[fetchMessageBlocks] Slack API failed: ${response.status} ${response.statusText}`,
        );
        return null;
      }

      const result = (await response.json()) as {
        ok: boolean;
        error?: string;
        messages?: Array<{
          ts: string;
          blocks?: Array<{
            type: string;
            text?: { type: string; text: string };
            elements?: Array<{
              type: string;
              text?: string;
              action_id?: string;
            }>;
          }>;
        }>;
      };

      if (!result.ok || !result.messages) {
        console.error(
          `[fetchMessageBlocks] Slack error: ${result.error || 'No messages returned'}`,
        );
        return null;
      }

      // conversations.replies always includes the thread parent as the first
      // message, so we must find the target reply by its timestamp.
      const targetMsg = result.messages.find((m) => m.ts === messageTs);

      if (!targetMsg) {
        console.error(
          `[fetchMessageBlocks] Message ${messageTs} not found in thread ${threadTs}`,
        );
        return null;
      }

      return targetMsg.blocks ?? [];
    } catch (error) {
      console.error(
        `[fetchMessageBlocks] Failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Returns the editable content of one message only when it was authored by
   * this notifier's bot identity. Slack rejects chat.update for other authors.
   */
  public async getOwnMessageContent({
    channel,
    messageTs,
    threadTs,
  }: {
    channel: string;
    messageTs: string;
    threadTs: string;
  }): Promise<{ text?: string; blocks: unknown[] } | null> {
    try {
      const [response, ownBotIdentity] = await Promise.all([
        slackFetch(
          `${buildSlackApiUrl('conversations.replies')}?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}&oldest=${encodeURIComponent(messageTs)}&latest=${encodeURIComponent(messageTs)}&inclusive=true`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${this.token}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          },
        ),
        this.getOwnBotIdentity(),
      ]);

      if (!response.ok || !ownBotIdentity) {
        return null;
      }

      const result = (await response.json()) as SlackApiThreadResponse;
      const targetMessage = result.ok
        ? result.messages?.find((message) => message.ts === messageTs)
        : undefined;

      if (!targetMessage || !isOwnBotMessage(targetMessage, ownBotIdentity)) {
        return null;
      }

      return {
        ...(typeof targetMessage.text === 'string'
          ? { text: targetMessage.text }
          : {}),
        blocks: targetMessage.blocks ?? [],
      };
    } catch (error) {
      console.error(
        `[getOwnMessageContent] Failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Fetches message metadata for a single message timestamp in a channel.
   * Uses conversations.history with include_all_metadata to retrieve hidden
   * app metadata (when present).
   */
  public async getMessageMetadata({
    channel,
    messageTs,
    threadTs,
  }: {
    channel: string;
    messageTs: string;
    threadTs?: string;
  }): Promise<SlackMessageMetadata | null> {
    try {
      const parseMetadata = (result: {
        ok: boolean;
        error?: string;
        messages?: Array<{
          ts: string;
          metadata?: {
            event_type?: unknown;
            event_payload?: unknown;
          };
        }>;
      }): SlackMessageMetadata | null => {
        if (!result.ok) {
          console.error(
            `[getMessageMetadata] Slack error: ${result.error || 'Unknown error'}`,
          );
          return null;
        }

        if (!Array.isArray(result.messages) || result.messages.length === 0) {
          return null;
        }

        const message =
          result.messages.find((entry) => entry.ts === messageTs) ??
          result.messages[0];

        if (!message?.metadata) {
          return null;
        }

        const eventType = message.metadata.event_type;
        const eventPayload = message.metadata.event_payload;

        if (typeof eventType !== 'string' || eventType.trim().length === 0) {
          return null;
        }

        if (
          !eventPayload ||
          typeof eventPayload !== 'object' ||
          Array.isArray(eventPayload)
        ) {
          return null;
        }

        return {
          event_type: eventType,
          event_payload: eventPayload as Record<string, unknown>,
        };
      };

      const historyResponse = await slackFetch(
        `${buildSlackApiUrl('conversations.history')}?channel=${encodeURIComponent(channel)}&oldest=${encodeURIComponent(messageTs)}&latest=${encodeURIComponent(messageTs)}&inclusive=true&limit=1&include_all_metadata=true`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      if (!historyResponse.ok) {
        console.error(
          `[getMessageMetadata] Slack history API failed: ${historyResponse.status} ${historyResponse.statusText}`,
        );
      } else {
        const historyResult = (await historyResponse.json()) as {
          ok: boolean;
          error?: string;
          messages?: Array<{
            ts: string;
            metadata?: {
              event_type?: unknown;
              event_payload?: unknown;
            };
          }>;
        };
        const historyMetadata = parseMetadata(historyResult);

        if (historyMetadata) {
          return historyMetadata;
        }
      }

      if (!threadTs) {
        return null;
      }

      const repliesResponse = await slackFetch(
        `${buildSlackApiUrl('conversations.replies')}?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}&oldest=${encodeURIComponent(messageTs)}&latest=${encodeURIComponent(messageTs)}&inclusive=true&include_all_metadata=true`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      if (!repliesResponse.ok) {
        console.error(
          `[getMessageMetadata] Slack replies API failed: ${repliesResponse.status} ${repliesResponse.statusText}`,
        );
        return null;
      }

      const repliesResult = (await repliesResponse.json()) as {
        ok: boolean;
        error?: string;
        messages?: Array<{
          ts: string;
          metadata?: {
            event_type?: unknown;
            event_payload?: unknown;
          };
        }>;
      };

      return parseMetadata(repliesResult);
    } catch (error) {
      console.error(
        `[getMessageMetadata] Failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Fetches a single Slack message by timestamp.
   * Tries channel history first, then falls back to thread replies so summon
   * reactions can resolve both top-level messages and threaded replies.
   */
  public async getMessage({
    channel,
    messageTs,
  }: {
    channel: string;
    messageTs: string;
  }): Promise<SlackConversationMessage | null> {
    try {
      const parseMessage = (
        messages:
          | Array<{
              text?: string;
              ts?: string;
              thread_ts?: string;
              user?: string;
              bot_id?: string;
              app_id?: string;
              attachments?: unknown[];
              blocks?: unknown[];
              files?: SlackFile[];
            }>
          | undefined,
      ): SlackConversationMessage | null => {
        const message =
          messages?.find((entry) => entry.ts === messageTs) ?? messages?.[0];

        if (!message?.ts) {
          return null;
        }

        const authoredText =
          typeof message.text === 'string' ? message.text : '';
        const agentContext = formatSlackAttachmentContext(
          authoredText,
          message.attachments,
          message.blocks,
        );
        const text = appendSlackAttachmentContext(
          authoredText,
          message.attachments,
          message.blocks,
        );
        const files = appendSlackForwardedMessageFiles(
          Array.isArray(message.files) ? message.files : undefined,
          message.attachments,
        );

        if (!text.trim() && !files?.length) {
          return null;
        }

        return {
          text,
          ...(agentContext ? { authoredText, agentContext } : {}),
          ts: message.ts,
          thread_ts:
            typeof message.thread_ts === 'string'
              ? message.thread_ts
              : undefined,
          user: typeof message.user === 'string' ? message.user : undefined,
          bot_id:
            typeof message.bot_id === 'string' ? message.bot_id : undefined,
          app_id:
            typeof message.app_id === 'string' ? message.app_id : undefined,
          attachments: Array.isArray(message.attachments)
            ? message.attachments
            : undefined,
          ...(Array.isArray(message.blocks) ? { blocks: message.blocks } : {}),
          files,
        };
      };

      const parseResult = (result: {
        ok: boolean;
        error?: string;
        messages?: Array<{
          text?: string;
          ts?: string;
          thread_ts?: string;
          user?: string;
          bot_id?: string;
          app_id?: string;
          attachments?: unknown[];
          blocks?: unknown[];
          files?: SlackFile[];
        }>;
      }): SlackConversationMessage | null => {
        if (!result.ok) {
          return null;
        }

        return parseMessage(result.messages);
      };

      const historyResponse = await slackFetch(
        `${buildSlackApiUrl('conversations.history')}?channel=${encodeURIComponent(channel)}&oldest=${encodeURIComponent(messageTs)}&latest=${encodeURIComponent(messageTs)}&inclusive=true&limit=1`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      if (!historyResponse.ok) {
        console.error(
          `[getMessage] Slack history lookup failed: ${historyResponse.status} ${historyResponse.statusText}`,
        );
        return null;
      }

      const historyResult = (await historyResponse.json()) as {
        ok: boolean;
        error?: string;
        messages?: Array<{
          text?: string;
          ts?: string;
          thread_ts?: string;
          user?: string;
          bot_id?: string;
          attachments?: unknown[];
          blocks?: unknown[];
          files?: SlackFile[];
        }>;
      };

      if (!historyResult.ok) {
        console.error(
          `[getMessage] Slack history error: ${historyResult.error || 'Unknown error'}`,
        );
        return null;
      }

      const messageFromHistory = parseResult(historyResult);
      if (messageFromHistory) {
        return messageFromHistory;
      }

      const repliesResponse = await slackFetch(
        `${buildSlackApiUrl('conversations.replies')}?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(messageTs)}&oldest=${encodeURIComponent(messageTs)}&latest=${encodeURIComponent(messageTs)}&inclusive=true`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      if (!repliesResponse.ok) {
        console.error(
          `[getMessage] Slack replies lookup failed: ${repliesResponse.status} ${repliesResponse.statusText}`,
        );
        return null;
      }

      const repliesResult = (await repliesResponse.json()) as {
        ok: boolean;
        error?: string;
        messages?: Array<{
          text?: string;
          ts?: string;
          thread_ts?: string;
          user?: string;
          bot_id?: string;
          attachments?: unknown[];
          blocks?: unknown[];
          files?: SlackFile[];
        }>;
      };

      if (!repliesResult.ok) {
        if (
          repliesResult.error === 'thread_not_found' ||
          repliesResult.error === 'message_not_found'
        ) {
          return null;
        }

        console.error(
          `[getMessage] Slack replies error: ${repliesResult.error || 'Unknown error'}`,
        );
        return null;
      }

      return parseResult(repliesResult);
    } catch (error) {
      console.error(
        `[getMessage] Failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Removes the cancel button from the started message.
   * Keeps other buttons (e.g. Follow) in the actions block.
   * If the actions block becomes empty, removes it entirely.
   */
  public async removeCancelButton({
    channel,
    messageTs,
    threadTs,
  }: {
    channel: string;
    messageTs: string;
    threadTs: string;
  }): Promise<boolean> {
    try {
      const blocks = await this.getMessageBlocks({
        channel,
        messageTs,
        threadTs,
      });

      if (!blocks) {
        return false;
      }

      const updatedBlocks = blocks
        .map((block) => {
          if (
            !block ||
            typeof block !== 'object' ||
            (block as { type?: string }).type !== 'actions' ||
            !Array.isArray((block as { elements?: unknown[] }).elements)
          ) {
            return block;
          }

          // Remove only the cancel_task button, keep others (e.g. Follow)
          const filteredElements = (
            block as { elements: Array<{ action_id?: string }> }
          ).elements.filter((el) => el.action_id !== 'cancel_task');

          // If no elements remain, drop the whole actions block
          if (filteredElements.length === 0) {
            return null;
          }

          return { ...block, elements: filteredElements };
        })
        .filter((block): block is unknown => block !== null);

      return await this.updateMessage({
        channel,
        ts: messageTs,
        message: { blocks: updatedBlocks },
      });
    } catch (error) {
      console.error(
        `[removeCancelButton] Failed to remove cancel button: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  public async deleteMessage(payload: { channel: string; ts: string }) {
    try {
      const response = await slackFetch(buildSlackApiUrl('chat.delete'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.error(
          `[deleteMessage] Slack chat.delete API failed: ${response.status} ${response.statusText}`,
        );

        return false;
      }

      const result: SlackResponse = await response.json();

      if (!result.ok) {
        console.error(
          `[deleteMessage] Slack chat.delete error: ${result.error} - ${JSON.stringify(result)} - ${JSON.stringify(payload)}`,
        );

        return false;
      }

      return true;
    } catch (error) {
      console.error(
        `[deleteMessage] Failed to delete Slack message: ${error instanceof Error ? error.message : String(error)}`,
      );

      return false;
    }
  }

  /**
   * Unfurls one or more task URLs in a Slack message using Slack Work Objects.
   *
   * Wraps Slack's chat.unfurl API via the WebClient instance, allowing rich
   * previews to be attached to an existing message in a channel. The unfurls
   * payload maps task URLs to their corresponding WorkObjectUnfurl payloads.
   *
   * @param params - Unfurl configuration
   * @param params.channel - The channel ID where the original message exists
   * @param params.messageTs - The timestamp of the message to unfurl
   * @param params.unfurls - Map of URLs to their WorkObjectUnfurl payloads
   * @param params.metadata - Optional Work Object metadata to send via the
   *   Slack `metadata` parameter, enabling true Work Objects registration.
   */
  public async unfurlTaskUrl(params: {
    channel: string;
    messageTs: string;
    unfurls: Record<string, WorkObjectUnfurl>;
    metadata?: WorkObjectMetadata;
  }): Promise<void> {
    const { channel, messageTs, unfurls, metadata } = params;

    try {
      if (!this.client) {
        this.client = createSlackWebClient(this.token);
      }

      await this.client.chat.unfurl({
        channel,
        ts: messageTs,
        unfurls,
        // Pass through Work Objects metadata when provided so Slack can
        // register and render proper Work Object entities for the task URLs.
        ...(metadata ? { metadata } : {}),
      });

      slackDebug(
        `[SlackNotifier] Successfully unfurled task URL in channel ${channel} at ${messageTs}`,
      );
    } catch (error) {
      logSlackError('[SlackNotifier] Failed to unfurl task URL', error);
    }
  }

  /**
   * Updates a Work Object entity in Slack's flexpane.
   *
   * This method is called in response to an `entity_details_requested` event
   * when a user clicks on a Work Object to view more details. It updates the
   * entity with fresh data from the task.
   *
   * @param params - Update configuration
   * @param params.entityId - The ID of the entity to update
   * @param params.entityPayload - The updated entity payload with fields
   */
  public async updateEntity(params: {
    triggerId: string;
    metadata: WorkObjectMetadataEntity;
  }): Promise<void> {
    const { triggerId, metadata } = params;

    try {
      if (!this.client) {
        this.client = createSlackWebClient(this.token);
      }

      await this.client.apiCall('entity.presentDetails', {
        trigger_id: triggerId,
        metadata: metadata,
      });

      slackDebug(`[SlackNotifier] Successfully updated entity ${triggerId}`);
    } catch (error) {
      logSlackError('[SlackNotifier] Failed to update entity', error);
    }
  }

  public async completeFunctionSuccess(params: {
    functionExecutionId: string;
    outputs?: Record<string, unknown>;
  }): Promise<boolean> {
    const { functionExecutionId, outputs } = params;

    try {
      if (!this.client) {
        this.client = createSlackWebClient(this.token);
      }

      await this.client.apiCall('functions.completeSuccess', {
        function_execution_id: functionExecutionId,
        ...(outputs ? { outputs } : {}),
      });

      return true;
    } catch (error) {
      logSlackError('[SlackNotifier] Failed to complete Slack function', error);
      return false;
    }
  }

  public async completeFunctionError(params: {
    functionExecutionId: string;
    error: string;
  }): Promise<boolean> {
    const { functionExecutionId, error } = params;

    try {
      if (!this.client) {
        this.client = createSlackWebClient(this.token);
      }

      await this.client.apiCall('functions.completeError', {
        function_execution_id: functionExecutionId,
        error,
      });

      return true;
    } catch (completionError) {
      logSlackError(
        '[SlackNotifier] Failed to fail Slack function',
        completionError,
      );
      return false;
    }
  }

  /**
   * Adds a reaction emoji to a Slack message.
   *
   * @param channel - The channel ID where the message exists
   * @param timestamp - The message timestamp to add reaction to
   * @param name - The emoji name without colons (e.g., 'eyes', 'thumbsup')
   * @returns True if reaction was added successfully, false otherwise
   */
  public async addReaction({
    channel,
    timestamp,
    name,
  }: {
    channel: string;
    timestamp: string;
    name: string;
  }): Promise<boolean> {
    try {
      const response = await slackFetch(buildSlackApiUrl('reactions.add'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          channel,
          timestamp,
          name,
        }),
      });

      if (!response.ok) {
        console.error(
          `[addReaction] Slack reactions.add API failed: ${response.status} ${response.statusText}`,
        );

        return false;
      }

      const result: SlackResponse = await response.json();

      if (!result.ok) {
        console.error(
          `[addReaction] Slack reactions.add error: ${result.error} - ${JSON.stringify(result)}`,
        );

        return false;
      }

      return true;
    } catch (error) {
      console.error(
        `[addReaction] Failed to add Slack reaction: ${error instanceof Error ? error.message : String(error)}`,
      );

      return false;
    }
  }

  /**
   * Removes a reaction emoji from a Slack message.
   *
   * @param channel - The channel ID where the message exists
   * @param timestamp - The message timestamp to remove reaction from
   * @param name - The emoji name without colons (e.g., 'eyes', 'thumbsup')
   * @returns True if reaction was removed successfully, false otherwise
   */
  public async removeReaction({
    channel,
    timestamp,
    name,
  }: {
    channel: string;
    timestamp: string;
    name: string;
  }): Promise<boolean> {
    try {
      const response = await slackFetch(buildSlackApiUrl('reactions.remove'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          channel,
          timestamp,
          name,
        }),
      });

      if (!response.ok) {
        console.error(
          `[removeReaction] Slack reactions.remove API failed: ${response.status} ${response.statusText}`,
        );

        return false;
      }

      const result: SlackResponse = await response.json();

      if (!result.ok) {
        console.error(
          `[removeReaction] Slack reactions.remove error: ${result.error} - ${JSON.stringify(result)}`,
        );

        return false;
      }

      return true;
    } catch (error) {
      console.error(
        `[removeReaction] Failed to remove Slack reaction: ${error instanceof Error ? error.message : String(error)}`,
      );

      return false;
    }
  }

  /**
   * Downloads and converts Slack files to base64 strings.
   */

  public async processSlackFiles(files: SlackFile[]): Promise<string[]> {
    const imageFiles = files.filter(isSlackImageFile);

    const base64Images: string[] = [];

    for (const file of imageFiles) {
      try {
        const fileBytes = await this.downloadSlackFile(file);

        if (!fileBytes) {
          continue;
        }

        const base64 = fileBytes.toString('base64');
        const dataUrl = `data:${file.mimetype};base64,${base64}`;
        base64Images.push(dataUrl);
      } catch (error) {
        console.error(
          `[processSlackFiles] Error processing file ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return base64Images;
  }

  public async downloadSlackFile(file: SlackFile): Promise<Buffer | null> {
    try {
      const response = await slackFetch(
        file.url_private_download,
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
          },
        },
        // File bodies stream, so they get the download ceiling rather than the
        // short API-call ceiling.
        { timeoutMs: SLACK_DOWNLOAD_TIMEOUT_MS },
      );

      if (!response.ok) {
        console.error(
          `[downloadSlackFile] Failed to download file ${file.name}: ${response.status} ${response.statusText}`,
        );

        return null;
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      console.error(
        `[downloadSlackFile] Error downloading file ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }
  }

  /**
   * Fetches user information from Slack API for multiple users efficiently.
   * Uses the users.info API endpoint for each user.
   * Prefers display_name, falls back to real_name, then to user ID.
   *
   * @param userIds - Array of Slack user IDs to fetch information for
   * @returns Map of user IDs to display names
   */
  private async getUsersInfo(userIds: string[]): Promise<Map<string, string>> {
    const usernameMap = new Map<string, string>();

    // Fetch user info for each unique user ID
    const uniqueUserIds = [...new Set(userIds)];

    await Promise.all(
      uniqueUserIds.map(async (userId) => {
        try {
          const response = await slackFetch(
            `${buildSlackApiUrl('users.info')}?user=${encodeURIComponent(userId)}`,
            {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${this.token}`,
                'Content-Type': 'application/x-www-form-urlencoded',
              },
            },
          );

          if (!response.ok) {
            console.error(
              `[getUsersInfo] Slack users.info failed for ${userId}: ${response.status} ${response.statusText}`,
            );

            return;
          }

          const result: SlackUserInfo = await response.json();

          if (!result.ok || !result.user) {
            console.error(
              `[getUsersInfo] Slack users.info error for ${userId}: ${result.error || 'No user data'}`,
            );

            return;
          }

          // Prefer display_name, fall back to real_name
          const displayName =
            result.user.profile.display_name ||
            result.user.profile.real_name ||
            result.user.real_name ||
            result.user.name;

          usernameMap.set(userId, displayName);
        } catch (error) {
          console.error(
            `[getUsersInfo] Failed to fetch user info for ${userId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );

    return usernameMap;
  }

  public async getUserDisplayName(userId: string): Promise<string | null> {
    const usernameMap = await this.getUsersInfo([userId]);
    return usernameMap.get(userId) ?? null;
  }

  /**
   * Fetches messages in a Slack thread for providing context.
   * Uses the conversations.replies API with Slack's default limit of 1000 messages.
   *
   * @param channel - The channel ID where the thread exists
   * @param threadTs - The thread timestamp (thread_ts) to fetch messages from
   * @returns Array of thread messages in chronological order, or empty array on error
   */
  public async fetchThreadMessages({
    channel,
    threadTs,
    oldest,
    latest,
    excludeOwnBot = false,
  }: {
    channel: string;
    threadTs: string;
    oldest?: string;
    latest?: string;
    excludeOwnBot?: boolean;
  }): Promise<SlackThreadMessage[]> {
    try {
      const params = new URLSearchParams({
        channel,
        ts: threadTs,
      });

      if (oldest) {
        params.set('oldest', oldest);
      }

      if (latest) {
        params.set('latest', latest);
      }

      if (oldest || latest) {
        params.set('inclusive', 'true');
      }

      const response = await slackFetch(
        `${buildSlackApiUrl('conversations.replies')}?${params.toString()}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      if (!response.ok) {
        console.error(
          `[fetchThreadMessages] Slack conversations.replies failed: ${response.status} ${response.statusText}`,
        );

        return [];
      }

      const result: SlackApiThreadResponse = await response.json();

      if (!result.ok) {
        console.error(
          `[fetchThreadMessages] Slack conversations.replies error: ${result.error || 'Unknown error'}`,
        );

        return [];
      }

      return await this.normalizeFetchedMessages(result.messages, {
        excludeOwnBot,
      });
    } catch (error) {
      console.error(
        `[fetchThreadMessages] Failed to fetch Slack thread messages: ${error instanceof Error ? error.message : String(error)}`,
      );

      return [];
    }
  }

  /**
   * Fetches every message visible in a Slack channel, optionally narrowed to a
   * time window. Thread replies are expanded and included alongside top-level
   * channel messages.
   */
  public async fetchChannelMessages({
    channel,
    oldest,
    latest,
  }: {
    channel: string;
    oldest?: string;
    latest?: string;
  }): Promise<SlackChannelMessage[]> {
    const historyMessages: SlackApiThreadMessage[] = [];
    const threadRootTimestamps = new Set<string>();
    const oldestTs = parseSlackTimestamp(oldest);
    const latestTs = parseSlackTimestamp(latest);
    let cursor: string | undefined;
    let historyPageCount = 0;

    try {
      do {
        historyPageCount += 1;

        const params = new URLSearchParams({
          channel,
          limit: '200',
          inclusive: 'true',
        });

        if (latest) {
          params.set('latest', latest);
        }

        if (cursor) {
          params.set('cursor', cursor);
        }

        const response = await slackFetch(
          `${buildSlackApiUrl('conversations.history')}?${params.toString()}`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${this.token}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          },
        );

        if (!response.ok) {
          throw new Error(
            `Slack conversations.history failed: ${response.status} ${response.statusText}`,
          );
        }

        const result = (await response.json()) as SlackApiThreadResponse;

        if (!result.ok) {
          throw new Error(
            `Slack conversations.history error: ${result.error || 'Unknown error'}`,
          );
        }

        historyMessages.push(...result.messages);
        for (const message of result.messages) {
          if (shouldExpandThreadRoot({ message, oldestTs })) {
            threadRootTimestamps.add(message.ts);
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;

        if (
          oldestTs !== null &&
          cursor &&
          historyPageCount >= MAX_OLDEST_BOUNDED_CHANNEL_HISTORY_PAGES
        ) {
          throw new Error(
            `Slack oldest-bounded channel history lookup exceeded the safe page limit of ${MAX_OLDEST_BOUNDED_CHANNEL_HISTORY_PAGES}; narrow the requested time range or fetch a specific thread instead`,
          );
        }
      } while (cursor);

      const rootMessages = await this.normalizeFetchedMessages(historyMessages);
      const messagesByTs = new Map(
        rootMessages.map((message) => [message.ts, message]),
      );

      for (const threadTs of threadRootTimestamps) {
        const threadMessages = await this.fetchThreadMessages({
          channel,
          threadTs,
          ...(oldest ? { oldest } : {}),
          ...(latest ? { latest } : {}),
        });

        for (const message of threadMessages) {
          if (message.ts === threadTs) {
            continue;
          }

          messagesByTs.set(message.ts, {
            ...message,
            thread_ts: threadTs,
          });
        }
      }

      return [...messagesByTs.values()]
        .sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts))
        .filter((message) => {
          const numericTs = Number.parseFloat(message.ts);
          if (oldestTs !== null && numericTs < oldestTs) {
            return false;
          }
          if (latestTs !== null && numericTs > latestTs) {
            return false;
          }
          return true;
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[fetchChannelMessages] Failed to fetch Slack channel messages: ${message}`,
      );

      throw new Error(message);
    }
  }

  /**
   * Replaces Slack user ID mentions (e.g., <@U123456>) with actual user display names.
   * Useful for making messages more readable by showing "@John Doe" instead of "<@U123456>".
   *
   * @param text - The text containing Slack user mentions
   * @returns Text with user IDs replaced by display names (e.g., "@John Doe")
   */
  public async replaceMentionsWithNames(text: string): Promise<string> {
    // Extract all user IDs from mentions in the format <@USER_ID>
    const mentionPattern = /<@([A-Z0-9]+)>/g;
    const matches = [...text.matchAll(mentionPattern)];

    if (matches.length === 0) {
      return text;
    }

    // Get unique user IDs from all mentions (filter out any undefined values)
    const userIds = [
      ...new Set(
        matches.map((match) => match[1]).filter((id): id is string => !!id),
      ),
    ];

    // Fetch user display names
    const usernameMap = await this.getUsersInfo(userIds);

    // Replace each mention with the user's display name
    let result = text;
    for (const match of matches) {
      const userId = match[1];
      if (!userId) continue;

      const username = usernameMap.get(userId);

      if (username) {
        // Replace <@USER_ID> with @UserName
        result = result.replace(match[0], `@${username}`);
      }
      // If username not found, leave the original mention format
    }

    return result;
  }

  /**
   * Normalizes inbound Slack text for internal model/web consumption.
   * - Expands user mentions to readable names.
   * - Converts Slack mrkdwn links to standard markdown/plain URLs.
   */
  public async normalizeIncomingText(text: string): Promise<string> {
    return convertSlackLinksToMarkdown(
      await this.replaceMentionsWithNames(text),
    );
  }
}
