import { z } from 'zod';

export const fastAgentSurfaces = ['slack', 'discord'] as const;
export const fastAgentSurfaceSchema = z.enum(fastAgentSurfaces);

export type FastAgentSurface = z.infer<typeof fastAgentSurfaceSchema>;

export const fastAgentReplyTargetSchema = z.object({
  channelId: z.string().min(1),
  threadId: z.string().min(1).optional(),
});

export type FastAgentReplyTarget = z.infer<typeof fastAgentReplyTargetSchema>;

const fastAgentConversationIdentitySchema = {
  workspaceId: z.string().min(1),
  /** Stable provider-native identity used to scope Fast memory and turns. */
  conversationId: z.string().min(1),
};

export const fastAgentConversationSchema = z.discriminatedUnion('surface', [
  z.object({
    surface: z.literal('slack'),
    ...fastAgentConversationIdentitySchema,
    replyTarget: z.object({
      channelId: z.string().min(1),
      threadId: z.string().min(1),
    }),
  }),
  z.object({
    surface: z.literal('discord'),
    ...fastAgentConversationIdentitySchema,
    /** Routable provider address. It is deliberately separate from identity. */
    replyTarget: fastAgentReplyTargetSchema,
  }),
]);

export type FastAgentConversation = z.infer<typeof fastAgentConversationSchema>;

export const fastAgentParentSchema = z.object({
  sessionId: z.string().uuid(),
  conversation: fastAgentConversationSchema,
});

export type FastAgentParent = z.infer<typeof fastAgentParentSchema>;

/**
 * A delegated Fast child keeps its parent's coordinates for lifecycle routing,
 * but the child runtime must not treat those coordinates as a direct reply
 * surface. Fast owns all chat delivery for the child.
 */
export function buildFastAgentChildTaskMetadata(parent: FastAgentParent): {
  communicationContextInherited: true;
  fastAgentSessionId: string;
  fastAgentParent: FastAgentParent;
} {
  return {
    communicationContextInherited: true,
    fastAgentSessionId: parent.sessionId,
    fastAgentParent: parent,
  };
}

export function getFastAgentParentFromPayload(
  payload: unknown,
): FastAgentParent | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const parsed = z
    .object({ fastAgentParent: fastAgentParentSchema })
    .safeParse(payload);

  return parsed.success ? parsed.data.fastAgentParent : null;
}
