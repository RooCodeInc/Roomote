import { z } from 'zod';

import type { QueuedCommunicationMessage } from '@roomote/types';

const telegramUserSchema = z
  .object({
    id: z.number(),
    is_bot: z.boolean().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    username: z.string().optional(),
  })
  .passthrough();

const telegramChatSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    type: z.string(),
    title: z.string().optional(),
    username: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    is_forum: z.boolean().optional(),
  })
  .passthrough();

const telegramMessageEntitySchema = z
  .object({
    type: z.string(),
    offset: z.number().int(),
    length: z.number().int(),
  })
  .passthrough();

const telegramMessageSchema = z
  .object({
    message_id: z.number().int(),
    message_thread_id: z.number().int().optional(),
    date: z.number().int().optional(),
    text: z.string().optional(),
    from: telegramUserSchema.optional(),
    chat: telegramChatSchema,
    entities: z.array(telegramMessageEntitySchema).optional(),
  })
  .passthrough();

const telegramCallbackQuerySchema = z
  .object({
    id: z.string(),
    from: telegramUserSchema,
    message: telegramMessageSchema.optional(),
    data: z.string().optional(),
  })
  .passthrough();

export const telegramUpdateSchema = z
  .object({
    update_id: z.number().int(),
    message: telegramMessageSchema.optional(),
    edited_message: telegramMessageSchema.optional(),
    callback_query: telegramCallbackQuerySchema.optional(),
  })
  .passthrough();

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
export type TelegramMessage = z.infer<typeof telegramMessageSchema>;
export type TelegramCallbackQuery = z.infer<typeof telegramCallbackQuerySchema>;
export type TelegramUpdateCommunicationMetadata = {
  communicationProvider: 'telegram';
  communicationChannelId: string;
  communicationThreadId?: string;
  communicationMessageId?: string;
};

export type TelegramBotMentionOptions = {
  botUsername?: string;
};

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function readEntityText(
  text: string,
  entity: z.infer<typeof telegramMessageEntitySchema>,
): string {
  return text.slice(entity.offset, entity.offset + entity.length);
}

export function normalizeTelegramBotUsername(
  username: string | undefined,
): string | undefined {
  const trimmed = cleanOptionalString(username)
    ?.replace(/^@/, '')
    .toLowerCase();

  return trimmed ? trimmed : undefined;
}

export function parseTelegramUpdate(input: unknown) {
  return telegramUpdateSchema.safeParse(input);
}

export function getTelegramUpdateMessage(
  update: TelegramUpdate,
): TelegramMessage | undefined {
  return update.message ?? update.edited_message;
}

export function isTelegramMessageUpdate(update: TelegramUpdate): boolean {
  return Boolean(getTelegramUpdateMessage(update));
}

export function getTelegramUpdateCallbackQuery(
  update: TelegramUpdate,
): TelegramCallbackQuery | undefined {
  return update.callback_query;
}

export function getTelegramChatId(message: TelegramMessage): string {
  return String(message.chat.id);
}

export function getTelegramMessageThreadId(
  message: TelegramMessage,
): string | undefined {
  return message.message_thread_id === undefined
    ? undefined
    : String(message.message_thread_id);
}

export function formatTelegramUser(message: TelegramMessage): string {
  const from = message.from;

  if (!from) {
    return 'Telegram user';
  }

  const fullName = [from.first_name, from.last_name]
    .map((part) => cleanOptionalString(part))
    .filter(Boolean)
    .join(' ');

  return (
    fullName ||
    (from.username ? `@${from.username}` : undefined) ||
    `Telegram user ${from.id}`
  );
}

function isTelegramUpdateValue(
  value: TelegramUpdate | TelegramMessage,
): value is TelegramUpdate {
  return 'update_id' in value;
}

export function getTelegramUpdateCommunicationMetadata(
  updateOrMessage: TelegramUpdate | TelegramMessage,
): TelegramUpdateCommunicationMetadata {
  const message = isTelegramUpdateValue(updateOrMessage)
    ? getTelegramUpdateMessage(updateOrMessage)
    : updateOrMessage;

  if (!message) {
    throw new Error('Telegram communication metadata requires a message.');
  }

  const threadId = getTelegramMessageThreadId(message);
  const metadata: TelegramUpdateCommunicationMetadata = {
    communicationProvider: 'telegram',
    communicationChannelId: getTelegramChatId(message),
    communicationMessageId: String(message.message_id),
  };

  if (threadId) {
    metadata.communicationThreadId = threadId;
  }

  return metadata;
}

