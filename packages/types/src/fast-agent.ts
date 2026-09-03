import { z } from 'zod';

export const fastAgentSurfaces = [
  'slack',
  'discord',
  'teams',
  'telegram',
  'linear',
  'automation',
  'web',
] as const;
export const fastAgentSurfaceSchema = z.enum(fastAgentSurfaces);

export type FastAgentSurface = z.infer<typeof fastAgentSurfaceSchema>;

export const fastAgentReplyTargetSchema = z.object({
  channelId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  /** Mutable provider routing address, currently required by Microsoft Teams. */
  serviceUrl: z.string().url().optional(),
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
    replyTarget: fastAgentReplyTargetSchema,
  }),
  z.object({
    surface: z.literal('discord'),
    ...fastAgentConversationIdentitySchema,
    /** Routable provider address. It is deliberately separate from identity. */
    replyTarget: fastAgentReplyTargetSchema,
  }),
  z.object({
    surface: z.literal('teams'),
    ...fastAgentConversationIdentitySchema,
    replyTarget: fastAgentReplyTargetSchema,
  }),
  z.object({
    surface: z.literal('telegram'),
    ...fastAgentConversationIdentitySchema,
    replyTarget: fastAgentReplyTargetSchema,
  }),
  z.object({
    surface: z.literal('linear'),
    ...fastAgentConversationIdentitySchema,
    /**
     * A Linear agent session. `workspaceId` is the Linear organization,
     * `conversationId` and `replyTarget.channelId` are the agent session id;
     * replies post as agent-session response activities.
     */
    replyTarget: fastAgentReplyTargetSchema,
  }),
  z.object({
    surface: z.literal('automation'),
    ...fastAgentConversationIdentitySchema,
  }),
  z.object({
    surface: z.literal('web'),
    ...fastAgentConversationIdentitySchema,
  }),
]);

export type FastAgentConversation = z.infer<typeof fastAgentConversationSchema>;

export type FastAgentCommunicationConversation = Extract<
  FastAgentConversation,
  { surface: 'slack' | 'discord' | 'teams' | 'telegram' }
>;

export function isFastAgentCommunicationConversation(
  conversation: FastAgentConversation,
): conversation is FastAgentCommunicationConversation {
  return (
    conversation.surface === 'slack' ||
    conversation.surface === 'discord' ||
    conversation.surface === 'teams' ||
    conversation.surface === 'telegram'
  );
}

export const fastAgentParentSchema = z.object({
  sessionId: z.string().uuid(),
  conversation: fastAgentConversationSchema,
});

export type FastAgentParent = z.infer<typeof fastAgentParentSchema>;

export const FAST_AGENT_HUMAN_FOLLOW_UP_EVENT_TYPE = 'human_follow_up' as const;

export const fastAgentHumanFollowUpEventSchema = z.object({
  type: z.literal(FAST_AGENT_HUMAN_FOLLOW_UP_EVENT_TYPE),
  eventId: z.string().min(1),
  currentMessageId: z.string().min(1),
  userId: z.string().min(1),
  question: z.string().min(1),
  images: z.array(z.string()).optional(),
  senderDisplayName: z.string().min(1).optional(),
  senderExternalId: z.string().min(1).optional(),
});

export type FastAgentHumanFollowUpEvent = z.infer<
  typeof fastAgentHumanFollowUpEventSchema
>;

export type TaskReportConsumer = 'direct-user' | 'orchestrator';

export const taskReportConsumerSchema = z.enum(['direct-user', 'orchestrator']);

/**
 * A delegated Fast child keeps its parent's coordinates for lifecycle routing,
 * but the child runtime must not treat those coordinates as a direct reply
 * surface. The orchestrator owns all chat delivery for the child.
 */
export function buildFastAgentChildTaskMetadata(parent: FastAgentParent): {
  communicationContextInherited: true;
  reportConsumer: 'orchestrator';
  fastAgentSessionId: string;
  fastAgentParent: FastAgentParent;
} {
  return {
    communicationContextInherited: true,
    reportConsumer: 'orchestrator',
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

export function getTaskReportConsumerFromPayload(
  payload: unknown,
): TaskReportConsumer {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const parsed = taskReportConsumerSchema.safeParse(
      (payload as Record<string, unknown>).reportConsumer,
    );
    if (parsed.success) {
      return parsed.data;
    }
  }

  return 'direct-user';
}
