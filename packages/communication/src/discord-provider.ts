import type {
  CommunicationChannelMessagesResult,
  CommunicationMessage,
  CommunicationMessageButton,
  CommunicationPostMessageInput,
  CommunicationPostMessageResult,
  CommunicationProviderAdapter,
  CommunicationReactionResult,
  CommunicationThreadLookupResult,
} from './provider';

export const DISCORD_MAX_MESSAGE_LENGTH = 2_000;
const DISCORD_MAX_EMBEDS_PER_MESSAGE = 10;
const DEFAULT_DISCORD_API_BASE_URL = 'https://discord.com/api/v10';
const DEFAULT_DISCORD_TIMEOUT_MS = 10_000;
const DEFAULT_DISCORD_MAX_RETRIES = 2;
const DISCORD_RETRY_BASE_DELAY_MS = 250;

export type DiscordCommunicationProviderOptions = {
  botToken: string;
  applicationId?: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  nonceFactory?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type DiscordBotInfo = {
  id: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
};

export type DiscordApplicationInfo = {
  id: string;
  name: string;
  description: string;
  botPublic: boolean;
  verifyKey: string;
};

export type DiscordGuild = {
  id: string;
  name: string;
  icon: string | null;
  owner?: boolean;
  permissions?: string;
};

type DiscordApiGuild = {
  id: string;
  name: string;
  icon?: string | null;
  owner?: boolean;
  permissions?: string;
};

export type DiscordForumTag = {
  id: string;
  name: string;
  moderated: boolean;
  emojiId: string | null;
  emojiName: string | null;
};

export type DiscordForumTagSelector = (
  tags: DiscordForumTag[],
) => string | null | Promise<string | null>;

export type DiscordChannel = {
  id: string;
  guildId?: string;
  parentId?: string;
  name: string;
  type: number;
  position?: number;
  flags?: number;
  availableTags?: DiscordForumTag[];
};

export type DiscordTaskThread = {
  channelId: string;
  parentChannelId: string;
  name: string;
  kind: 'thread' | 'forum_post';
  messageId?: string;
};

export type DiscordPermissionName =
  | 'view_channel'
  | 'send_messages'
  | 'send_messages_in_threads'
  | 'create_public_threads'
  | 'manage_threads'
  | 'read_message_history'
  | 'embed_links'
  | 'attach_files'
  | 'add_reactions';

export type DiscordChannelPermissionDiagnostics = {
  guildId: string;
  channelId: string;
  channelType: number;
  permissions: Record<DiscordPermissionName, boolean>;
  requiredPermissions: DiscordPermissionName[];
  missingPermissions: DiscordPermissionName[];
  requiresTag: boolean;
  availableTags: DiscordForumTag[];
  unsupportedReason: 'forum_requires_tag' | null;
  canUseChannel: boolean;
};

type DiscordApiMessage = {
  id: string;
  channel_id: string;
  content?: string;
  author?: {
    id: string;
    username?: string;
    global_name?: string | null;
    bot?: boolean;
  };
  attachments?: Array<{
    id: string;
    filename: string;
    content_type?: string;
    size: number;
    url?: string;
    proxy_url?: string;
  }>;
  thread?: { id: string };
};

type DiscordPermissionOverwrite = {
  id: string;
  type: number;
  allow: string;
  deny: string;
};

type DiscordApiChannel = {
  id: string;
  guild_id?: string;
  parent_id?: string | null;
  name?: string;
  type: number;
  position?: number;
  flags?: number;
  available_tags?: Array<{
    id: string;
    name: string;
    moderated: boolean;
    emoji_id?: string | null;
    emoji_name?: string | null;
  }>;
  permission_overwrites?: DiscordPermissionOverwrite[];
};

type DiscordRequestOptions = {
  retryNetworkErrors: boolean;
  retryServerErrors: boolean;
  authorization?: boolean;
  routePath?: string;
};

export class DiscordApiError extends Error {
  readonly status: number;
  readonly code?: number | string;
  readonly retryAfterMs?: number;

  constructor(input: {
    method: string;
    path: string;
    status: number;
    message: string;
    code?: number | string;
    retryAfterMs?: number;
  }) {
    super(
      `Discord ${input.method} ${input.path} failed (${input.status}): ${input.message}`,
    );
    this.name = 'DiscordApiError';
    this.status = input.status;
    this.code = input.code;
    this.retryAfterMs = input.retryAfterMs;
  }
}

/**
 * Discord did not return an HTTP response, so callers cannot infer delivery
 * semantics from a status code. Keep this distinct from application errors so
 * durable inbound processors can retain the event until Discord is reachable.
 */
export class DiscordApiTransportError extends Error {
  readonly method: string;
  readonly path: string;

  constructor(input: { method: string; path: string; cause: unknown }) {
    const detail =
      input.cause instanceof Error ? input.cause.message : String(input.cause);
    super(`Discord ${input.method} ${input.path} transport failed: ${detail}`, {
      cause: input.cause,
    });
    this.name = 'DiscordApiTransportError';
    this.method = input.method;
    this.path = input.path;
  }
}

function cleanBaseUrl(value: string): string {
  return value.replace(/\/$/u, '');
}

function parseSeconds(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function defaultNonceFactory(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`.slice(0, 25);
}

function normalizeRoute(method: string, path: string): string {
  // Discord buckets most endpoints by route template plus the major resource
  // (channel/guild/webhook id). Preserve that first id while normalizing the
  // remaining snowflakes so requests learn the same bucket.
  const parts = path.split('/');
  let keptMajorId = false;
  const normalized = parts.map((part, index) => {
    const previous = parts[index - 1];
    const isMajor = ['channels', 'guilds', 'webhooks'].includes(previous ?? '');
    if (/^\d{6,}$/u.test(part)) {
      if (isMajor && !keptMajorId) {
        keptMajorId = true;
        return part;
      }
      return ':id';
    }
    return part;
  });
  return `${method.toUpperCase()} ${normalized.join('/')}`;
}

export function chunkDiscordMessage(
  text: string,
  limit = DISCORD_MAX_MESSAGE_LENGTH,
): string[] {
  if (text.length <= limit) return text ? [text] : [];
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit + 1);
    const newline = candidate.lastIndexOf('\n');
    const whitespace = candidate.search(/\s+\S*$/u);
    const splitAt =
      newline > limit / 2
        ? newline
        : whitespace > limit / 2
          ? whitespace
          : limit;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function truncateDiscordMessage(
  text: string,
  limit = DISCORD_MAX_MESSAGE_LENGTH,
): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function buildDiscordComponents(
  buttons: CommunicationMessageButton[][] | undefined,
): unknown[] | undefined {
  const rows = (buttons ?? []).slice(0, 5).flatMap((row) => {
    const components: Array<Record<string, unknown>> = [];
    for (const button of row.slice(0, 5)) {
      if (button.url) {
        components.push({
          type: 2,
          style: 5,
          label: button.text,
          url: button.url,
        });
        continue;
      }
      if (button.callbackData) {
        if (button.callbackData.length > 100) {
          throw new Error(
            'Discord button callbackData cannot exceed 100 characters.',
          );
        }
        components.push({
          type: 2,
          style: 2,
          label: button.text,
          custom_id: button.callbackData,
        });
      }
    }
    return components.length ? [{ type: 1, components }] : [];
  });
  return rows.length ? rows : undefined;
}

function toCommunicationMessage(
  message: DiscordApiMessage,
): CommunicationMessage {
  const files = (message.attachments ?? []).map((attachment) => {
    const url = attachment.url?.trim() || attachment.proxy_url?.trim();
    return {
      id: attachment.id,
      name: attachment.filename,
      mimeType: attachment.content_type ?? 'application/octet-stream',
      size: attachment.size,
      ...(url ? { url } : {}),
    };
  });
  return {
    provider: 'discord',
    id: message.id,
    user: message.author?.id ?? 'unknown',
    ...(message.author?.username ? { username: message.author.username } : {}),
    ...(message.author?.bot ? { botId: message.author.id } : {}),
    text: message.content ?? '',
    channelId: message.channel_id,
    ...(message.thread?.id ? { threadId: message.thread.id } : {}),
    fileCount: files.length,
    ...(files.length ? { files } : {}),
  };
}

function requireId(value: unknown, operation: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Discord ${operation} returned no id.`);
  }
  return value;
}

