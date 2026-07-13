import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';

type JsonRecord = Record<string, unknown>;

export type MockTelegramUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

export type MockTelegramChat = {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  /** Forum-mode supergroups carry topics via `message_thread_id`. */
  is_forum?: boolean;
};

export type MockTelegramStoredMessage = {
  message_id: number;
  /** Normalized to string so numeric and string chat ids compare equal. */
  chat_id: string;
  date: number;
  from: MockTelegramUser;
  text?: string;
  parse_mode?: string;
  caption?: string;
  photo_url?: string;
  message_thread_id?: number;
  reply_to_message_id?: number;
  reply_markup?: unknown;
  link_preview_disabled?: boolean;
  forum_topic_created?: { name: string; is_name_implicit?: boolean };
  reactions: string[];
};

export type MockTelegramBot = {
  id: number;
  username: string;
  first_name: string;
  /** Mirrors getMe.has_topics_enabled for private-chat Threaded Mode. */
  has_topics_enabled?: boolean;
};

export type MockTelegramWebhookRegistration = {
  url: string;
  secretToken?: string;
  allowedUpdates?: string[];
};

export type MockTelegramCallbackAnswer = {
  callback_query_id: string;
  text?: string;
};

export type MockTelegramChatAction = {
  chat_id: string;
  action: string;
  message_thread_id?: number;
};

/**
 * Failure-injection knobs. Real Telegram rejects whole requests for these
 * cases; the flags let tests exercise the provider's fallback paths.
 */
export type MockTelegramBehavior = {
  /** Reject `parse_mode: 'HTML'` sends with "can't parse entities". */
  rejectHtmlParseMode?: boolean;
  /** Reject `sendPhoto` as if Telegram could not fetch the photo URL. */
  rejectPhotos?: boolean;
};

export type MockTelegramState = {
  bot?: MockTelegramBot;
  /**
   * Bot tokens accepted on `/bot<token>/…` paths. Empty or omitted accepts
   * any token — convenient for exploratory runs; set it to catch requests
   * built with the wrong credential.
   */
  acceptedBotTokens?: string[];
  chats: MockTelegramChat[];
  users: MockTelegramUser[];
  messages?: MockTelegramStoredMessage[];
  webhook?: MockTelegramWebhookRegistration;
  callbackAnswers?: MockTelegramCallbackAnswer[];
  chatActions?: MockTelegramChatAction[];
  botCommands?: Array<{ command: string; description: string }>;
  behavior?: MockTelegramBehavior;
};

export type MockTelegramRoomoteTarget = {
  webhookUrl: string;
  secretToken: string;
};

/**
 * An inbound message as a scenario author writes it. `message_id` and `date`
 * are minted when omitted; `entities` are computed from the text (bot
 * commands and @mentions) when omitted, matching what real Telegram stamps
 * server-side — pass `entities` explicitly to override.
 */
export type MockTelegramInboundMessage = JsonRecord & {
  chat: JsonRecord & { id: number | string; type: string };
  from?: JsonRecord & { id: number };
  text?: string;
  message_id?: number;
  message_thread_id?: number;
  date?: number;
  entities?: Array<JsonRecord>;
};

export type MockTelegramReplayEvent =
  | {
      kind: 'message';
      updateId?: number;
      message: MockTelegramInboundMessage;
    }
  | {
      kind: 'edited_message';
      updateId?: number;
      message: MockTelegramInboundMessage;
    }
  | {
      kind: 'callback_query';
      updateId?: number;
      callbackQuery: JsonRecord & {
        id: string;
        from: JsonRecord;
        data?: string;
      };
    }
  | {
      /** Escape hatch: dispatch a raw Update object verbatim. */
      kind: 'update';
      update: JsonRecord;
    };

type MockTelegramDispatchResult = {
  status: number;
  body: string;
};

export const TELEGRAM_MESSAGE_TEXT_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1024;

const DEFAULT_BOT: MockTelegramBot = {
  id: 7_000_000_001,
  username: 'roomote_mock_bot',
  first_name: 'Roomote',
};

