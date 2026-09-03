import { z } from 'zod';

export const fastAgentSurfaces = [
  'slack',
  'discord',
  'teams',
  'telegram',
  'linear',
  'github',
  'gitlab',
  'bitbucket',
  'ado',
  'gitea',
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
  /**
   * Source-control surfaces: a pull request or issue discussion.
   * `workspaceId` is `<host>/<owner>/<repo>`, `conversationId` and
   * `replyTarget.channelId` are `pull/<number>` or `issues/<number>`, and
   * `replyTarget.threadId` is the review comment a reply threads under.
   */
  z.object({
    surface: z.literal('github'),
    ...fastAgentConversationIdentitySchema,
    replyTarget: fastAgentReplyTargetSchema,
  }),
  z.object({
    surface: z.literal('gitlab'),
    ...fastAgentConversationIdentitySchema,
    replyTarget: fastAgentReplyTargetSchema,
  }),
  z.object({
    surface: z.literal('bitbucket'),
    ...fastAgentConversationIdentitySchema,
    replyTarget: fastAgentReplyTargetSchema,
  }),
  z.object({
    surface: z.literal('ado'),
    ...fastAgentConversationIdentitySchema,
    replyTarget: fastAgentReplyTargetSchema,
  }),
  z.object({
    surface: z.literal('gitea'),
    ...fastAgentConversationIdentitySchema,
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

export const fastAgentSourceControlSurfaces = [
  'github',
  'gitlab',
  'bitbucket',
  'ado',
  'gitea',
] as const;

export type FastAgentSourceControlSurface =
  (typeof fastAgentSourceControlSurfaces)[number];

export type FastAgentSourceControlConversation = Extract<
  FastAgentConversation,
  { surface: FastAgentSourceControlSurface }
>;

export function isFastAgentSourceControlConversation(
  conversation: FastAgentConversation,
): conversation is FastAgentSourceControlConversation {
  return (fastAgentSourceControlSurfaces as readonly string[]).includes(
    conversation.surface,
  );
}

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

/** An emoji reaction a chat surface delivered as Fast human input. */
export const fastAgentReactionExternalInputSchema = z.object({
  type: z.literal('reaction_added'),
  provider: z.enum(['slack', 'discord', 'teams', 'telegram']),
  reactions: z.array(
    z.object({ name: z.string().min(1), id: z.string().optional() }),
  ),
  reactor: z.object({
    externalUserId: z.string().min(1),
    displayName: z.string().optional(),
  }),
  message: z.object({
    workspaceId: z.string().min(1),
    channelId: z.string().min(1),
    messageId: z.string().min(1),
    threadId: z.string().optional(),
    text: z.string().optional(),
  }),
  eventId: z.string().min(1),
});

export type FastAgentReactionExternalInput = z.infer<
  typeof fastAgentReactionExternalInputSchema
>;

export const fastAgentPlatformEventKindSchema = z.enum([
  'delegated_task',
  'automation',
  'setup',
  'input_response',
]);

export const fastAgentPlatformEventVisibilitySchema = z.enum([
  'optional',
  'required',
]);

export const fastAgentHumanFollowUpEventSchema = z.object({
  type: z.literal(FAST_AGENT_HUMAN_FOLLOW_UP_EVENT_TYPE),
  eventId: z.string().min(1),
  currentMessageId: z.string().min(1),
  userId: z.string().min(1),
  question: z.string().min(1),
  images: z.array(z.string()).optional(),
  senderDisplayName: z.string().min(1).optional(),
  senderExternalId: z.string().min(1).optional(),
  /**
   * Set when the human input was an emoji reaction rather than a message, so
   * a run that resumes the turn keeps reaction semantics.
   */
  input: z
    .object({
      type: z.literal('reaction'),
      externalInput: fastAgentReactionExternalInputSchema,
    })
    .optional(),
  /**
   * Set for platform events admitted through the human turn path (web setup
   * kickoffs and input responses), so a run that resumes the turn keeps
   * their framing instead of treating the event text as a human message.
   */
  turnSource: z.literal('platform_event').optional(),
  platformEventKind: fastAgentPlatformEventKindSchema.optional(),
  platformEventVisibility: fastAgentPlatformEventVisibilitySchema.optional(),
  setupSession: z.boolean().optional(),
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

/**
 * Session linkage without orchestrator report ownership: the task shows up in
 * the parent Fast session (session_tasks + the fast task list) and can emit
 * parent events, but keeps its own workflow's report and communication
 * behavior. Used for review-pipeline tasks attached to the session whose
 * delegated work opened the reviewed PR.
 */
export function buildFastAgentSessionAttachment(parent: FastAgentParent): {
  fastAgentSessionId: string;
  fastAgentParent: FastAgentParent;
} {
  return {
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