export function isTelegramPrivateChat(message: TelegramMessage): boolean {
  return message.chat.type.toLowerCase() === 'private';
}

function parseTelegramBotCommand(
  entityText: string,
): { command: string; botSuffix?: string } | null {
  const match = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?$/u.exec(entityText);

  if (!match?.[1]) {
    return null;
  }

  return {
    command: match[1].toLowerCase(),
    botSuffix: match[2]?.toLowerCase(),
  };
}

function isMatchingBotCommand(
  entityText: string,
  options: TelegramBotMentionOptions,
  message: TelegramMessage,
): boolean {
  if (!entityText.startsWith('/')) {
    return false;
  }

  const botUsername = normalizeTelegramBotUsername(options.botUsername);

  if (!botUsername || isTelegramPrivateChat(message)) {
    return true;
  }

  return parseTelegramBotCommand(entityText)?.botSuffix === botUsername;
}

function isMatchingBotMention(
  entityText: string,
  options: TelegramBotMentionOptions,
): boolean {
  const botUsername = normalizeTelegramBotUsername(options.botUsername);

  if (!entityText.startsWith('@')) {
    return false;
  }

  if (!botUsername) {
    return true;
  }

  return entityText.slice(1).toLowerCase() === botUsername;
}

type TelegramMessageEntity = z.infer<typeof telegramMessageEntitySchema>;

function findLeadingBotMentionBefore(
  text: string,
  entities: TelegramMessageEntity[],
  offset: number,
  options: TelegramBotMentionOptions,
): TelegramMessageEntity | undefined {
  return entities.find(
    (candidate) =>
      candidate.type === 'mention' &&
      candidate.offset + candidate.length <= offset &&
      isMatchingBotMention(readEntityText(text, candidate), options),
  );
}

/**
 * A bot command counts as an invocation only when it leads the message —
 * offset 0, or preceded only by whitespace and a mention of this bot. A
 * `/command` mentioned mid-sentence is message content, not an invocation.
 * Mentions, by contrast, address the bot from anywhere in the text.
 */
function isLeadingBotCommand(
  text: string,
  entities: TelegramMessageEntity[],
  entity: TelegramMessageEntity,
  options: TelegramBotMentionOptions,
): boolean {
  const mentionPrefix = findLeadingBotMentionBefore(
    text,
    entities,
    entity.offset,
    options,
  );
  const prefix = mentionPrefix
    ? text.slice(0, mentionPrefix.offset) +
      text.slice(mentionPrefix.offset + mentionPrefix.length, entity.offset)
    : text.slice(0, entity.offset);

  return !prefix.trim();
}

function getTelegramInvocationEntity(
  text: string,
  message: TelegramMessage,
  options: TelegramBotMentionOptions,
) {
  const entities = message.entities ?? [];

  return entities.find((entity) => {
    const entityText = readEntityText(text, entity);

    if (entity.type === 'mention') {
      return isMatchingBotMention(entityText, options);
    }

    if (entity.type === 'bot_command') {
      return (
        isLeadingBotCommand(text, entities, entity, options) &&
        isMatchingBotCommand(entityText, options, message)
      );
    }

    return false;
  });
}

export function isTelegramBotMentioned(
  message: TelegramMessage,
  options: TelegramBotMentionOptions = {},
): boolean {
  const text = message.text ?? '';

  if (!text) {
    return false;
  }

  return Boolean(getTelegramInvocationEntity(text, message, options));
}

/**
 * A bare `/start` in a private chat is the Telegram-native "open the bot"
 * gesture, not a task request. `/start <text>` keeps its existing meaning:
 * the command is stripped and the remaining text becomes the task.
 */
export function isTelegramStartCommand(update: TelegramUpdate): boolean {
  const message = getTelegramUpdateMessage(update);

  if (!message?.text || !isTelegramPrivateChat(message)) {
    return false;
  }

  return /^\/start(@[A-Za-z0-9_]+)?$/u.test(message.text.trim());
}

