import type { FastAgentConversation } from '@roomote/types';

export type { FastAgentConversation, FastAgentSurface } from '@roomote/types';

/** Preserve existing persisted/Redis workspace keys while the storage schema
 * remains Slack-shaped. New provider adapters always pass raw provider IDs. */
export function getFastAgentConversationStorageWorkspaceId(
  conversation: Pick<FastAgentConversation, 'surface' | 'workspaceId'>,
): string {
  return conversation.surface === 'slack'
    ? conversation.workspaceId
    : `${conversation.surface}:${conversation.workspaceId}`;
}

export type FastAgentTurnSource = 'human' | 'platform_event';

export type FastAgentReply = {
  purpose: 'ack' | 'progress' | 'closeout' | 'clarification';
  message: string;
  imageArtifactIds?: string[];
  /** True for the parent-owned task kickoff. Deliverers must treat anything
   * short of a visible, durable post (including deliberate suppression) as a
   * failure so the launch gate never opens without its kickoff. */
  kickoff?: boolean;
};

export type FastAgentReaction = {
  name: string;
  purpose: 'ack' | 'closeout';
  messageId: string;
};

export type LaunchFastAgentTask = (params: {
  prompt: string;
  environmentId: string | null;
  parentSessionId: string;
  postKickoff: (task: { taskId: string; taskUrl?: string }) => Promise<void>;
}) => Promise<
  | { success: true; taskId: string; taskUrl?: string }
  | { success: false; error: string }
>;

export type RetryFastAgentTaskStart = () => Promise<
  { success: true; runId: number } | { success: false; error: string }
>;

/** Surface adapter for side effects available during one Fast turn. */
export type FastAgentTurnAdapter = {
  launchTask: LaunchFastAgentTask;
  postReply: (reply: FastAgentReply) => Promise<void>;
  postReaction?: (reaction: FastAgentReaction) => Promise<void>;
  retryTaskStart?: RetryFastAgentTaskStart;
};
