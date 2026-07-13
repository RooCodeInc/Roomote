import { z } from 'zod';

export const communicationProviders = [
  'slack',
  'teams',
  'telegram',
  'discord',
] as const;

export const communicationProviderSchema = z.enum(communicationProviders);

export type CommunicationProvider = z.infer<typeof communicationProviderSchema>;

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