export function isTelegramTaskEntryUpdate(
  update: TelegramUpdate,
  options: TelegramBotMentionOptions = {},
): boolean {
  const message = getTelegramUpdateMessage(update);

  return Boolean(
    message &&
    message.text &&
    (isTelegramPrivateChat(message) ||
      isTelegramBotMentioned(message, options)),
  );
}

export const TELEGRAM_NEW_TASK_COMMANDS = ['new', 'done'] as const;

export type TelegramNewTaskCommand = {
  command: (typeof TELEGRAM_NEW_TASK_COMMANDS)[number];
  text: string;
};

function isNewTaskCommandName(
  command: string,
): command is TelegramNewTaskCommand['command'] {
  return (TELEGRAM_NEW_TASK_COMMANDS as readonly string[]).includes(command);
}

/**
 * Detects an explicit `/new` or `/done` command and returns the command name
 * plus the task description with the invocation stripped. Returns `null` when
 * the update is not one of those commands.
 *
 * After a task completes, the next message in the same chat/topic would
 * otherwise resume its snapshot. These commands force a fresh task launch
 * instead (and the launch path can create a fresh Telegram topic).
 *
 * The command must lead the message — a `/new` or `/done` mentioned
 * mid-sentence is ordinary text, not a command. The only prefix allowed before
 * the command is a mention of this bot, so both group forms work:
 * `/new@<botUsername> <text>` and `@<botUsername> /new <text>`. A bare `/new`
 * from another member, or one suffixed for another bot, does not hijack the
 * chat.
 */
export function getTelegramNewTaskCommand(
  update: TelegramUpdate,
  options: TelegramBotMentionOptions = {},
): TelegramNewTaskCommand | null {
  const message = getTelegramUpdateMessage(update);
  const text = message?.text;

  if (!text) {
    return null;
  }

  const botUsername = normalizeTelegramBotUsername(options.botUsername);
  const entities = message.entities ?? [];

  for (const entity of entities) {
    if (entity.type !== 'bot_command') {
      continue;
    }

    const parsed = parseTelegramBotCommand(readEntityText(text, entity));

    if (!parsed || !isNewTaskCommandName(parsed.command)) {
      continue;
    }

    if (botUsername && parsed.botSuffix && parsed.botSuffix !== botUsername) {
      // `/new@some_other_bot` is addressed to another bot.
      continue;
    }

    // The command must lead the message; the only prefix allowed before it is
    // a mention of this bot. Anything else means the token is part of the
    // message text, not a command.
    if (!isLeadingBotCommand(text, entities, entity, options)) {
      continue;
    }

    const mentionPrefix = findLeadingBotMentionBefore(
      text,
      entities,
      entity.offset,
      options,
    );

    // In groups the command must target this bot, via either the
    // `/new@<botUsername>` suffix or a leading bot mention.
    if (
      botUsername &&
      !isTelegramPrivateChat(message) &&
      !parsed.botSuffix &&
      !mentionPrefix
    ) {
      continue;
    }

    return {
      command: parsed.command,
      text: normalizeWhitespace(text.slice(entity.offset + entity.length)),
    };
  }

  return null;
}

export function stripTelegramBotInvocation(
  text: string,
  message: TelegramMessage,
  options: TelegramBotMentionOptions = {},
): string {
  const invocationEntity = getTelegramInvocationEntity(text, message, options);

  if (!invocationEntity) {
    return normalizeWhitespace(text);
  }

  const before = text.slice(0, invocationEntity.offset);
  const after = text.slice(invocationEntity.offset + invocationEntity.length);

  return normalizeWhitespace(`${before} ${after}`);
}

export function telegramUpdateToQueuedCommunicationMessage(
  update: TelegramUpdate,
  options: TelegramBotMentionOptions & { userId?: string } = {},
): QueuedCommunicationMessage | null {
  const message = getTelegramUpdateMessage(update);

  if (!message?.text) {
    return null;
  }

  const text = stripTelegramBotInvocation(message.text, message, options);

  if (!text) {
    return null;
  }

  return {
    provider: 'telegram',
    text,
    user: formatTelegramUser(message),
    ...(options.userId ? { userId: options.userId } : {}),
    ts: String(message.message_id),
    channel: getTelegramChatId(message),
    ...(getTelegramMessageThreadId(message)
      ? { threadTs: getTelegramMessageThreadId(message) }
      : {}),
  };
}
