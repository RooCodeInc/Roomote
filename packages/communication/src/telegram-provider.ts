import type {
  CommunicationChannelMessagesResult,
  CommunicationMessageButton,
  CommunicationPostMessageInput,
  CommunicationPostMessageResult,
  CommunicationProviderAdapter,
  CommunicationReactionResult,
  CommunicationThreadLookupResult,
} from './provider';
import { UnsupportedCommunicationOperationError } from './provider';
import { getTelegramApiBaseUrl } from './telegram-api-base-url';
import {
  TELEGRAM_MAX_MESSAGE_LENGTH,
  chunkTelegramMarkdown,
  chunkTelegramMarkdownAsHtml,
} from './telegram-format';

export type TelegramCommunicationProviderOptions = {
  botToken: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
};

export type TelegramForumTopic = {
  messageThreadId: string;
  name: string;
};

export type TelegramBotInfo = {
  hasTopicsEnabled: boolean;
};

type TelegramApiResponse =
  | {
      ok: true;
      result: {
        message_id: number;
        message_thread_id?: number;
      };
    }
  | {
      ok: false;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };

const DEFAULT_TELEGRAM_TIMEOUT_MS = 10_000;
const DEFAULT_TELEGRAM_MAX_RETRIES = 2;
const TELEGRAM_RETRY_BASE_DELAY_MS = 250;

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

type TelegramInlineKeyboardMarkup = {
  inline_keyboard: Array<
    Array<{ text: string; callback_data?: string; url?: string }>
  >;
};