function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeState(state: MockTelegramState): MockTelegramState {
  return {
    ...cloneState(state),
    bot: { ...DEFAULT_BOT, ...state.bot },
    chats: state.chats.map((chat) => ({ ...chat })),
    users: state.users.map((user) => ({ ...user })),
    messages: (state.messages ?? []).map((message) => ({
      ...message,
      chat_id: String(message.chat_id),
      reactions: message.reactions ?? [],
    })),
    callbackAnswers: [...(state.callbackAnswers ?? [])],
    chatActions: [...(state.chatActions ?? [])],
    botCommands: [...(state.botCommands ?? [])],
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json',
  });
  response.end(JSON.stringify(body));
}

function text(response: ServerResponse, status: number, body: string) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
  });
  response.end(body);
}

function apiError(
  response: ServerResponse,
  errorCode: number,
  description: string,
) {
  json(response, errorCode, {
    ok: false,
    error_code: errorCode,
    description,
  });
}

function apiResult(response: ServerResponse, result: unknown) {
  json(response, 200, { ok: true, result });
}

/**
 * Real Telegram computes `entities` server-side; scenario authors should not
 * have to hand-count UTF-16 offsets. Detect bot commands and @mentions the
 * way Telegram does so `isTelegramBotMentioned` / `getTelegramNewTaskCommand`
 * behave against injected updates exactly as they do in production.
 */
export function computeTelegramEntities(
  messageText: string,
): Array<{ type: string; offset: number; length: number }> {
  const entities: Array<{ type: string; offset: number; length: number }> = [];
  const pattern = /(^|\s)(\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?|@[A-Za-z0-9_]+)/g;

  for (const match of messageText.matchAll(pattern)) {
    const token = match[2]!;
    const offset = match.index! + match[1]!.length;
    entities.push({
      type: token.startsWith('/') ? 'bot_command' : 'mention',
      offset,
      length: token.length,
    });
  }

  return entities;
}

export class MockTelegramServer {
  private server: Server | null = null;
  private state: MockTelegramState;
  private readonly roomoteTarget?: MockTelegramRoomoteTarget;
  private port: number | null = null;
  private messageSequence: number;
  // Seed from the clock so update ids never repeat across harness runs —
  // Roomote dedups updates by update_id in Redis with a 5-minute TTL.
  private updateSequence = Math.floor(Date.now() / 1000);

  constructor({
    state,
    roomoteTarget,
  }: {
    state: MockTelegramState;
    roomoteTarget?: MockTelegramRoomoteTarget;
  }) {
    this.state = normalizeState(state);
    this.roomoteTarget = roomoteTarget;
    this.messageSequence =
      Math.max(0, ...(this.state.messages ?? []).map((m) => m.message_id)) + 1;
  }

  public get baseUrl(): string {
    if (this.port === null) {
      throw new Error('Mock Telegram server is not running.');
    }

    return `http://127.0.0.1:${this.port}`;
  }

  public getState(): MockTelegramState {
    return cloneState(this.state);
  }

  public setState(state: MockTelegramState): void {
    this.state = normalizeState(state);
    this.messageSequence = Math.max(
      this.messageSequence,
      Math.max(0, ...(this.state.messages ?? []).map((m) => m.message_id)) + 1,
    );
  }

  public async start(port = 0): Promise<string> {
    if (this.server) {
      return this.baseUrl;
    }

    this.server = createServer(async (request, response) => {
      try {
        await this.handleRequest(request, response);
      } catch (error) {
        text(
          response,
          500,
          error instanceof Error
            ? error.message
            : 'Unknown mock Telegram error',
        );
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(port, '127.0.0.1', () => {
        this.server?.off('error', reject);
        resolve();
      });
    });

    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve mock Telegram server address.');
    }

    this.port = (address as AddressInfo).port;
    return this.baseUrl;
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;
    this.port = null;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  public nextUpdateId(): number {
    this.updateSequence += 1;
    return this.updateSequence;
  }

  private nextMessageId(): number {
    const id = this.messageSequence;
    this.messageSequence += 1;
    return id;
  }

  public async dispatch(
    event: MockTelegramReplayEvent,
  ): Promise<MockTelegramDispatchResult> {
    if (!this.roomoteTarget) {
      throw new Error(
        'No Roomote webhook target configured for mock Telegram replay.',
      );
    }

    const update = this.buildUpdate(event);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    if (this.roomoteTarget.secretToken) {
      headers['x-telegram-bot-api-secret-token'] =
        this.roomoteTarget.secretToken;
    }

    const response = await fetch(this.roomoteTarget.webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(update),
    });

    return {
      status: response.status,
      body: await response.text(),
    };
  }

