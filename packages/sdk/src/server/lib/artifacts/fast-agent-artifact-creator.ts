import { createFastAgentConversationArtifact } from './create-session-artifact';

type FastAgentArtifactInput = Omit<
  Parameters<typeof createFastAgentConversationArtifact>[0],
  'fastConversationId'
>;

/**
 * Builds the `createArtifact` adapter for a Fast turn from its conversation
 * id. The `create_artifact` tool is always in the model's catalog, so every
 * path that runs a turn (surface follow-ups, durable queue resumes,
 * platform-event turns) must carry this or the call fails as unavailable.
 */
export function buildFastAgentArtifactCreator(fastConversationId: string) {
  return (artifact: FastAgentArtifactInput) =>
    createFastAgentConversationArtifact({ fastConversationId, ...artifact });
}