const DISCORD_PERMISSION_BITS = {
  administrator: 1n << 3n,
  add_reactions: 1n << 6n,
  view_channel: 1n << 10n,
  send_messages: 1n << 11n,
  embed_links: 1n << 14n,
  attach_files: 1n << 15n,
  read_message_history: 1n << 16n,
  manage_threads: 1n << 34n,
  create_public_threads: 1n << 35n,
  send_messages_in_threads: 1n << 38n,
} as const;

const DISCORD_CHANNEL_TYPE_PUBLIC_THREAD = 11;
const DISCORD_CHANNEL_TYPE_ANNOUNCEMENT_THREAD = 10;
const DISCORD_CHANNEL_TYPE_ANNOUNCEMENT = 5;
const DISCORD_CHANNEL_TYPES_FORUM = new Set([15, 16]);
/**
 * SUPPRESS_EMBEDS. Discord unfurls every link it finds into a preview card,
 * which turns a task link into a Roomote marketing embed under the message.
 * Slack posts with `unfurl_links: false`; this is the same intent.
 *
 * Only ever set while creating a message, and only when that message sends no
 * embeds of its own — the flag hides deliberate embeds too. Editing `flags`
 * rewrites the whole bitfield, which on an edit would hide the embeds Discord
 * retains from the original, and on an interaction response would rewrite the
 * flags of a deferral that may be EPHEMERAL.
 */
const DISCORD_MESSAGE_FLAG_SUPPRESS_EMBEDS = 1 << 2;
const DISCORD_ERROR_CODE_UNKNOWN_MESSAGE = 10008;
const DISCORD_ERROR_CODE_MESSAGE_ALREADY_HAS_THREAD = 160004;

/** True when a Discord API error means the referenced message no longer exists. */
export function isDiscordUnknownMessageError(error: unknown): boolean {
  return (
    error instanceof DiscordApiError &&
    Number(error.code) === DISCORD_ERROR_CODE_UNKNOWN_MESSAGE
  );
}
export const DISCORD_CHANNEL_FLAG_REQUIRE_TAG = 1 << 4;
export const DISCORD_REQUIRED_TAG_FORUM_ERROR =
  'Discord requires a tag for new posts in this forum, but no tag is available for Roomote to select.';

export function discordChannelRequiresTag(
  channel: Pick<DiscordChannel, 'type' | 'flags'>,
): boolean {
  return (
    DISCORD_CHANNEL_TYPES_FORUM.has(channel.type) &&
    ((channel.flags ?? 0) & DISCORD_CHANNEL_FLAG_REQUIRE_TAG) !== 0
  );
}

function selectAutomaticForumTag(
  tags: DiscordForumTag[] | undefined,
  options?: { canUseModeratedTags?: boolean },
): DiscordForumTag | null {
  if (!tags?.length) return null;
  // Anyone who can create a post can apply an unmoderated tag. Prefer one so
  // automatic task threads do not depend on MANAGE_THREADS.
  const unmoderated = tags.find((tag) => !tag.moderated);
  if (unmoderated) return unmoderated;
  // Moderated tags require MANAGE_THREADS; only fall back to them when the bot
  // is known to have that permission.
  if (options?.canUseModeratedTags) return tags[0]!;
  return null;
}

