import { z } from 'zod';

export const communicationProviders = [
  'slack',
  'teams',
  'telegram',
  'discord',
] as const;

export const communicationProviderSchema = z.enum(communicationProviders);

export type CommunicationProvider = z.infer<typeof communicationProviderSchema>;

export const CHAT_CHANNELS_TOOL = {
  name: 'list_chat_channels',
  title: 'List Chat Channels',
  description:
    'List the communication channels Roomote is connected to or can currently discover, grouped by platform. Returns channel IDs and platform-specific workspace context so another chat tool can target the right channel. Some platforms do not support channel enumeration and report that limitation explicitly.',
} as const;

export const CHAT_MESSAGE_CONTEXT_TOOL = {
  name: 'get_chat_message_context',
  title: 'Get Chat Message Context',
  description:
    'Look up a message in the task communication channel and return its surrounding conversation context. When the task has no communication channel, provide a Slack or Discord message link. Explicit cross-channel lookups require the acting user to have access.',
  inputDescriptions: {
    channel:
      'Optional channel ID, name, mention, or message link. Omit it to use the task communication channel.',
    messageId:
      'Provider message ID or timestamp. Optional when messageLink, or channel as a message link, includes it.',
    messageLink:
      'Optional full Slack or Discord message link. Required when the task has no communication channel.',
  },
} as const;

export const CHAT_CHANNEL_MESSAGES_TOOL = {
  name: 'get_chat_channel_messages',
  title: 'Get Chat Channel Messages',
  description:
    'Fetch readable history from the task communication channel. When the task has no communication channel, or when another channel is needed, provide a Slack or Discord channel/message link. Provider-specific access checks still apply.',
  inputDescriptions: {
    channel:
      'Optional channel ID, name, mention, or Slack/Discord channel/message link. Omit it to use the task communication channel.',
    oldest:
      'Optional inclusive lower message bound. Use a Slack timestamp or ISO 8601 date for Slack, or a message snowflake for Discord.',
    latest:
      'Optional inclusive upper message bound. Use a Slack timestamp or ISO 8601 date for Slack, or a message snowflake for Discord.',
  },
} as const;

export const communicationProviderQueuePrefixes = {
  slack: 'slack:messages:',
  teams: 'teams:messages:',
  telegram: 'telegram:messages:',
  discord: 'discord:messages:',
} as const satisfies Record<CommunicationProvider, string>;

export function getCommunicationProviderQueuePrefix(
  provider: CommunicationProvider,
): string {
  return communicationProviderQueuePrefixes[provider];
}

export const communicationProviderDisplayNames = {
  slack: 'Slack',
  teams: 'Microsoft Teams',
  telegram: 'Telegram',
  discord: 'Discord',
} as const satisfies Record<CommunicationProvider, string>;

export function getCommunicationProviderDisplayName(
  provider: CommunicationProvider,
): string {
  return communicationProviderDisplayNames[provider];
}

export const queuedCommunicationMessageSchema = z.object({
  /**
   * Provider that produced the message. Optional for backwards-compatible
   * Slack queues where the Redis key already carries the provider.
   */
  provider: communicationProviderSchema.optional(),
  text: z.string(),
  user: z.string(),
  userId: z.string().optional(),
  /**
   * Provider message timestamp or activity id. The field name stays `ts`
   * because Slack queues already use it and worker polling consumes it.
   */
  ts: z.string(),
  channel: z.string().optional(),
  threadTs: z.string().optional(),
  images: z.array(z.string()).optional(),
  formattedPrompt: z.string().optional(),
  turnPolicy: z
    .object({
      reactionsAllowed: z.boolean().optional(),
    })
    .optional(),
  contextOnly: z.boolean().optional(),
  goalContext: z
    .object({
      objective: z.string(),
      maxContinuations: z.number().int(),
      generation: z.string().nullable(),
      status: z.enum(['active', 'complete', 'blocked', 'budget_limited']),
      continuationsUsed: z.number().int(),
      blockedReason: z.string().nullable(),
      completedAt: z.coerce.date().nullable(),
    })
    .optional(),
});

export type QueuedCommunicationMessage = z.infer<
  typeof queuedCommunicationMessageSchema
>;

export type CommunicationReference = {
  provider: CommunicationProvider;
  teamId?: string;
  teamDomain?: string;
  channelId?: string;
  threadId?: string;
  messageId?: string;
};

export function isCommunicationProvider(
  value: unknown,
): value is CommunicationProvider {
  return communicationProviderSchema.safeParse(value).success;
}