  private buildUpdate(event: MockTelegramReplayEvent): JsonRecord {
    if (event.kind === 'update') {
      return {
        update_id: this.nextUpdateId(),
        ...event.update,
      };
    }

    if (event.kind === 'callback_query') {
      return {
        update_id: event.updateId ?? this.nextUpdateId(),
        callback_query: event.callbackQuery,
      };
    }

    const message = this.normalizeInboundMessage(event.message);

    return {
      update_id: event.updateId ?? this.nextUpdateId(),
      [event.kind === 'edited_message' ? 'edited_message' : 'message']: message,
    };
  }

  private normalizeInboundMessage(
    message: MockTelegramInboundMessage,
  ): JsonRecord {
    const normalized: JsonRecord = {
      message_id: message.message_id ?? this.nextMessageId(),
      date: message.date ?? Math.floor(Date.now() / 1000),
      ...message,
    };

    if (normalized.entities === undefined && typeof message.text === 'string') {
      const entities = computeTelegramEntities(message.text);
      if (entities.length > 0) {
        normalized.entities = entities;
      }
    }

    this.recordIncomingMessage(normalized);
    return normalized;
  }

  private recordIncomingMessage(message: JsonRecord): void {
    const chat = message.chat as MockTelegramChat | undefined;
    const from = message.from as MockTelegramUser | undefined;

    if (!chat?.id) {
      return;
    }

    if (
      !this.state.chats.some((entry) => String(entry.id) === String(chat.id))
    ) {
      this.state.chats = [...this.state.chats, { ...chat }];
    }

    if (from?.id && !this.state.users.some((entry) => entry.id === from.id)) {
      this.state.users = [...this.state.users, { ...from }];
    }

    const stored: MockTelegramStoredMessage = {
      message_id: Number(message.message_id),
      chat_id: String(chat.id),
      date: Number(message.date),
      from: from ?? { id: 0 },
      ...(typeof message.text === 'string' ? { text: message.text } : {}),
      ...(typeof message.message_thread_id === 'number'
        ? { message_thread_id: message.message_thread_id }
        : {}),
      reactions: [],
    };

    const existingIndex = (this.state.messages ?? []).findIndex(
      (entry) =>
        entry.chat_id === stored.chat_id &&
        entry.message_id === stored.message_id,
    );

    if (existingIndex >= 0) {
      this.state.messages?.splice(existingIndex, 1, stored);
      return;
    }

    this.state.messages = [...(this.state.messages ?? []), stored];
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', this.baseUrl);

    if (url.pathname.startsWith('/mock/')) {
      await this.handleControlRequest(request, response, url);
      return;
    }

    const botRoute = /^\/bot([^/]+)\/([A-Za-z0-9_]+)$/.exec(url.pathname);

    if (!botRoute) {
      text(response, 404, 'Not Found');
      return;
    }

    const [, token, method] = botRoute;

    if (!this.isAuthorized(token!)) {
      apiError(response, 401, 'Unauthorized');
      return;
    }

    await this.handleBotApiRequest(request, response, method!);
  }

  private isAuthorized(token: string): boolean {
    const allowedTokens = this.state.acceptedBotTokens;

    if (!allowedTokens?.length) {
      return true;
    }

    return allowedTokens.includes(token);
  }

