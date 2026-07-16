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

export const discordGatewayDispatchSchema = z.discriminatedUnion('t', [
  discordMessageCreateDispatchSchema,
  discordInteractionCreateDispatchSchema,
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

/** Durable envelope forwarded from the Discord Gateway service to the API. */
export const discordGatewayEventSchema = z.discriminatedUnion('eventType', [
  discordMessageEnvelopeSchema,
  discordInteractionEnvelopeSchema,
]);

export type DiscordUser = z.infer<typeof discordUserSchema>;
export type DiscordAttachment = z.infer<typeof discordAttachmentSchema>;
export type DiscordMessage = z.infer<typeof discordMessageSchema>;
export type DiscordInteraction = z.infer<typeof discordInteractionSchema>;
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
    communicationMessageId: event.payload.id,
    ...(channel.guildId ? { communicationGuildId: channel.guildId } : {}),
    ...(message ? { communicationAnchorMessageId: message.id } : {}),
  };
}

export function getDiscordMessageAttachments(
  eventOrMessage: DiscordGatewayEvent | DiscordMessage,
): DiscordAttachment[] {
  if (isDiscordGatewayEventValue(eventOrMessage)) {
    return eventOrMessage.eventType === 'MESSAGE_CREATE'
      ? eventOrMessage.payload.attachments
      : [];
  }
  return eventOrMessage.attachments;
}

function isDiscordGatewayEventValue(
  value: DiscordGatewayEvent | DiscordMessage | DiscordInteraction,
): value is DiscordGatewayEvent {
  return (
    'eventType' in value &&
    (value.eventType === 'MESSAGE_CREATE' ||
      value.eventType === 'INTERACTION_CREATE') &&
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

function isBotMentioned(
  message: DiscordMessage,
  botUserId: string | undefined,
): boolean {
  if (!botUserId) return false;
  return (
    message.mentions.some((mention) => mention.id === botUserId) ||
    message.content.includes(`<@${botUserId}>`) ||
    message.content.includes(`<@!${botUserId}>`)
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
    if (message.author.bot) return false;
    const hasContent = Boolean(
      message.content.trim() || message.attachments.length,
    );
    return (
      hasContent &&
      (isDirectMessage(message) ||
        options.isTaskThread === true ||
        isBotMentioned(message, options.botUserId))
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
      message.attachments,
    );
    const strippedText = stripDiscordBotMention(
      message.content,
      options.botUserId,
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