function buildTelegramReplyMarkup(
  buttons: CommunicationMessageButton[][] | undefined,
): TelegramInlineKeyboardMarkup | undefined {
  const rows = (buttons ?? [])
    .map((row) =>
      row
        .filter((button) => button.callbackData || button.url)
        .map((button) => ({
          text: button.text,
          ...(button.url
            ? { url: button.url }
            : { callback_data: button.callbackData }),
        })),
    )
    .filter((row) => row.length > 0);

  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

export class TelegramCommunicationProvider implements CommunicationProviderAdapter {
  readonly provider = 'telegram' as const;

  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly options: TelegramCommunicationProviderOptions) {
    this.apiBaseUrl = options.apiBaseUrl ?? getTelegramApiBaseUrl();
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TELEGRAM_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_TELEGRAM_MAX_RETRIES;
  }

  async postMessage(
    input: CommunicationPostMessageInput,
  ): Promise<CommunicationPostMessageResult> {
    const text = input.text?.trim();
    const images = input.images ?? [];

    if (!text && images.length === 0) {
      throw new Error('Telegram postMessage requires text or images.');
    }

    const threadId = parsePositiveInteger(input.threadId);
    // Honor an explicit reply target when callers supply one (task closeouts,
    // launch-failure recovery, onboarding threads). Callers that prefer a
    // free-floating chronological send simply omit replyToMessageId.
    const replyToMessageId = parsePositiveInteger(input.replyToMessageId);
    const useMarkdown = input.textFormat === 'markdown';
    const chunks: Array<{ markdown: string; html: string | null }> = text
      ? useMarkdown
        ? chunkTelegramMarkdownAsHtml(text)
        : chunkTelegramMarkdown(text, TELEGRAM_MAX_MESSAGE_LENGTH).map(
            (chunk) => ({ markdown: chunk, html: null }),
          )
      : [];

    let firstResult: {
      message_id: number;
      message_thread_id?: number;
    } | null = null;

    const replyMarkup = buildTelegramReplyMarkup(input.buttons);
    const lastSendIndex = chunks.length + images.length - 1;

    for (const [index, chunk] of chunks.entries()) {
      const result = await this.sendMessageChunk({
        chatId: input.channelId,
        markdown: chunk.markdown,
        html: chunk.html,
        threadId,
        // Reply threading only anchors the first message of a long reply;
        // buttons attach to the last message so they sit under the content.
        replyToMessageId: index === 0 ? replyToMessageId : undefined,
        replyMarkup: index === lastSendIndex ? replyMarkup : undefined,
      });

      firstResult ??= result;
    }

    for (const [index, image] of images.entries()) {
      const result = await this.sendPhoto({
        chatId: input.channelId,
        url: image.url,
        caption: image.altText,
        threadId,
        replyToMessageId:
          firstResult === null && index === 0 ? replyToMessageId : undefined,
        replyMarkup:
          chunks.length + index === lastSendIndex ? replyMarkup : undefined,
      });

      firstResult ??= result;
    }

    if (!firstResult) {
      throw new Error('Telegram postMessage produced no message chunks.');
    }

    return {
      provider: 'telegram',
      channelId: input.channelId,
      messageId: String(firstResult.message_id),
      ...(firstResult.message_thread_id !== undefined
        ? { threadId: String(firstResult.message_thread_id) }
        : input.threadId
          ? { threadId: input.threadId }
          : {}),
    };
  }

  private async sendPhoto(params: {
    chatId: string;
    url: string;
    caption?: string;
    threadId?: number;
    replyToMessageId?: number;
    replyMarkup?: TelegramInlineKeyboardMarkup;
  }): Promise<{ message_id: number; message_thread_id?: number }> {
    const response = await this.fetchWithRetry(
      `${this.apiBaseUrl.replace(/\/$/, '')}/bot${this.options.botToken}/sendPhoto`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: params.chatId,
          photo: params.url,
          ...(params.caption ? { caption: params.caption } : {}),
          ...(params.threadId ? { message_thread_id: params.threadId } : {}),
          ...(params.replyMarkup ? { reply_markup: params.replyMarkup } : {}),
          ...(params.replyToMessageId
            ? {
                reply_parameters: {
                  message_id: params.replyToMessageId,
                  allow_sending_without_reply: true,
                },
              }
            : {}),
        }),
      },
      { method: 'sendPhoto', retryNetworkErrors: false },
    );
    const parsed = (await response
      .json()
      .catch(() => null)) as TelegramApiResponse | null;

    if (response.ok && parsed?.ok) {
      return parsed.result;
    }

    // Telegram fetches the photo URL itself and can reject it (size limits,
    // unreachable host, unsupported type) — fall back to sending the link.
    return this.sendMessageChunk({
      chatId: params.chatId,
      markdown: params.caption
        ? `${params.caption}: ${params.url}`
        : params.url,
      html: null,
      threadId: params.threadId,
      replyToMessageId: params.replyToMessageId,
      replyMarkup: params.replyMarkup,
    });
  }

  private async sendMessageChunk(params: {
    chatId: string;
    markdown: string;
    html: string | null;
    threadId?: number;
    replyToMessageId?: number;
    replyMarkup?: TelegramInlineKeyboardMarkup;
  }): Promise<{ message_id: number; message_thread_id?: number }> {
    const attempts: Array<{ text: string; parseMode?: 'HTML' }> = params.html
      ? [
          { text: params.html, parseMode: 'HTML' },
          // Telegram rejects the whole message when entity parsing fails,
          // so fall back to the raw markdown as plain text.
          { text: params.markdown },
        ]
      : [{ text: params.markdown }];

    let lastError: Error | null = null;

    for (const attempt of attempts) {
      const body = {
        chat_id: params.chatId,
        text: attempt.text,
        ...(attempt.parseMode ? { parse_mode: attempt.parseMode } : {}),
        link_preview_options: {
          is_disabled: true,
        },
        ...(params.threadId ? { message_thread_id: params.threadId } : {}),
        ...(params.replyMarkup ? { reply_markup: params.replyMarkup } : {}),
        ...(params.replyToMessageId
          ? {
              reply_parameters: {
                message_id: params.replyToMessageId,
                allow_sending_without_reply: true,
              },
            }
          : {}),
      };
      const response = await this.fetchWithRetry(
        `${this.apiBaseUrl.replace(/\/$/, '')}/bot${this.options.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        { method: 'sendMessage', retryNetworkErrors: false },
      );
      const parsed = (await response
        .json()
        .catch(() => null)) as TelegramApiResponse | null;

      if (response.ok && parsed?.ok) {
        return parsed.result;
      }

      const description =
        parsed && !parsed.ok && 'description' in parsed
          ? parsed.description
          : undefined;
      lastError = new Error(
        `Telegram sendMessage failed${
          response.status ? ` (${response.status})` : ''
        }: ${description ?? response.statusText}`,
      );

      const isEntityParseError =
        attempt.parseMode === 'HTML' &&
        response.status === 400 &&
        Boolean(description?.toLowerCase().includes("can't parse entities"));

      if (!isEntityParseError) {
        throw lastError;
      }
    }

    throw lastError ?? new Error('Telegram sendMessage failed.');
  }

  /** Acknowledge a callback query so the button stops showing a spinner. */
  async answerCallbackQuery(input: {
    callbackQueryId: string;
    text?: string;
  }): Promise<void> {
    await this.callBotApi('answerCallbackQuery', {
      callback_query_id: input.callbackQueryId,
      ...(input.text ? { text: input.text } : {}),
    });
  }

  /**
   * Replace the text (and keyboard) of an existing bot message. Mirrors the
   * postMessage markdown handling: try Telegram HTML, fall back to the raw
   * markdown as plain text when entity parsing fails. The edited text must
   * fit in one message — this is for cards and status lines, not replies.
   */
  async editMessageText(input: {
    channelId: string;
    messageId: string;
    text: string;
    textFormat?: 'plain' | 'markdown';
    buttons?: CommunicationMessageButton[][];
  }): Promise<void> {
    const useMarkdown = input.textFormat === 'markdown';
    const firstChunk = useMarkdown
      ? chunkTelegramMarkdownAsHtml(input.text)[0]
      : null;
    const attempts: Array<{ text: string; parseMode?: 'HTML' }> =
      firstChunk?.html
        ? [
            { text: firstChunk.html, parseMode: 'HTML' },
            { text: firstChunk.markdown },
          ]
        : [{ text: firstChunk?.markdown ?? input.text }];

    let lastError: Error | null = null;

    for (const attempt of attempts) {
      const response = await this.fetchWithRetry(
        `${this.apiBaseUrl.replace(/\/$/, '')}/bot${this.options.botToken}/editMessageText`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: input.channelId,
            message_id: Number.parseInt(input.messageId, 10),
            text: attempt.text,
            ...(attempt.parseMode ? { parse_mode: attempt.parseMode } : {}),
            link_preview_options: { is_disabled: true },
            reply_markup: buildTelegramReplyMarkup(input.buttons) ?? {
              inline_keyboard: [],
            },
          }),
        },
        { method: 'editMessageText', retryNetworkErrors: true },
      );
      const parsed = (await response.json().catch(() => null)) as {
        ok?: boolean;
        description?: string;
      } | null;

      if (response.ok && parsed?.ok) {
        return;
      }

      const description = parsed?.description;
      lastError = new Error(
        `Telegram editMessageText failed${
          response.status ? ` (${response.status})` : ''
        }: ${description ?? response.statusText}`,
      );

      const isEntityParseError =
        attempt.parseMode === 'HTML' &&
        response.status === 400 &&
        Boolean(description?.toLowerCase().includes("can't parse entities"));

      if (!isEntityParseError) {
        throw lastError;
      }
    }

    throw lastError ?? new Error('Telegram editMessageText failed.');
  }

  /** Replace or remove the inline keyboard on an existing message. */
  async editMessageReplyMarkup(input: {
    channelId: string;
    messageId: string;
    buttons?: CommunicationMessageButton[][];
  }): Promise<void> {
    await this.callBotApi('editMessageReplyMarkup', {
      chat_id: input.channelId,
      message_id: Number.parseInt(input.messageId, 10),
      reply_markup: buildTelegramReplyMarkup(input.buttons) ?? {
        inline_keyboard: [],
      },
    });
  }

  /**
   * Show a chat action (default `typing`). Telegram displays it for ~5s then
   * clears it automatically, and any message the bot sends clears it early —
   * so this is a fire-and-forget burst, re-sent on a heartbeat to span a
   * longer reply delivery, never a state that must be turned off.
   */
  async sendChatAction(input: {
    channelId: string;
    action?: string;
    threadId?: string;
  }): Promise<void> {
    const threadId = parsePositiveInteger(input.threadId);
    await this.callBotApi('sendChatAction', {
      chat_id: input.channelId,
      action: input.action ?? 'typing',
      ...(threadId ? { message_thread_id: threadId } : {}),
    });
  }

  /**
   * Read the bot capability flag Telegram exposes for private-chat Threaded
   * Mode. This avoids probing createForumTopic for bots that have it disabled.
   */
  async getBotInfo(): Promise<TelegramBotInfo> {
    const result = (await this.callBotApi('getMe', {})) as {
      has_topics_enabled?: boolean;
    };

    return { hasTopicsEnabled: result.has_topics_enabled === true };
  }

  /** Verifies that the bot can access a configured destination chat. */
  async getChat(channelId: string): Promise<void> {
    await this.callBotApi('getChat', { chat_id: channelId });
  }

  /**
   * Create a task-owned topic in a forum supergroup or a private chat whose
   * bot has Threaded Mode enabled in BotFather.
   */
  async createForumTopic(input: {
    channelId: string;
    name: string;
  }): Promise<TelegramForumTopic> {
    const result = (await this.callBotApi('createForumTopic', {
      chat_id: input.channelId,
      name: input.name,
    })) as {
      message_thread_id?: number;
      name?: string;
    };

    if (!Number.isSafeInteger(result.message_thread_id)) {
      throw new Error(
        'Telegram createForumTopic returned no message_thread_id.',
      );
    }

    return {
      messageThreadId: String(result.message_thread_id),
      name: result.name ?? input.name,
    };
  }

  /** Rename an existing forum topic, including private-chat bot topics. */
  async editForumTopic(input: {
    channelId: string;
    threadId: string;
    name: string;
  }): Promise<void> {
    const threadId = parsePositiveInteger(input.threadId);

    if (!threadId) {
      throw new Error('Telegram editForumTopic requires a valid thread id.');
    }

    await this.callBotApi('editForumTopic', {
      chat_id: input.channelId,
      message_thread_id: threadId,
      name: input.name,
    });
  }

  /** Delete a message the bot sent (Bot API allows this within 48 hours). */
  async deleteMessage(input: {
    channelId: string;
    messageId: string;
  }): Promise<void> {
    await this.callBotApi('deleteMessage', {
      chat_id: input.channelId,
      message_id: Number.parseInt(input.messageId, 10),
    });
  }

  /**
   * Point Telegram's webhook at the deployment and enable the update types
   * the integration depends on (button clicks arrive as callback_query).
   */
  async registerWebhook(input: {
    url: string;
    secretToken: string;
  }): Promise<void> {
    await this.callBotApi('setWebhook', {
      url: input.url,
      secret_token: input.secretToken,
      allowed_updates: ['message', 'callback_query'],
    });
  }

  /** Keep Telegram's slash-command picker in sync with supported commands. */
  async registerCommands(): Promise<void> {
    await this.callBotApi('setMyCommands', {
      commands: [
        { command: 'start', description: 'Show welcome and command help' },
        { command: 'new', description: 'Start a fresh task' },
      ],
    });
  }

  /** Resolve and download a Telegram-hosted file without exposing the token. */
  async downloadFile(
    fileId: string,
    maxBytes: number,
  ): Promise<{
    bytes: Uint8Array;
    filePath: string;
    contentType: string | null;
  }> {
    const file = (await this.callBotApi('getFile', {
      file_id: fileId,
    })) as { file_path?: string; file_size?: number };
    if (!file.file_path) throw new Error('Telegram getFile returned no path.');
    if (file.file_size && file.file_size > maxBytes) {
      throw new Error(`Telegram file exceeds the ${maxBytes} byte limit.`);
    }

    const response = await this.fetchWithRetry(
      `${this.apiBaseUrl.replace(/\/bot$/u, '').replace(/\/$/u, '')}/file/bot${this.options.botToken}/${file.file_path}`,
      { method: 'GET' },
      { method: 'downloadFile', retryNetworkErrors: true },
    );
    if (!response.ok) {
      throw new Error(`Telegram downloadFile failed (${response.status}).`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`Telegram file exceeds the ${maxBytes} byte limit.`);
    }
    return {
      bytes,
      filePath: file.file_path,
      contentType: response.headers.get('content-type'),
    };
  }

  async getWebhookInfo(): Promise<{
    url: string;
    pendingUpdateCount: number;
    lastErrorMessage: string | null;
    lastErrorAtMs: number | null;
    allowedUpdates: string[];
  }> {
    const result = (await this.callBotApi('getWebhookInfo', {})) as {
      url?: string;
      pending_update_count?: number;
      last_error_message?: string;
      last_error_date?: number;
      allowed_updates?: string[];
    };

    return {
      url: result.url ?? '',
      pendingUpdateCount: result.pending_update_count ?? 0,
      lastErrorMessage: result.last_error_message ?? null,
      lastErrorAtMs: result.last_error_date
        ? result.last_error_date * 1000
        : null,
      allowedUpdates: result.allowed_updates ?? [],
    };
  }

  private async callBotApi(
    method: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.fetchWithRetry(
      `${this.apiBaseUrl.replace(/\/$/, '')}/bot${this.options.botToken}/${method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      { method, retryNetworkErrors: this.isIdempotentMethod(method) },
    );
    const parsed = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: unknown;
      description?: string;
    } | null;

    if (!response.ok || !parsed?.ok) {
      throw new Error(
        `Telegram ${method} failed${
          response.status ? ` (${response.status})` : ''
        }: ${parsed?.description ?? response.statusText}`,
      );
    }

    return parsed.result;
  }

  private isIdempotentMethod(method: string): boolean {
    return [
      'getMe',
      'getFile',
      'getWebhookInfo',
      'setWebhook',
      'setMyCommands',
      'sendChatAction',
      'editMessageText',
      'editMessageReplyMarkup',
      'editForumTopic',
      'deleteMessage',
      'setMessageReaction',
      'answerCallbackQuery',
    ].includes(method);
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    options: { method: string; retryNetworkErrors: boolean },
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          ...init,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (
          attempt < this.maxRetries &&
          (response.status === 429 ||
            (options.retryNetworkErrors && response.status >= 500))
        ) {
          const body = (await response
            .clone()
            .json()
            .catch(() => null)) as {
            parameters?: { retry_after?: number };
          } | null;
          const delayMs = body?.parameters?.retry_after
            ? body.parameters.retry_after * 1000
            : TELEGRAM_RETRY_BASE_DELAY_MS * 2 ** attempt;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (!options.retryNetworkErrors || attempt >= this.maxRetries)
          throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, TELEGRAM_RETRY_BASE_DELAY_MS * 2 ** attempt),
        );
      }
    }
    throw lastError ?? new Error(`Telegram ${options.method} failed.`);
  }

  async fetchThreadMessages(_input: {
    channelId: string;
    messageId: string;
  }): Promise<CommunicationThreadLookupResult> {
    throw new UnsupportedCommunicationOperationError({
      provider: 'telegram',
      operation: 'fetchThreadMessages',
      message:
        'Telegram thread history reads are not supported by the Bot API adapter.',
      help: 'Use queued Telegram webhook messages for active task context.',
    });
  }

  async fetchChannelMessages(_input: {
    channelId: string;
    oldest?: string;
    latest?: string;
  }): Promise<CommunicationChannelMessagesResult> {
    throw new UnsupportedCommunicationOperationError({
      provider: 'telegram',
      operation: 'fetchChannelMessages',
      message:
        'Telegram channel history reads are not supported by the Bot API adapter.',
      help: 'Use queued Telegram webhook messages for active task context.',
    });
  }

  async addReaction(input: {
    channelId: string;
    messageId: string;
    name: string;
  }): Promise<CommunicationReactionResult> {
    const emoji = resolveTelegramReactionEmoji(input.name);

    if (!emoji) {
      throw new UnsupportedCommunicationOperationError({
        provider: 'telegram',
        operation: 'addReaction',
        message: `Telegram does not support the reaction "${input.name}".`,
        help: `Use one of: ${Object.keys(TELEGRAM_REACTION_EMOJI_BY_NAME).join(', ')}.`,
      });
    }

    const response = await this.fetchWithRetry(
      `${this.apiBaseUrl.replace(/\/$/, '')}/bot${this.options.botToken}/setMessageReaction`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: input.channelId,
          message_id: Number.parseInt(input.messageId, 10),
          reaction: [{ type: 'emoji', emoji }],
        }),
      },
      { method: 'setMessageReaction', retryNetworkErrors: true },
    );
    const parsed = (await response.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
    } | null;

    if (!response.ok || !parsed?.ok) {
      throw new Error(
        `Telegram setMessageReaction failed${
          response.status ? ` (${response.status})` : ''
        }: ${parsed?.description ?? response.statusText}`,
      );
    }

    return {
      provider: 'telegram',
      channelId: input.channelId,
      messageId: input.messageId,
      name: input.name,
    };
  }
}

/**
 * Telegram bots may only react with a fixed emoji set
 * (https://core.telegram.org/bots/api#reactiontypeemoji). Map the
 * Slack-style reaction names used across Roomote onto that set.
 */
const TELEGRAM_REACTION_EMOJI_BY_NAME: Record<string, string> = {
  eyes: '👀',
  thumbsup: '👍',
  '+1': '👍',
  thumbsdown: '👎',
  '-1': '👎',
  tada: '🎉',
  heart: '❤',
  fire: '🔥',
  clap: '👏',
  thinking_face: '🤔',
  ok_hand: '👌',
  pray: '🙏',
  '100': '💯',
  trophy: '🏆',
  handshake: '🤝',
  saluting_face: '🫡',
  joy: '🤣',
  scream: '😱',
  ghost: '👻',
};

function resolveTelegramReactionEmoji(name: string): string | undefined {
  const mapped = TELEGRAM_REACTION_EMOJI_BY_NAME[name.replaceAll(':', '')];

  if (mapped) {
    return mapped;
  }

  // Allow passing a supported Telegram reaction emoji through directly.
  return Object.values(TELEGRAM_REACTION_EMOJI_BY_NAME).includes(name)
    ? name
    : undefined;
}