function listSelectableForumTags(
  tags: DiscordForumTag[] | undefined,
  options?: { canUseModeratedTags?: boolean },
): DiscordForumTag[] {
  if (!tags?.length) return [];
  if (tags.some((tag) => !tag.moderated)) {
    return tags.filter((tag) => !tag.moderated);
  }
  return options?.canUseModeratedTags ? tags : [];
}

export class DiscordCommunicationProvider implements CommunicationProviderAdapter {
  readonly provider = 'discord' as const;

  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly nonceFactory: () => string;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly bucketByRoute = new Map<string, string>();
  private readonly bucketResetAt = new Map<string, number>();
  private globalResetAt = 0;

  constructor(private readonly options: DiscordCommunicationProviderOptions) {
    this.apiBaseUrl = cleanBaseUrl(
      options.apiBaseUrl ??
        process.env.DISCORD_API_BASE_URL ??
        DEFAULT_DISCORD_API_BASE_URL,
    );
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DISCORD_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_DISCORD_MAX_RETRIES;
    this.nonceFactory = options.nonceFactory ?? defaultNonceFactory;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async postMessage(
    input: CommunicationPostMessageInput,
  ): Promise<CommunicationPostMessageResult> {
    const text = input.text?.trim() ?? '';
    const images = input.images ?? [];
    if (!text && images.length === 0 && !(input.attachments?.length ?? 0)) {
      throw new Error(
        'Discord postMessage requires text, images, or attachments.',
      );
    }

    const textChunks = chunkDiscordMessage(text);
    const imageGroups = Array.from(
      { length: Math.ceil(images.length / DISCORD_MAX_EMBEDS_PER_MESSAGE) },
      (_, index) =>
        images.slice(
          index * DISCORD_MAX_EMBEDS_PER_MESSAGE,
          (index + 1) * DISCORD_MAX_EMBEDS_PER_MESSAGE,
        ),
    );
    const batchCount = Math.max(textChunks.length, imageGroups.length, 1);
    const destinationId = input.threadId ?? input.channelId;
    let firstMessage: DiscordApiMessage | null = null;

    for (let index = 0; index < batchCount; index += 1) {
      const nonce = this.nonceFactory();
      const imageGroup = imageGroups[index] ?? [];
      const body = {
        ...(textChunks[index] ? { content: textChunks[index] } : {}),
        allowed_mentions: { parse: [] },
        nonce,
        enforce_nonce: true,
        ...(imageGroup.length
          ? {
              embeds: imageGroup.map((image) => ({
                description: image.altText.slice(0, 4_096),
                image: { url: image.url },
              })),
            }
          : { flags: DISCORD_MESSAGE_FLAG_SUPPRESS_EMBEDS }),
        ...(index === 0 && input.attachments?.length
          ? { attachments: input.attachments }
          : {}),
        ...(index === batchCount - 1 && input.buttons
          ? { components: buildDiscordComponents(input.buttons) }
          : {}),
        ...(index === 0 && input.replyToMessageId
          ? {
              message_reference: {
                message_id: input.replyToMessageId,
                channel_id: destinationId,
                fail_if_not_exists: false,
              },
            }
          : {}),
      };
      const message = await this.request<DiscordApiMessage>(
        'POST',
        `/channels/${destinationId}/messages`,
        body,
        // A stable Discord nonce with enforce_nonce makes retrying this send
        // safe: Discord returns the existing recent message for that nonce.
        { retryNetworkErrors: true, retryServerErrors: true },
      );
      firstMessage ??= message;
    }

    if (!firstMessage)
      throw new Error('Discord postMessage produced no message.');
    return {
      provider: 'discord',
      channelId: input.channelId,
      messageId: firstMessage.id,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    };
  }

  async editMessage(input: {
    channelId: string;
    messageId: string;
    text: string;
    buttons?: CommunicationMessageButton[][];
  }): Promise<void> {
    if (input.text.length > DISCORD_MAX_MESSAGE_LENGTH) {
      throw new Error(
        'Discord edited message text cannot exceed 2000 characters.',
      );
    }
    await this.request(
      'PATCH',
      `/channels/${input.channelId}/messages/${input.messageId}`,
      {
        content: input.text,
        allowed_mentions: { parse: [] },
        components: buildDiscordComponents(input.buttons) ?? [],
      },
      { retryNetworkErrors: true, retryServerErrors: true },
    );
  }

  async deleteMessage(input: {
    channelId: string;
    messageId: string;
  }): Promise<void> {
    await this.request(
      'DELETE',
      `/channels/${input.channelId}/messages/${input.messageId}`,
      undefined,
      { retryNetworkErrors: true, retryServerErrors: true },
    );
  }

  async createPublicThread(input: {
    channelId: string;
    name: string;
    type?: 10 | 11;
    autoArchiveDuration?: 60 | 1440 | 4320 | 10080;
  }): Promise<DiscordTaskThread> {
    const channel = await this.request<DiscordApiChannel>(
      'POST',
      `/channels/${input.channelId}/threads`,
      {
        name: input.name.slice(0, 100),
        type: input.type ?? DISCORD_CHANNEL_TYPE_PUBLIC_THREAD,
        auto_archive_duration: input.autoArchiveDuration ?? 1440,
      },
      // A timed-out thread creation may already have succeeded and has no
      // nonce-level idempotency, so never retry ambiguous network/5xx errors.
      { retryNetworkErrors: false, retryServerErrors: false },
    );
    return {
      channelId: requireId(channel.id, 'createPublicThread'),
      parentChannelId: input.channelId,
      name: channel.name ?? input.name,
      kind: 'thread',
    };
  }

  /**
   * Starts a thread on an existing channel message — Discord's analog of a
   * Slack threaded reply. The created thread's id equals the source message
   * id, and because a message can only ever have one thread, a duplicate
   * creation (including an ambiguous retry) recovers the existing thread
   * instead of failing.
   */
  async createThreadFromMessage(input: {
    channelId: string;
    messageId: string;
    name: string;
    autoArchiveDuration?: 60 | 1440 | 4320 | 10080;
  }): Promise<DiscordTaskThread> {
    let channel: DiscordApiChannel;
    try {
      channel = await this.request<DiscordApiChannel>(
        'POST',
        `/channels/${input.channelId}/messages/${input.messageId}/threads`,
        {
          name: input.name.slice(0, 100),
          auto_archive_duration: input.autoArchiveDuration ?? 1440,
        },
        // Retries are safe here: a creation that already succeeded surfaces
        // as MESSAGE_ALREADY_HAS_THREAD and is recovered below.
        { retryNetworkErrors: true, retryServerErrors: true },
      );
    } catch (error) {
      if (
        error instanceof DiscordApiError &&
        Number(error.code) === DISCORD_ERROR_CODE_MESSAGE_ALREADY_HAS_THREAD
      ) {
        const existing = await this.getChannel(input.messageId);
        return {
          channelId: existing.id,
          parentChannelId: input.channelId,
          name: existing.name,
          kind: 'thread',
          messageId: input.messageId,
        };
      }
      throw error;
    }
    return {
      channelId: requireId(channel.id, 'createThreadFromMessage'),
      parentChannelId: input.channelId,
      name: channel.name ?? input.name,
      kind: 'thread',
      messageId: input.messageId,
    };
  }

  async createForumPost(input: {
    channelId: string;
    name: string;
    text: string;
    appliedTagIds?: string[];
    buttons?: CommunicationMessageButton[][];
    images?: Array<{ url: string; altText: string }>;
    autoArchiveDuration?: 60 | 1440 | 4320 | 10080;
  }): Promise<DiscordTaskThread> {
    if (input.text.length > DISCORD_MAX_MESSAGE_LENGTH) {
      throw new Error('Discord forum post text cannot exceed 2000 characters.');
    }
    const nonce = this.nonceFactory();
    const channel = await this.request<
      DiscordApiChannel & { message?: DiscordApiMessage }
    >(
      'POST',
      `/channels/${input.channelId}/threads`,
      {
        name: input.name.slice(0, 100),
        auto_archive_duration: input.autoArchiveDuration ?? 1440,
        ...(input.appliedTagIds?.length
          ? { applied_tags: input.appliedTagIds }
          : {}),
        message: {
          content: input.text,
          allowed_mentions: { parse: [] },
          nonce,
          enforce_nonce: true,
          ...(input.images?.length
            ? {
                embeds: input.images
                  .slice(0, DISCORD_MAX_EMBEDS_PER_MESSAGE)
                  .map((image) => ({
                    description: image.altText.slice(0, 4_096),
                    image: { url: image.url },
                  })),
              }
            : {}),
          ...(input.buttons
            ? { components: buildDiscordComponents(input.buttons) }
            : {}),
          ...(input.images?.length
            ? {}
            : { flags: DISCORD_MESSAGE_FLAG_SUPPRESS_EMBEDS }),
        },
      },
      // The message nonce does not make the containing thread creation
      // idempotent, so only an explicit 429 is retried by the request layer.
      { retryNetworkErrors: false, retryServerErrors: false },
    );
    return {
      channelId: requireId(channel.id, 'createForumPost'),
      parentChannelId: input.channelId,
      name: channel.name ?? input.name,
      kind: 'forum_post',
      ...(channel.message?.id ? { messageId: channel.message.id } : {}),
    };
  }

  /**
   * Creates the Discord-side task-thread container without requiring the
   * caller to wait for a separate public-thread starter message. Forum posts
   * are atomic in Discord, so their starter message is created here too.
   */
  async reserveTaskThread(input: {
    channelId: string;
    name: string;
    initialText: string;
    buttons?: CommunicationMessageButton[][];
    selectForumTag?: DiscordForumTagSelector;
  }): Promise<DiscordTaskThread> {
    const channel = await this.getChannel(input.channelId);
    if (DISCORD_CHANNEL_TYPES_FORUM.has(channel.type)) {
      const requiresTag = discordChannelRequiresTag(channel);
      const onlyModeratedTags =
        requiresTag &&
        (channel.availableTags?.length ?? 0) > 0 &&
        channel.availableTags!.every((tag) => tag.moderated);
      const canUseModeratedTags =
        onlyModeratedTags && channel.guildId
          ? (
              await this.diagnoseChannelPermissions({
                guildId: channel.guildId,
                channelId: input.channelId,
              })
            ).permissions.manage_threads
          : false;
      const fallbackTag = requiresTag
        ? selectAutomaticForumTag(channel.availableTags, {
            canUseModeratedTags,
          })
        : null;
      if (requiresTag && !fallbackTag) {
        throw new Error(DISCORD_REQUIRED_TAG_FORUM_ERROR);
      }
      const selectableTags = listSelectableForumTags(channel.availableTags, {
        canUseModeratedTags,
      });
      const selectedTagId =
        requiresTag && input.selectForumTag
          ? await input.selectForumTag(selectableTags)
          : null;
      const automaticTag =
        selectableTags.find((tag) => tag.id === selectedTagId) ?? fallbackTag;
      return this.createForumPost({
        channelId: input.channelId,
        name: input.name,
        // Forum creation accepts exactly one starter message. Keep the full
        // request in the task payload while fitting the visible starter.
        text: truncateDiscordMessage(input.initialText),
        ...(automaticTag ? { appliedTagIds: [automaticTag.id] } : {}),
        ...(input.buttons ? { buttons: input.buttons } : {}),
      });
    }
    const thread = await this.createPublicThread({
      channelId: input.channelId,
      name: input.name,
      type:
        channel.type === DISCORD_CHANNEL_TYPE_ANNOUNCEMENT
          ? DISCORD_CHANNEL_TYPE_ANNOUNCEMENT_THREAD
          : DISCORD_CHANNEL_TYPE_PUBLIC_THREAD,
    });
    return thread;
  }

  /** Completes a reserved public task thread with its starter message. */
  async completeTaskThread(input: {
    thread: DiscordTaskThread;
    initialText: string;
    buttons?: CommunicationMessageButton[][];
  }): Promise<DiscordTaskThread> {
    // Forum creation includes its starter atomically. It is also safe to call
    // this again after a public-thread starter has already been persisted.
    if (input.thread.kind === 'forum_post' || input.thread.messageId) {
      return input.thread;
    }

    const message = await this.postMessage({
      channelId: input.thread.parentChannelId,
      threadId: input.thread.channelId,
      text: input.initialText,
      ...(input.buttons ? { buttons: input.buttons } : {}),
    });
    return { ...input.thread, messageId: message.messageId };
  }

  async createTaskThread(input: {
    channelId: string;
    name: string;
    initialText: string;
    buttons?: CommunicationMessageButton[][];
    selectForumTag?: DiscordForumTagSelector;
  }): Promise<DiscordTaskThread> {
    const thread = await this.reserveTaskThread(input);
    return this.completeTaskThread({
      thread,
      initialText: input.initialText,
      ...(input.buttons ? { buttons: input.buttons } : {}),
    });
  }

  async fetchThreadMessages(input: {
    channelId: string;
    messageId: string;
  }): Promise<CommunicationThreadLookupResult> {
    const raw = await this.request<DiscordApiMessage[]>(
      'GET',
      `/channels/${input.channelId}/messages?limit=100`,
      undefined,
      { retryNetworkErrors: true, retryServerErrors: true },
    );
    const messages = raw.map(toCommunicationMessage).reverse();
    const matchedMessageIndex = messages.findIndex(
      (message) => message.id === input.messageId,
    );
    return {
      provider: 'discord',
      channelId: input.channelId,
      requestedMessageId: input.messageId,
      threadId: input.channelId,
      matchedMessageIndex,
      messageCount: messages.length,
      messages,
    };
  }

  /**
   * Fetches one message by id. A message-anchored thread's starter message
   * shares the thread's id but lives in the parent channel, so it never
   * appears in the thread's own message listing and must be read here.
   */
  async fetchMessage(input: {
    channelId: string;
    messageId: string;
  }): Promise<CommunicationMessage> {
    const raw = await this.request<DiscordApiMessage>(
      'GET',
      `/channels/${input.channelId}/messages/${input.messageId}`,
      undefined,
      { retryNetworkErrors: true, retryServerErrors: true },
    );
    return toCommunicationMessage(raw);
  }

  async fetchChannelMessages(input: {
    channelId: string;
    oldest?: string;
    latest?: string;
  }): Promise<CommunicationChannelMessagesResult> {
    const query = new URLSearchParams({ limit: '100' });
    if (input.oldest) query.set('after', input.oldest);
    if (input.latest) query.set('before', input.latest);
    const raw = await this.request<DiscordApiMessage[]>(
      'GET',
      `/channels/${input.channelId}/messages?${query.toString()}`,
      undefined,
      { retryNetworkErrors: true, retryServerErrors: true },
    );
    const messages = raw.map(toCommunicationMessage).reverse();
    return {
      provider: 'discord',
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
  }): Promise<CommunicationReactionResult> {
    const emoji = encodeURIComponent(resolveDiscordReactionEmoji(input.name));
    await this.request(
      'PUT',
      `/channels/${input.channelId}/messages/${input.messageId}/reactions/${emoji}/@me`,
      undefined,
      { retryNetworkErrors: true, retryServerErrors: true },
    );
    return { provider: 'discord', ...input };
  }

  async removeReaction(input: {
    channelId: string;
    messageId: string;
    name: string;
  }): Promise<CommunicationReactionResult> {
    const emoji = encodeURIComponent(resolveDiscordReactionEmoji(input.name));
    await this.request(
      'DELETE',
      `/channels/${input.channelId}/messages/${input.messageId}/reactions/${emoji}/@me`,
      undefined,
      { retryNetworkErrors: true, retryServerErrors: true },
    );
    return { provider: 'discord', ...input };
  }

  /**
   * Shows the bot as typing in the channel or thread for ~10 seconds (or
   * until the bot's next message lands). Callers that deliver slowly should
   * re-trigger on a heartbeat.
   */
  async triggerTyping(input: {
    channelId: string;
    threadId?: string;
  }): Promise<void> {
    await this.request(
      'POST',
      `/channels/${input.threadId ?? input.channelId}/typing`,
      undefined,
      { retryNetworkErrors: false, retryServerErrors: false },
    );
  }

  /** Acknowledge a Gateway-delivered interaction within Discord's 3s window. */
  async deferInteraction(input: {
    interactionId: string;
    interactionToken: string;
    ephemeral?: boolean;
  }): Promise<void> {
    await this.request(
      'POST',
      `/interactions/${input.interactionId}/${input.interactionToken}/callback`,
      {
        type: 5,
        ...(input.ephemeral ? { data: { flags: 64 } } : {}),
      },
      {
        retryNetworkErrors: false,
        retryServerErrors: false,
        authorization: false,
        routePath: `/interactions/:id/:token/callback`,
      },
    );
  }

  /** Complete a deferred interaction by editing its original response. */
  async editInteractionResponse(input: {
    applicationId: string;
    interactionToken: string;
    text: string;
    buttons?: CommunicationMessageButton[][];
  }): Promise<CommunicationPostMessageResult> {
    if (input.text.length > DISCORD_MAX_MESSAGE_LENGTH) {
      throw new Error(
        'Discord interaction response text cannot exceed 2000 characters.',
      );
    }
    const message = await this.request<DiscordApiMessage>(
      'PATCH',
      `/webhooks/${input.applicationId}/${input.interactionToken}/messages/@original`,
      {
        content: input.text,
        allowed_mentions: { parse: [] },
        components: buildDiscordComponents(input.buttons) ?? [],
      },
      {
        retryNetworkErrors: true,
        retryServerErrors: true,
        authorization: false,
        routePath: `/webhooks/${input.applicationId}/:token/messages/@original`,
      },
    );
    return {
      provider: 'discord',
      channelId: message.channel_id,
      messageId: message.id,
    };
  }

  async deleteInteractionResponse(input: {
    applicationId: string;
    interactionToken: string;
  }): Promise<void> {
    await this.request(
      'DELETE',
      `/webhooks/${input.applicationId}/${input.interactionToken}/messages/@original`,
      undefined,
      {
        retryNetworkErrors: true,
        retryServerErrors: true,
        authorization: false,
        routePath: `/webhooks/${input.applicationId}/:token/messages/@original`,
      },
    );
  }

  async getBotInfo(): Promise<DiscordBotInfo> {
    const user = await this.request<{
      id: string;
      username: string;
      global_name?: string | null;
      avatar?: string | null;
    }>('GET', '/users/@me', undefined, {
      retryNetworkErrors: true,
      retryServerErrors: true,
    });
    return {
      id: requireId(user.id, 'getBotInfo'),
      username: user.username,
      globalName: user.global_name ?? null,
      avatar: user.avatar ?? null,
    };
  }

  async getApplicationInfo(): Promise<DiscordApplicationInfo> {
    const app = await this.request<{
      id: string;
      name: string;
      description?: string;
      bot_public?: boolean;
      verify_key?: string;
    }>('GET', '/oauth2/applications/@me', undefined, {
      retryNetworkErrors: true,
      retryServerErrors: true,
    });
    return {
      id: requireId(app.id, 'getApplicationInfo'),
      name: app.name,
      description: app.description ?? '',
      botPublic: app.bot_public ?? false,
      verifyKey: app.verify_key ?? '',
    };
  }

  async registerCommands(
    input: {
      applicationId?: string;
      guildId?: string;
    } = {},
  ): Promise<void> {
    const applicationId =
      input.applicationId ??
      this.options.applicationId ??
      (await this.getApplicationInfo()).id;
    const scope = input.guildId ? `/guilds/${input.guildId}` : '';
    await this.request(
      'PUT',
      `/applications/${applicationId}${scope}/commands`,
      [
        {
          name: 'new',
          description: 'Start a fresh Roomote task',
          type: 1,
          options: [
            {
              type: 3,
              name: 'request',
              description: 'What would you like Roomote to do?',
              required: true,
            },
          ],
        },
        {
          name: 'link',
          description: 'Link this Discord account to Roomote',
          type: 1,
          options: [
            {
              type: 3,
              name: 'code',
              description: 'The link code shown in Roomote',
              required: true,
            },
          ],
        },
        { name: 'help', description: 'Show Roomote command help', type: 1 },
      ],
      { retryNetworkErrors: true, retryServerErrors: true },
    );
  }

  async createDirectMessage(recipientId: string): Promise<DiscordChannel> {
    const channel = await this.request<DiscordApiChannel>(
      'POST',
      '/users/@me/channels',
      { recipient_id: recipientId },
      { retryNetworkErrors: false, retryServerErrors: false },
    );
    return this.normalizeChannel(channel);
  }

  async listGuilds(): Promise<DiscordGuild[]> {
    const guilds: DiscordApiGuild[] = [];
    const seenCursors = new Set<string>();
    let after: string | null = null;

    while (true) {
      const query = new URLSearchParams({ limit: '200' });
      if (after) query.set('after', after);
      const page = await this.request<DiscordApiGuild[]>(
        'GET',
        `/users/@me/guilds?${query.toString()}`,
        undefined,
        { retryNetworkErrors: true, retryServerErrors: true },
      );
      guilds.push(...page);

      if (page.length < 200) {
        break;
      }

      const nextCursor = page.at(-1)?.id;
      if (!nextCursor || seenCursors.has(nextCursor)) {
        throw new Error('Discord guild pagination cursor did not advance.');
      }
      seenCursors.add(nextCursor);
      after = nextCursor;
    }

    return [...new Map(guilds.map((guild) => [guild.id, guild])).values()].map(
      (guild) => ({
        id: guild.id,
        name: guild.name,
        icon: guild.icon ?? null,
        ...(guild.owner === undefined ? {} : { owner: guild.owner }),
        ...(guild.permissions ? { permissions: guild.permissions } : {}),
      }),
    );
  }

  async listGuildChannels(guildId: string): Promise<DiscordChannel[]> {
    const channels = await this.request<DiscordApiChannel[]>(
      'GET',
      `/guilds/${guildId}/channels`,
      undefined,
      { retryNetworkErrors: true, retryServerErrors: true },
    );
    return channels.map((channel) => this.normalizeChannel(channel));
  }

  async getChannel(channelId: string): Promise<DiscordChannel> {
    const channel = await this.request<DiscordApiChannel>(
      'GET',
      `/channels/${channelId}`,
      undefined,
      { retryNetworkErrors: true, retryServerErrors: true },
    );
    return this.normalizeChannel(channel);
  }

  async editChannel(input: {
    channelId: string;
    name?: string;
    archived?: boolean;
    locked?: boolean;
  }): Promise<DiscordChannel> {
    const channel = await this.request<DiscordApiChannel>(
      'PATCH',
      `/channels/${input.channelId}`,
      {
        ...(input.name ? { name: input.name.slice(0, 100) } : {}),
        ...(input.archived === undefined ? {} : { archived: input.archived }),
        ...(input.locked === undefined ? {} : { locked: input.locked }),
      },
      { retryNetworkErrors: true, retryServerErrors: true },
    );
    return this.normalizeChannel(channel);
  }

  async diagnoseChannelPermissions(input: {
    guildId: string;
    channelId: string;
  }): Promise<DiscordChannelPermissionDiagnostics> {
    // The guild-members endpoint takes a real user id — Discord rejects the
    // literal `@me` there with 400 Invalid Form Body (unlike /users/@me).
    const bot = await this.getBotInfo();
    const [member, roles, channel] = await Promise.all([
      this.request<{ roles?: string[] }>(
        'GET',
        `/guilds/${input.guildId}/members/${bot.id}`,
        undefined,
        { retryNetworkErrors: true, retryServerErrors: true },
      ),
      this.request<Array<{ id: string; permissions: string }>>(
        'GET',
        `/guilds/${input.guildId}/roles`,
        undefined,
        { retryNetworkErrors: true, retryServerErrors: true },
      ),
      this.request<DiscordApiChannel>(
        'GET',
        `/channels/${input.channelId}`,
        undefined,
        { retryNetworkErrors: true, retryServerErrors: true },
      ),
    ]);

    const memberRoleIds = new Set([input.guildId, ...(member.roles ?? [])]);
    let value = roles.reduce(
      (result, role) =>
        memberRoleIds.has(role.id) ? result | BigInt(role.permissions) : result,
      0n,
    );
    if ((value & DISCORD_PERMISSION_BITS.administrator) !== 0n) {
      value = Object.values(DISCORD_PERMISSION_BITS).reduce(
        (result, bit) => result | bit,
        value,
      );
    } else {
      const overwrites = channel.permission_overwrites ?? [];
      value = this.applyOverwrite(
        value,
        overwrites.find((overwrite) => overwrite.id === input.guildId),
      );
      const roleOverwrites = overwrites.filter(
        (overwrite) =>
          overwrite.type === 0 &&
          overwrite.id !== input.guildId &&
          memberRoleIds.has(overwrite.id),
      );
      const roleDeny = roleOverwrites.reduce(
        (result, overwrite) => result | BigInt(overwrite.deny),
        0n,
      );
      const roleAllow = roleOverwrites.reduce(
        (result, overwrite) => result | BigInt(overwrite.allow),
        0n,
      );
      value = (value & ~roleDeny) | roleAllow;
      value = this.applyOverwrite(
        value,
        overwrites.find(
          (overwrite) => overwrite.type === 1 && overwrite.id === bot.id,
        ),
      );
    }

    const names = Object.keys(DISCORD_PERMISSION_BITS).filter(
      (name): name is DiscordPermissionName => name !== 'administrator',
    );
    const permissions = Object.fromEntries(
      names.map((name) => [
        name,
        (value & DISCORD_PERMISSION_BITS[name]) !== 0n,
      ]),
    ) as Record<DiscordPermissionName, boolean>;
    const requiredPermissions: DiscordPermissionName[] = [
      'view_channel',
      'send_messages',
      'read_message_history',
      'embed_links',
      'attach_files',
      'add_reactions',
    ];
    if (DISCORD_CHANNEL_TYPES_FORUM.has(channel.type)) {
      requiredPermissions.push('send_messages_in_threads');
    } else if (channel.type === 0 || channel.type === 5) {
      requiredPermissions.push(
        'create_public_threads',
        'send_messages_in_threads',
      );
    }
    const normalizedChannel = this.normalizeChannel(channel);
    const requiresTag = discordChannelRequiresTag(normalizedChannel);
    const hasUnmoderatedTag = Boolean(
      selectAutomaticForumTag(normalizedChannel.availableTags, {
        canUseModeratedTags: false,
      }),
    );
    // Moderated-only required-tag forums need MANAGE_THREADS to apply a tag.
    if (
      requiresTag &&
      (normalizedChannel.availableTags?.length ?? 0) > 0 &&
      !hasUnmoderatedTag
    ) {
      requiredPermissions.push('manage_threads');
    }
    const missingPermissions = requiredPermissions.filter(
      (name) => !permissions[name],
    );
    // Mark unsupported only when Discord requires a tag and the channel exposes
    // none at all. Moderated-only forums stay permission-gated via manage_threads.
    const requiredTagUnavailable =
      requiresTag && (normalizedChannel.availableTags?.length ?? 0) === 0;
    return {
      guildId: input.guildId,
      channelId: input.channelId,
      channelType: channel.type,
      permissions,
      requiredPermissions,
      missingPermissions,
      requiresTag,
      availableTags: normalizedChannel.availableTags ?? [],
      unsupportedReason: requiredTagUnavailable ? 'forum_requires_tag' : null,
      canUseChannel: missingPermissions.length === 0 && !requiredTagUnavailable,
    };
  }

  private normalizeChannel(channel: DiscordApiChannel): DiscordChannel {
    return {
      id: channel.id,
      ...(channel.guild_id ? { guildId: channel.guild_id } : {}),
      ...(channel.parent_id ? { parentId: channel.parent_id } : {}),
      name: channel.name ?? 'Direct message',
      type: channel.type,
      ...(channel.position === undefined ? {} : { position: channel.position }),
      ...(channel.flags === undefined ? {} : { flags: channel.flags }),
      ...(channel.available_tags
        ? {
            availableTags: channel.available_tags.map((tag) => ({
              id: tag.id,
              name: tag.name,
              moderated: tag.moderated,
              emojiId: tag.emoji_id ?? null,
              emojiName: tag.emoji_name ?? null,
            })),
          }
        : {}),
    };
  }

  private applyOverwrite(
    value: bigint,
    overwrite: DiscordPermissionOverwrite | undefined,
  ): bigint {
    return overwrite
      ? (value & ~BigInt(overwrite.deny)) | BigInt(overwrite.allow)
      : value;
  }

  private async awaitRateLimit(route: string): Promise<void> {
    const bucket = this.bucketByRoute.get(route);
    const resetAt = Math.max(
      this.globalResetAt,
      bucket ? (this.bucketResetAt.get(bucket) ?? 0) : 0,
    );
    const delayMs = resetAt - Date.now();
    if (delayMs > 0) await this.sleep(delayMs);
  }

  private rememberRateLimit(
    route: string,
    response: Response,
    body: unknown,
  ): number {
    const bucketHeader = response.headers.get('x-ratelimit-bucket');
    const bucket = bucketHeader ? `${route}:${bucketHeader}` : route;
    if (bucketHeader) this.bucketByRoute.set(route, bucket);

    const remaining = response.headers.get('x-ratelimit-remaining');
    const resetAfterSeconds =
      parseSeconds(response.headers.get('x-ratelimit-reset-after')) ??
      (typeof body === 'object' && body && 'retry_after' in body
        ? Number((body as { retry_after: unknown }).retry_after)
        : undefined);
    const delayMs =
      Number.isFinite(resetAfterSeconds) && (resetAfterSeconds ?? 0) >= 0
        ? Math.ceil((resetAfterSeconds ?? 0) * 1_000)
        : 0;
    if (remaining === '0' && delayMs > 0) {
      this.bucketResetAt.set(bucket, Date.now() + delayMs);
    }
    if (
      response.status === 429 &&
      typeof body === 'object' &&
      body &&
      'global' in body &&
      (body as { global?: unknown }).global === true
    ) {
      this.globalResetAt = Date.now() + delayMs;
    }
    return delayMs;
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    options: DiscordRequestOptions,
  ): Promise<T> {
    const visiblePath = options.routePath ?? path;
    const route = normalizeRoute(
      method,
      visiblePath.split('?')[0] ?? visiblePath,
    );
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.awaitRateLimit(route);
      try {
        const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
          method,
          headers: {
            ...(options.authorization === false
              ? {}
              : { authorization: `Bot ${this.options.botToken}` }),
            'content-type': 'application/json',
            'user-agent': 'Roomote Discord Provider',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const parsed =
          response.status === 204
            ? undefined
            : await response.json().catch(() => undefined);
        const rateLimitDelayMs = this.rememberRateLimit(
          route,
          response,
          parsed,
        );

        if (response.status === 429 && attempt < this.maxRetries) {
          const retryAfterHeader = parseSeconds(
            response.headers.get('retry-after'),
          );
          const retryAfterBody =
            typeof parsed === 'object' && parsed && 'retry_after' in parsed
              ? Number((parsed as { retry_after: unknown }).retry_after)
              : undefined;
          const retryAfterMs = Math.max(
            rateLimitDelayMs,
            retryAfterHeader === undefined ? 0 : retryAfterHeader * 1_000,
            Number.isFinite(retryAfterBody) ? (retryAfterBody ?? 0) * 1_000 : 0,
            DISCORD_RETRY_BASE_DELAY_MS * 2 ** attempt,
          );
          await this.sleep(retryAfterMs);
          continue;
        }
        if (
          response.status >= 500 &&
          options.retryServerErrors &&
          attempt < this.maxRetries
        ) {
          await this.sleep(DISCORD_RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        if (!response.ok) {
          const errorBody =
            typeof parsed === 'object' && parsed
              ? (parsed as {
                  message?: unknown;
                  code?: number | string;
                  retry_after?: unknown;
                })
              : undefined;
          throw new DiscordApiError({
            method,
            path: visiblePath,
            status: response.status,
            message:
              typeof errorBody?.message === 'string'
                ? errorBody.message
                : response.statusText || 'Unknown API error',
            ...(errorBody?.code === undefined ? {} : { code: errorBody.code }),
            ...(rateLimitDelayMs ? { retryAfterMs: rateLimitDelayMs } : {}),
          });
        }
        return parsed as T;
      } catch (error) {
        lastError = error;
        if (error instanceof DiscordApiError) {
          throw error;
        }
        if (!options.retryNetworkErrors || attempt >= this.maxRetries) {
          throw new DiscordApiTransportError({
            method,
            path: visiblePath,
            cause: error,
          });
        }
        await this.sleep(DISCORD_RETRY_BASE_DELAY_MS * 2 ** attempt);
      }
    }
    throw lastError ?? new Error(`Discord ${method} ${path} failed.`);
  }
}

/**
 * Map Slack-style reaction names used by the agent tooling onto Discord
 * unicode emoji. Discord's reaction API expects encoded unicode (or custom
 * emoji names), not Slack `:eyes:`-style aliases.
 */
const DISCORD_REACTION_EMOJI_BY_NAME: Record<string, string> = {
  eyes: '👀',
  thumbsup: '👍',
  '+1': '👍',
  like: '👍',
  thumbsdown: '👎',
  '-1': '👎',
  white_check_mark: '✅',
  heavy_check_mark: '✔️',
  checkered_flag: '🏁',
  x: '❌',
  negative_squared_cross_mark: '❎',
  no_entry_sign: '🚫',
  tada: '🎉',
  heart: '❤️',
  fire: '🔥',
  clap: '👏',
  think: '🤔',
  thinking_face: '🤔',
  ok_hand: '👌',
  pray: '🙏',
  '100': '💯',
  wave: '👋',
  trophy: '🏆',
  handshake: '🤝',
  saluting_face: '🫡',
  rocket: '🚀',
  joy: '😆',
  laugh: '😆',
  smile: '😄',
  open_mouth: '😮',
  surprised: '😮',
  scream: '😱',
  sad: '😢',
  cry: '😢',
  angry: '😠',
  rage: '😡',
  ghost: '👻',
  hourglass: '⏳',
  hourglass_flowing_sand: '⏳',
};

function resolveDiscordReactionEmoji(name: string): string {
  const cleaned = name.replace(/^:|:$/gu, '').trim();
  if (!cleaned) {
    return cleaned;
  }

  const mapped = DISCORD_REACTION_EMOJI_BY_NAME[cleaned.toLowerCase()];
  if (mapped) {
    return mapped;
  }

  return cleaned;
}
