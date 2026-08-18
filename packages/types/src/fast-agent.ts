import { z } from 'zod';

export const fastAgentSurfaces = ['slack', 'discord'] as const;
export const fastAgentSurfaceSchema = z.enum(fastAgentSurfaces);

export type FastAgentSurface = z.infer<typeof fastAgentSurfaceSchema>;

export const fastAgentConversationSchema = z.object({
  surface: fastAgentSurfaceSchema,
  workspaceId: z.string().min(1),
  channelId: z.string().min(1),
  threadId: z.string().min(1),
});

export type FastAgentConversation = z.infer<typeof fastAgentConversationSchema>;

export const fastAgentParentSchema = z.object({
  sessionId: z.string().uuid(),
  conversation: fastAgentConversationSchema,
});

export type FastAgentParent = z.infer<typeof fastAgentParentSchema>;

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
