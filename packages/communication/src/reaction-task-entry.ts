import { z } from 'zod';

import type { QueuedCommunicationMessage } from '@roomote/types';

export const reactionTaskEntrySchema = z.object({
  prompt: z.string().min(1),
  requester: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }),
  sourceEventId: z.string().min(1),
  target: z.object({
    channelId: z.string().min(1),
    messageId: z.string().min(1),
    threadId: z.string().min(1).optional(),
  }),
});

export type ReactionTaskEntry = z.infer<typeof reactionTaskEntrySchema>;

export function reactionTaskEntryToQueuedMessage(
  provider: 'discord' | 'teams',
  entry: ReactionTaskEntry,
  userId?: string,
): QueuedCommunicationMessage {
  return {
    provider,
    text: entry.prompt,
    user: entry.requester.name,
    ...(userId ? { userId } : {}),
    ts: entry.sourceEventId,
    channel: entry.target.channelId,
    ...(entry.target.threadId ? { threadTs: entry.target.threadId } : {}),
    ...(provider === 'discord'
      ? { turnPolicy: { reactionsAllowed: true } }
      : {}),
  };
}
