import type { FastAgentConversation } from '@roomote/types';

export {
  isFastAgentCommunicationConversation,
  type FastAgentConversation,
  type FastAgentSurface,
} from '@roomote/types';

/** Build the N-1 Slack-shaped compatibility namespace. New persistence and
 * turn locks use surface/workspace/conversation identity fields directly. */
export function getFastAgentConversationStorageWorkspaceId(
  conversation: Pick<FastAgentConversation, 'surface' | 'workspaceId'>,
): string {
  return conversation.surface === 'slack'
    ? conversation.workspaceId
    : `${conversation.surface}:${conversation.workspaceId}`;
}

export type FastAgentTurnSource = 'human' | 'platform_event';

export type FastAgentPlatformEventVisibility = 'optional' | 'required';

export type FastAgentPlatformEventHandling = 'default' | 'present_only';

export type FastAgentPlatformEventKind = 'delegated_task' | 'automation';

export type FastAgentSuggestedTask = {
  title: string;
  brief: string;
};

export type FastAgentReply = {
  purpose: 'ack' | 'progress' | 'closeout' | 'clarification';
  message: string;
  imageArtifactIds?: string[];
  /** Launchable follow-ups attached to a Fast automation report. */
  suggestions?: FastAgentSuggestedTask[];
  /** True for the parent-owned task kickoff. Deliverers must treat anything
   * short of a visible, durable post (including deliberate suppression) as a
   * failure so the launch gate never opens without its kickoff. */
  kickoff?: boolean;
};

export type FastAgentReplyHandle = {
  messageId: string;
};

export type FastAgentReaction = {
  name: string;
  purpose: 'ack' | 'closeout';
  messageId: string;
};

export type LaunchFastAgentTask = (params: {
  prompt: string;
  environmentId: string | null;
  model?: string | null;
  parentSessionId: string;
  postKickoff: (task: {
    taskId: string;
    taskUrl?: string;
    /** The surface shows the task link itself (for example on a task
     * card), so the kickoff text should not repeat it. */
    taskLinkRendered?: boolean;
  }) => Promise<void>;
}) => Promise<
  | {
      success: true;
      taskId: string;
      taskUrl?: string;
      /** True when an idempotent surface replay reused a task whose kickoff
       * was already delivered. */
      kickoffDelivered?: boolean;
    }
  | { success: false; error: string }
>;

export type RetryFastAgentTaskStart = () => Promise<
  { success: true; runId: number } | { success: false; error: string }
>;

export type FastAgentMcpServerConfig = {
  url: string;
  headers: Record<string, string>;
  disabledTools?: string[];
};

/** Surface adapter for side effects available during one Fast turn. */
export type FastAgentTurnAdapter = {
  launchTask: LaunchFastAgentTask;
  postReply: (reply: FastAgentReply) => Promise<FastAgentReplyHandle | void>;
  replaceReply?: (
    handle: FastAgentReplyHandle,
    reply: FastAgentReply,
  ) => Promise<FastAgentReplyHandle | void>;
  postReaction?: (reaction: FastAgentReaction) => Promise<void>;
  retryTaskStart?: RetryFastAgentTaskStart;
  resolveMcpServerConfigs?: () => Promise<
    Record<string, FastAgentMcpServerConfig>
  >;
};
