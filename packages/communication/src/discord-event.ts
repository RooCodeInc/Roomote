import { z } from 'zod';

import type { QueuedCommunicationMessage } from '@roomote/types';

export const discordUserSchema = z
  .object({
    id: z.string(),
    username: z.string(),
    global_name: z.string().nullable().optional(),
    bot: z.boolean().optional(),
  })
  .passthrough();

export const discordAttachmentSchema = z
  .object({
    id: z.string(),
    filename: z.string(),
    description: z.string().nullable().optional(),
    content_type: z.string().optional(),
    size: z.number().int().nonnegative(),
    url: z.string().url(),
    proxy_url: z.string().url().optional(),
    width: z.number().int().nullable().optional(),
    height: z.number().int().nullable().optional(),
    ephemeral: z.boolean().optional(),
  })
  .passthrough();

const discordMessageSnapshotSchema = z
  .object({
    message: z
      .object({
        content: z.string().default(''),
        mentions: z.array(discordUserSchema).default([]),
        attachments: z.array(discordAttachmentSchema).default([]),
      })
      .passthrough(),
  })
  .passthrough();

const discordChannelSchema = z
  .object({
    id: z.string(),
    type: z.number().int(),
    guild_id: z.string().optional(),
    parent_id: z.string().nullable().optional(),
    name: z.string().optional(),
  })
  .passthrough();