  private async handleControlRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (request.method === 'GET' && url.pathname === '/mock/state') {
      json(response, 200, this.getState() as unknown as JsonRecord);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/mock/state') {
      const body = JSON.parse(
        await readRequestBody(request),
      ) as MockTelegramState;
      this.setState(body);
      json(response, 200, { ok: true });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/mock/events') {
      const body = JSON.parse(
        await readRequestBody(request),
      ) as MockTelegramReplayEvent;
      const dispatchResult = await this.dispatch(body);
      json(response, 200, {
        ok: true,
        dispatchResult,
      });
      return;
    }

    text(response, 404, 'Not Found');
  }

  private async handleBotApiRequest(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
  ): Promise<void> {
    const bodyText =
      request.method === 'POST' ? await readRequestBody(request) : '';
    const body: JsonRecord = bodyText
      ? (JSON.parse(bodyText) as JsonRecord)
      : {};

    switch (method) {
      case 'getMe': {
        const bot = this.state.bot ?? DEFAULT_BOT;
        apiResult(response, {
          id: bot.id,
          is_bot: true,
          first_name: bot.first_name,
          username: bot.username,
          ...(bot.has_topics_enabled ? { has_topics_enabled: true } : {}),
        });
        return;
      }

      case 'setMyCommands': {
        this.state.botCommands = Array.isArray(body.commands)
          ? (body.commands as Array<{ command: string; description: string }>)
          : [];
        apiResult(response, true);
        return;
      }

      case 'createForumTopic': {
        const chat = this.findChat(body.chat_id);
        const bot = this.state.bot ?? DEFAULT_BOT;

        if (!chat) {
          apiError(response, 400, 'Bad Request: chat not found');
          return;
        }

        if (
          (chat.type === 'private' && !bot.has_topics_enabled) ||
          (chat.type !== 'private' && !chat.is_forum)
        ) {
          apiError(response, 400, 'Bad Request: chat is not a forum');
          return;
        }

        const name = String(body.name ?? '').trim();
        if (!name || name.length > 128) {
          apiError(response, 400, 'Bad Request: invalid topic name');
          return;
        }

        const messageThreadId = this.nextMessageId();
        this.state.messages = [
          ...(this.state.messages ?? []),
          {
            message_id: messageThreadId,
            chat_id: String(chat.id),
            date: Math.floor(Date.now() / 1000),
            from: {
              id: bot.id,
              is_bot: true,
              first_name: bot.first_name,
              username: bot.username,
            },
            message_thread_id: messageThreadId,
            forum_topic_created: { name },
            reactions: [],
          },
        ];

        apiResult(response, {
          message_thread_id: messageThreadId,
          name,
        });
        return;
      }

      case 'editForumTopic': {
        const topic = (this.state.messages ?? []).find(
          (message) =>
            message.chat_id === String(body.chat_id) &&
            message.message_thread_id === Number(body.message_thread_id) &&
            message.forum_topic_created !== undefined,
        );

        if (!topic?.forum_topic_created) {
          apiError(response, 400, 'Bad Request: topic not found');
          return;
        }

        const name = String(body.name ?? '').trim();
        if (!name || name.length > 128) {
          apiError(response, 400, 'Bad Request: invalid topic name');
          return;
        }

        topic.forum_topic_created = { name };
        apiResult(response, true);
        return;
      }

      case 'sendMessage': {
        const messageText = String(body.text ?? '');

        if (!messageText) {
          apiError(response, 400, 'Bad Request: message text is empty');
          return;
        }

        if (messageText.length > TELEGRAM_MESSAGE_TEXT_LIMIT) {
          apiError(response, 400, 'Bad Request: message is too long');
          return;
        }

        if (
          body.parse_mode === 'HTML' &&
          this.state.behavior?.rejectHtmlParseMode
        ) {
          apiError(
            response,
            400,
            "Bad Request: can't parse entities: unsupported start tag",
          );
          return;
        }

        const stored = this.storeOutgoingMessage(response, body, {
          text: messageText,
          ...(typeof body.parse_mode === 'string'
            ? { parse_mode: body.parse_mode }
            : {}),
          ...((body.link_preview_options as JsonRecord | undefined)
            ?.is_disabled === true
            ? { link_preview_disabled: true }
            : {}),
        });

        if (stored) {
          apiResult(response, this.toTelegramMessage(stored));
        }
        return;
      }

      case 'sendPhoto': {
        if (this.state.behavior?.rejectPhotos) {
          apiError(
            response,
            400,
            'Bad Request: wrong file identifier/HTTP URL specified',
          );
          return;
        }

        const caption =
          typeof body.caption === 'string' ? body.caption : undefined;

        if (caption && caption.length > TELEGRAM_CAPTION_LIMIT) {
          apiError(response, 400, 'Bad Request: message caption is too long');
          return;
        }

        const stored = this.storeOutgoingMessage(response, body, {
          photo_url: String(body.photo ?? ''),
          ...(caption ? { caption } : {}),
        });

        if (stored) {
          apiResult(response, this.toTelegramMessage(stored));
        }
        return;
      }

      case 'editMessageText': {
        const message = this.findMessage(body);

        if (!message) {
          apiError(response, 400, 'Bad Request: message to edit not found');
          return;
        }

        const messageText = String(body.text ?? '');

        if (!messageText) {
          apiError(response, 400, 'Bad Request: message text is empty');
          return;
        }

        if (messageText.length > TELEGRAM_MESSAGE_TEXT_LIMIT) {
          apiError(response, 400, 'Bad Request: message is too long');
          return;
        }

        if (
          body.parse_mode === 'HTML' &&
          this.state.behavior?.rejectHtmlParseMode
        ) {
          apiError(
            response,
            400,
            "Bad Request: can't parse entities: unsupported start tag",
          );
          return;
        }

        message.text = messageText;
        if (typeof body.parse_mode === 'string') {
          message.parse_mode = body.parse_mode;
        } else {
          delete message.parse_mode;
        }
        message.reply_markup = body.reply_markup;
        apiResult(response, this.toTelegramMessage(message));
        return;
      }

      case 'editMessageReplyMarkup': {
        const message = this.findMessage(body);

        if (!message) {
          apiError(response, 400, 'Bad Request: message to edit not found');
          return;
        }

        message.reply_markup = body.reply_markup;
        apiResult(response, this.toTelegramMessage(message));
        return;
      }

      case 'deleteMessage': {
        const message = this.findMessage(body);

        if (!message) {
          apiError(response, 400, 'Bad Request: message to delete not found');
          return;
        }

        this.state.messages = (this.state.messages ?? []).filter(
          (entry) => entry !== message,
        );
        apiResult(response, true);
        return;
      }

      case 'setMessageReaction': {
        const message = this.findMessage(body);

        if (!message) {
          apiError(response, 400, 'Bad Request: message not found');
          return;
        }

        const reactions = Array.isArray(body.reaction) ? body.reaction : [];
        // setMessageReaction replaces the bot's reaction set on the message.
        message.reactions = reactions
          .map((entry) => String((entry as JsonRecord).emoji ?? ''))
          .filter(Boolean);
        apiResult(response, true);
        return;
      }

      case 'answerCallbackQuery': {
        const callbackQueryId = String(body.callback_query_id ?? '');

        if (!callbackQueryId) {
          apiError(response, 400, 'Bad Request: query is too old or invalid');
          return;
        }

        this.state.callbackAnswers = [
          ...(this.state.callbackAnswers ?? []),
          {
            callback_query_id: callbackQueryId,
            ...(typeof body.text === 'string' ? { text: body.text } : {}),
          },
        ];
        apiResult(response, true);
        return;
      }

      case 'sendChatAction': {
        const chat = this.findChat(body.chat_id);

        if (!chat) {
          apiError(response, 400, 'Bad Request: chat not found');
          return;
        }

        this.state.chatActions = [
          ...(this.state.chatActions ?? []),
          {
            chat_id: String(body.chat_id),
            action: String(body.action ?? ''),
            ...(typeof body.message_thread_id === 'number'
              ? { message_thread_id: body.message_thread_id }
              : {}),
          },
        ];
        apiResult(response, true);
        return;
      }

      case 'setWebhook': {
        this.state.webhook = {
          url: String(body.url ?? ''),
          ...(typeof body.secret_token === 'string'
            ? { secretToken: body.secret_token }
            : {}),
          ...(Array.isArray(body.allowed_updates)
            ? { allowedUpdates: body.allowed_updates.map(String) }
            : {}),
        };
        apiResult(response, true);
        return;
      }

      case 'deleteWebhook': {
        delete this.state.webhook;
        apiResult(response, true);
        return;
      }

      case 'getWebhookInfo': {
        apiResult(response, {
          url: this.state.webhook?.url ?? '',
          has_custom_certificate: false,
          pending_update_count: 0,
          ...(this.state.webhook?.allowedUpdates
            ? { allowed_updates: this.state.webhook.allowedUpdates }
            : {}),
        });
        return;
      }

      default:
        apiError(
          response,
          404,
          `Not Found: unhandled mock Telegram method "${method}"`,
        );
    }
  }

  private findChat(chatId: unknown): MockTelegramChat | undefined {
    return this.state.chats.find(
      (entry) => String(entry.id) === String(chatId),
    );
  }

  private findMessage(body: JsonRecord): MockTelegramStoredMessage | undefined {
    return (this.state.messages ?? []).find(
      (entry) =>
        entry.chat_id === String(body.chat_id) &&
        entry.message_id === Number(body.message_id),
    );
  }

  /**
   * Validates chat + reply target and appends a bot-authored message.
   * Writes the error response itself and returns undefined on failure.
   */
  private storeOutgoingMessage(
    response: ServerResponse,
    body: JsonRecord,
    content: Partial<MockTelegramStoredMessage>,
  ): MockTelegramStoredMessage | undefined {
    const chat = this.findChat(body.chat_id);

    if (!chat) {
      apiError(response, 400, 'Bad Request: chat not found');
      return undefined;
    }

    const replyParameters = body.reply_parameters as JsonRecord | undefined;
    let replyToMessageId: number | undefined;

    if (replyParameters?.message_id !== undefined) {
      const target = this.findMessage({
        chat_id: chat.id,
        message_id: replyParameters.message_id,
      });

      if (target) {
        replyToMessageId = target.message_id;
      } else if (replyParameters.allow_sending_without_reply !== true) {
        apiError(response, 400, 'Bad Request: message to be replied not found');
        return undefined;
      }
    }

    const bot = this.state.bot ?? DEFAULT_BOT;
    const stored: MockTelegramStoredMessage = {
      message_id: this.nextMessageId(),
      chat_id: String(chat.id),
      date: Math.floor(Date.now() / 1000),
      from: {
        id: bot.id,
        is_bot: true,
        first_name: bot.first_name,
        username: bot.username,
      },
      ...(typeof body.message_thread_id === 'number'
        ? { message_thread_id: body.message_thread_id }
        : {}),
      ...(replyToMessageId !== undefined
        ? { reply_to_message_id: replyToMessageId }
        : {}),
      ...(body.reply_markup !== undefined
        ? { reply_markup: body.reply_markup }
        : {}),
      reactions: [],
      ...content,
    };

    this.state.messages = [...(this.state.messages ?? []), stored];
    return stored;
  }

  private toTelegramMessage(stored: MockTelegramStoredMessage): JsonRecord {
    const chat = this.findChat(stored.chat_id);

    return {
      message_id: stored.message_id,
      date: stored.date,
      chat: chat ?? { id: Number(stored.chat_id), type: 'private' },
      from: stored.from,
      ...(stored.text !== undefined ? { text: stored.text } : {}),
      ...(stored.caption !== undefined ? { caption: stored.caption } : {}),
      ...(stored.message_thread_id !== undefined
        ? { message_thread_id: stored.message_thread_id }
        : {}),
      ...(stored.reply_to_message_id !== undefined
        ? { reply_to_message_id: stored.reply_to_message_id }
        : {}),
      ...(stored.forum_topic_created !== undefined
        ? { forum_topic_created: stored.forum_topic_created }
        : {}),
    };
  }
}
