import { z } from 'zod';

export const communicationProviders = [
  'slack',
  'teams',
  'telegram',
  'discord',
  'agentmail',
] as const;

export const communicationProviderSchema = z.enum(communicationProviders);

export type CommunicationProvider = z.infer<typeof communicationProviderSchema>;

export const CHAT_DESTINATIONS_TOOL = {
  name: 'list_chat_destinations',
  title: 'List Chat Destinations',
  description:
    'List authorized destinations for a new standalone message. Returns exact destination references for the authenticated member on linked Slack or Telegram, linked people in shared Slack workspaces, and discoverable Slack channels. Pass a returned destination unchanged to send_chat_message. Provider limitations are reported explicitly.',
} as const;

export const CHAT_MESSAGE_SEND_TOOL = {
  name: 'send_chat_message',
  title: 'Send Chat Message',
  description:
    'Send a new standalone Markdown message to an authorized destination. First use list_chat_destinations and pass its exact destination reference unchanged. Self destinations resolve only from the authenticated member; Slack people and channels retain workspace linkage and access checks. A trusted Slack channel reference may append :thread:<message timestamp>. Use send_chat_reply for the current conversation. Never infer or alter a destination reference.',
  inputDescriptions: {
    destination:
      'Exact destination reference from list_chat_destinations, or a trusted Slack channel reference with an optional :thread:<message timestamp> suffix.',
    message: 'Markdown message to send.',
  },
} as const;

export const CHAT_MESSAGE_SEND_TOOL_NAME = CHAT_MESSAGE_SEND_TOOL.name;

// Persisted deployment policy may still contain these names. They are not
// registered in the model-visible catalog.
export const LEGACY_CHAT_CHANNELS_TOOL_NAME = 'list_chat_channels';
export const LEGACY_CHAT_CHANNEL_POST_TOOL_NAME = 'post_to_channel';
export const LEGACY_CHAT_SELF_DIRECT_MESSAGE_TOOL_NAME =
  'send_direct_message_to_self';
export const CHAT_REACTION_EMOJI_TOOL_NAME = 'send_chat_reaction_emoji';

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
    'Fetch readable history from the task communication channel. When the task has no communication channel, or when another channel is needed, provide a Slack or Discord channel/message link. Provider-specific access checks still apply. Large results are cut to the newest messages: when the response has truncated set, call again with latest set to nextLatest (and the same oldest) to read older messages.',
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
  agentmail: 'agentmail:messages:',
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
  agentmail: 'Email',
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
  /** Trusted provider context associated with the current message. */
  agentContext: z.string().optional(),
  formattedPrompt: z.string().optional(),
  turnPolicy: z
    .object({
      reactionsAllowed: z.boolean().optional(),
    })
    .optional(),
  contextOnly: z.boolean().optional(),
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