export const discordMessageSchema = z
  .object({
    id: z.string(),
    channel_id: z.string(),
    guild_id: z.string().optional(),
    // Discord message type: 0 = DEFAULT, 19 = REPLY; other values are system
    // messages (pins, joins, boosts, ...) that must not enter task flows.
    type: z.number().int().optional(),
    // Present when a webhook (e.g. a deploy-notification feed) authored the
    // message; such authors do not reliably carry `author.bot`.
    webhook_id: z.string().optional(),
    content: z.string().default(''),
    author: discordUserSchema,
    member: z
      .object({
        nick: z.string().nullable().optional(),
        user: discordUserSchema.optional(),
      })
      .passthrough()
      .optional(),
    mentions: z.array(discordUserSchema).default([]),
    attachments: z.array(discordAttachmentSchema).default([]),
    message_snapshots: z.array(discordMessageSnapshotSchema).optional(),
    channel: discordChannelSchema.optional(),
    message_reference: z
      .object({
        message_id: z.string().optional(),
        channel_id: z.string().optional(),
        guild_id: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const discordInteractionOptionSchema: z.ZodType<DiscordInteractionOption> = z
  .object({
    name: z.string(),
    type: z.number().int(),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    options: z.lazy(() => z.array(discordInteractionOptionSchema)).optional(),
  })
  .passthrough();

export const discordInteractionSchema = z
  .object({
    id: z.string(),
    application_id: z.string(),
    type: z.number().int(),
    token: z.string(),
    guild_id: z.string().optional(),
    channel_id: z.string().optional(),
    channel: discordChannelSchema.optional(),
    user: discordUserSchema.optional(),
    member: z
      .object({
        nick: z.string().nullable().optional(),
        user: discordUserSchema.optional(),
      })
      .passthrough()
      .optional(),
    // Component interactions include the message whose button was pressed.
    message: discordMessageSchema.optional(),
    data: z
      .object({
        // Slash commands carry the command's snowflake here (a string);
        // component interactions carry the numeric layout id of the pressed
        // component. Real button clicks were rejected as invalid while the
        // string-only shape was assumed.
        id: z.union([z.string(), z.number()]).optional(),
        name: z.string().optional(),
        type: z.number().int().optional(),
        options: z.array(discordInteractionOptionSchema).optional(),
        custom_id: z.string().optional(),
        component_type: z.number().int().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const discordMessageCreateDispatchSchema = z
  .object({
    op: z.literal(0),
    t: z.literal('MESSAGE_CREATE'),
    s: z.number().int().nullable().optional(),
    d: discordMessageSchema,
  })
  .passthrough();

const discordInteractionCreateDispatchSchema = z
  .object({
    op: z.literal(0),
    t: z.literal('INTERACTION_CREATE'),
    s: z.number().int().nullable().optional(),
    d: discordInteractionSchema,
  })
  .passthrough();

const discordReactionAddSchema = z
  .object({
    user_id: z.string(),
    channel_id: z.string(),
    message_id: z.string(),
    guild_id: z.string().optional(),
    emoji: z
      .object({
        id: z.string().nullable().optional(),
        name: z.string().nullable(),
      })
      .passthrough(),
    member: z
      .object({
        user: discordUserSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const discordReactionAddDispatchSchema = z
  .object({
    op: z.literal(0),
    t: z.literal('MESSAGE_REACTION_ADD'),
    s: z.number().int().nullable().optional(),
    d: discordReactionAddSchema,
  })
  .passthrough();

export const discordGatewayDispatchSchema = z.discriminatedUnion('t', [
  discordMessageCreateDispatchSchema,
  discordInteractionCreateDispatchSchema,
  discordReactionAddDispatchSchema,
]);

const discordMessageEnvelopeSchema = z
  .object({
    eventId: z.string(),
    eventType: z.literal('MESSAGE_CREATE'),
    payload: discordMessageSchema,
    receivedAt: z.string().datetime(),
    interactionDeferred: z.boolean().optional(),
  })
  .passthrough();

const discordInteractionEnvelopeSchema = z
  .object({
    eventId: z.string(),
    eventType: z.literal('INTERACTION_CREATE'),
    payload: discordInteractionSchema,
    receivedAt: z.string().datetime(),
    interactionDeferred: z.boolean().optional(),
  })
  .passthrough();

const discordReactionAddEnvelopeSchema = z
  .object({
    eventId: z.string(),
    eventType: z.literal('MESSAGE_REACTION_ADD'),
    payload: discordReactionAddSchema,
    receivedAt: z.string().datetime(),
  })
  .passthrough();

/** Durable envelope forwarded from the Discord Gateway service to the API. */
export const discordGatewayEventSchema = z.discriminatedUnion('eventType', [
  discordMessageEnvelopeSchema,
  discordInteractionEnvelopeSchema,
  discordReactionAddEnvelopeSchema,
]);

export type DiscordUser = z.infer<typeof discordUserSchema>;
export type DiscordAttachment = z.infer<typeof discordAttachmentSchema>;
export type DiscordMessage = z.infer<typeof discordMessageSchema>;
export type DiscordInteraction = z.infer<typeof discordInteractionSchema>;
export type DiscordReactionAdd = z.infer<typeof discordReactionAddSchema>;
export type DiscordGatewayDispatch = z.infer<
  typeof discordGatewayDispatchSchema
>;
export type DiscordGatewayEvent = z.infer<typeof discordGatewayEventSchema>;
export type DiscordInteractionOption = {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordInteractionOption[];
  [key: string]: unknown;
};

export type DiscordEventCommunicationMetadata = {
  communicationProvider: 'discord';
  communicationChannelId: string;
  communicationThreadId?: string;
  communicationMessageId: string;
  communicationGuildId?: string;
  /**
   * Id of the real channel message that triggered the event, present only
   * for message events. Interactions (slash commands, buttons) have no
   * channel message a task thread could anchor to.
   */
  communicationAnchorMessageId?: string;
};

export type DiscordEventNormalizationOptions = {
  botUserId?: string;
  userId?: string;
  /** Set when the channel is already known to be a Roomote-owned task thread. */
  isTaskThread?: boolean;
  /**
   * Set when the message arrived in a configured auto-respond channel: task
   * entry then needs no mention/DM/task-thread, and bot- or webhook-authored
   * messages qualify (the caller has already excluded Roomote's own).
   */
  channelAutoStart?: boolean;
  /** Parent channel supplied by the Gateway cache when Discord omits channel data. */
  parentChannelId?: string;
  /** Safe data URLs produced after immediately downloading image attachments. */
  attachmentImages?: string[];
  /** Server-extracted document text; attachment URLs never enter task prompts. */
  attachmentText?: string[];
};

export function parseDiscordGatewayEvent(input: unknown) {
  return discordGatewayEventSchema.safeParse(input);
}

export function getDiscordMessageCreate(
  event: DiscordGatewayEvent,
): DiscordMessage | undefined {
  return event.eventType === 'MESSAGE_CREATE' ? event.payload : undefined;
}

export function getDiscordInteractionCreate(
  event: DiscordGatewayEvent,
): DiscordInteraction | undefined {
  return event.eventType === 'INTERACTION_CREATE' ? event.payload : undefined;
}

export function getDiscordReactionAdd(
  event: DiscordGatewayEvent,
): DiscordReactionAdd | undefined {
  return event.eventType === 'MESSAGE_REACTION_ADD' ? event.payload : undefined;
}

export function getDiscordInteractionUser(
  interaction: DiscordInteraction,
): DiscordUser | undefined {
  return interaction.member?.user ?? interaction.user;
}

function getEventChannel(event: DiscordGatewayEvent): {
  channelId: string;
  parentChannelId?: string;
  guildId?: string;
} {
  if (event.eventType === 'MESSAGE_REACTION_ADD') {
    return {
      channelId: event.payload.channel_id,
      ...(event.payload.guild_id ? { guildId: event.payload.guild_id } : {}),
    };
  }

  const data = event.payload;
  const channelId =
    data.channel_id ?? ('channel' in data ? data.channel?.id : undefined);
  if (!channelId) {
    throw new Error('Discord communication metadata requires a channel id.');
  }
  const parentChannelId =
    'channel' in data ? (data.channel?.parent_id ?? undefined) : undefined;
  return {
    channelId,
    ...(parentChannelId ? { parentChannelId } : {}),
    ...(data.guild_id ? { guildId: data.guild_id } : {}),
  };
}

export function getDiscordEventCommunicationMetadata(
  event: DiscordGatewayEvent,
  options: Pick<DiscordEventNormalizationOptions, 'parentChannelId'> = {},
): DiscordEventCommunicationMetadata {
  const channel = getEventChannel(event);
  const parentChannelId = options.parentChannelId ?? channel.parentChannelId;
  const message = getDiscordMessageCreate(event);
  return {
    communicationProvider: 'discord',
    communicationChannelId: parentChannelId ?? channel.channelId,
    ...(parentChannelId ? { communicationThreadId: channel.channelId } : {}),
    communicationMessageId: event.eventId,
    ...(channel.guildId ? { communicationGuildId: channel.guildId } : {}),
    ...(message ? { communicationAnchorMessageId: message.id } : {}),
  };
}

export function getDiscordMessageAttachments(
  eventOrMessage: DiscordGatewayEvent | DiscordMessage,
): DiscordAttachment[] {
  const message = isDiscordGatewayEventValue(eventOrMessage)
    ? eventOrMessage.eventType === 'MESSAGE_CREATE'
      ? eventOrMessage.payload
      : undefined
    : eventOrMessage;
  if (!message) return [];
  return [
    ...message.attachments,
    ...(message.message_snapshots ?? []).flatMap(
      (snapshot) => snapshot.message.attachments,
    ),
  ];
}

export function getDiscordMessageContent(message: DiscordMessage): string {
  return [
    message.content,
    ...(message.message_snapshots ?? []).map(
      (snapshot) => snapshot.message.content,
    ),
  ]
    .map((content) => content.trim())
    .filter(Boolean)
    .join('\n\n');
}

function getDiscordMessageMentions(message: DiscordMessage): DiscordUser[] {
  return [
    ...message.mentions,
    ...(message.message_snapshots ?? []).flatMap(
      (snapshot) => snapshot.message.mentions,
    ),
  ];
}

function isDiscordGatewayEventValue(
  value: DiscordGatewayEvent | DiscordMessage | DiscordInteraction,
): value is DiscordGatewayEvent {
  return (
    'eventType' in value &&
    (value.eventType === 'MESSAGE_CREATE' ||
      value.eventType === 'INTERACTION_CREATE' ||
      value.eventType === 'MESSAGE_REACTION_ADD') &&
    'payload' in value
  );
}

export function isDiscordImageAttachment(
  attachment: DiscordAttachment,
): boolean {
  return (
    attachment.content_type?.toLowerCase().startsWith('image/') === true ||
    /\.(?:avif|gif|jpe?g|png|webp)$/iu.test(attachment.filename)
  );
}

export function isDiscordTextDocumentAttachment(
  attachment: DiscordAttachment,
): boolean {
  const contentType = attachment.content_type?.toLowerCase();
  return (
    contentType?.startsWith('text/') === true ||
    [
      'application/json',
      'application/xml',
      'application/yaml',
      'application/x-yaml',
    ].includes(contentType ?? '') ||
    /\.(?:c|cc|cpp|css|csv|go|h|html?|java|js|json|jsx|log|md|py|rb|rs|sh|sql|svg|toml|ts|tsx|txt|xml|ya?ml)$/iu.test(
      attachment.filename,
    )
  );
}

export function formatDiscordAttachmentSummary(
  attachments: DiscordAttachment[],
): string {
  if (!attachments.length) return '';
  return attachments
    .map((attachment) => {
      const kind = isDiscordImageAttachment(attachment)
        ? 'Image'
        : isDiscordTextDocumentAttachment(attachment)
          ? 'Document'
          : 'Attachment';
      return `${kind}: ${attachment.filename}`;
    })
    .join('\n');
}

function isDirectMessage(message: DiscordMessage): boolean {
  return !message.guild_id;
}

export function isDiscordBotMentioned(
  message: DiscordMessage,
  botUserId: string | undefined,
): boolean {
  if (!botUserId) return false;
  const mentions = getDiscordMessageMentions(message);
  const content = getDiscordMessageContent(message);
  return (
    mentions.some((mention) => mention.id === botUserId) ||
    content.includes(`<@${botUserId}>`) ||
    content.includes(`<@!${botUserId}>`)
  );
}

export function stripDiscordBotMention(
  text: string,
  botUserId: string | undefined,
): string {
  if (!botUserId) return text.trim();
  return text
    .replaceAll(`<@${botUserId}>`, ' ')
    .replaceAll(`<@!${botUserId}>`, ' ')
    .replace(/[^\S\r\n]+/gu, ' ')
    .replace(/ *\r?\n */gu, '\n')
    .trim();
}

function formatDiscordMentionLabel(user: DiscordUser): string | null {
  const label = user.global_name?.trim() || user.username?.trim();
  return label || null;
}

/**
 * Turn raw Discord mention tokens into readable @names using the message's
 * resolved mention metadata. Unknown leftover mention markup is dropped so
 * thread titles and agent prompts do not surface snowflake ids.
 */
export function expandDiscordUserMentions(
  text: string,
  mentions: DiscordUser[],
): string {
  if (!text) return text;
  const byId = new Map<string, string>();
  for (const mention of mentions) {
    const label = formatDiscordMentionLabel(mention);
    if (label) byId.set(mention.id, label);
  }
  return text
    .replace(/<@!?(\d+)>/gu, (_match, id: string) => {
      const label = byId.get(id);
      return label ? `@${label}` : ' ';
    })
    .replace(/[^\S\r\n]+/gu, ' ')
    .replace(/ *\r?\n */gu, '\n')
    .trim();
}

function findInteractionOption(
  options: DiscordInteractionOption[] | undefined,
  name: string,
): DiscordInteractionOption | undefined {
  for (const option of options ?? []) {
    if (option.name === name) return option;
    const nested = findInteractionOption(option.options, name);
    if (nested) return nested;
  }
  return undefined;
}

export function getDiscordInteractionCommand(
  eventOrInteraction: DiscordGatewayEvent | DiscordInteraction,
): { name: string; request?: string; code?: string } | null {
  const interaction = isDiscordGatewayEventValue(eventOrInteraction)
    ? getDiscordInteractionCreate(eventOrInteraction)
    : eventOrInteraction;
  if (!interaction || interaction.type !== 2 || !interaction.data?.name) {
    return null;
  }
  const request = findInteractionOption(
    interaction.data.options,
    'request',
  )?.value;
  const code = findInteractionOption(interaction.data.options, 'code')?.value;
  return {
    name: interaction.data.name.toLowerCase(),
    ...(typeof request === 'string' && request.trim()
      ? { request: request.trim() }
      : {}),
    ...(typeof code === 'string' && code.trim() ? { code: code.trim() } : {}),
  };
}

export function isDiscordTaskEntryEvent(
  event: DiscordGatewayEvent,
  options: DiscordEventNormalizationOptions = {},
): boolean {
  const message = getDiscordMessageCreate(event);
  if (message) {
    if (message.author.bot && options.channelAutoStart !== true) return false;
    const hasContent = Boolean(
      getDiscordMessageContent(message) ||
      getDiscordMessageAttachments(message).length,
    );
    return (
      hasContent &&
      (options.channelAutoStart === true ||
        isDirectMessage(message) ||
        options.isTaskThread === true ||
        isDiscordBotMentioned(message, options.botUserId))
    );
  }
  return getDiscordInteractionCommand(event)?.name === 'new';
}

function formatDiscordUser(input: {
  user: DiscordUser | undefined;
  nickname?: string | null;
}): string {
  return (
    input.nickname?.trim() ||
    input.user?.global_name?.trim() ||
    input.user?.username ||
    (input.user ? `Discord user ${input.user.id}` : 'Discord user')
  );
}

export function discordEventToQueuedCommunicationMessage(
  event: DiscordGatewayEvent,
  options: DiscordEventNormalizationOptions = {},
): QueuedCommunicationMessage | null {
  if (!isDiscordTaskEntryEvent(event, options)) return null;

  const metadata = getDiscordEventCommunicationMetadata(event, options);
  const message = getDiscordMessageCreate(event);
  if (message) {
    const attachmentSummary = formatDiscordAttachmentSummary(
      getDiscordMessageAttachments(message),
    );
    const strippedText = expandDiscordUserMentions(
      stripDiscordBotMention(
        getDiscordMessageContent(message),
        options.botUserId,
      ),
      getDiscordMessageMentions(message),
    );
    const extractedText = (options.attachmentText ?? [])
      .map((text) => text.trim())
      .filter(Boolean)
      .join('\n\n');
    const text = [strippedText, attachmentSummary, extractedText]
      .filter(Boolean)
      .join('\n\n');
    if (!text && !(options.attachmentImages?.length ?? 0)) return null;
    return {
      provider: 'discord',
      text: text || 'Image attachment',
      user: formatDiscordUser({
        user: message.author,
        nickname: message.member?.nick,
      }),
      ...(options.userId ? { userId: options.userId } : {}),
      ts: message.id,
      channel: metadata.communicationChannelId,
      ...(metadata.communicationThreadId
        ? { threadTs: metadata.communicationThreadId }
        : {}),
      ...(options.attachmentImages?.length
        ? { images: options.attachmentImages }
        : {}),
      turnPolicy: { reactionsAllowed: true },
    };
  }

  const interaction = getDiscordInteractionCreate(event);
  const command = getDiscordInteractionCommand(event);
  if (!interaction || command?.name !== 'new') return null;
  const user = getDiscordInteractionUser(interaction);
  return {
    provider: 'discord',
    text: command.request ?? 'Start a new task',
    user: formatDiscordUser({ user, nickname: interaction.member?.nick }),
    ...(options.userId ? { userId: options.userId } : {}),
    ts: interaction.id,
    channel: metadata.communicationChannelId,
    ...(metadata.communicationThreadId
      ? { threadTs: metadata.communicationThreadId }
      : {}),
    turnPolicy: { reactionsAllowed: true },
  };
}
