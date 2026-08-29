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

export type FastAgentPlatformEventKind =
  | 'delegated_task'
  | 'automation'
  | 'setup'
  | 'input_response';

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
  images?: string[];
  environmentId: string | null;
  model?: string | null;
  parentSessionId: string;
  /** Optional launch idempotency key persisted in the standard task-run
   * payload; a partial unique index makes concurrent retries converge. */
  launchIdempotencyKey?: string;
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

/** Structured input request issued with the Fast-native request_user_input tool. */
export type FastAgentInputRequest = {
  requestId: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    isOther: boolean;
    isSecret: boolean;
    options?: Array<{ label: string; description: string }>;
    selectionMode?: 'single' | 'multiple';
    minSelections?: number;
  }>;
};

export type FastAgentSetupStarterLaunchResult = {
  launched: Array<{ starterTaskId: string; taskId: string }>;
  failed: Array<{ starterTaskId: string; error: string }>;
  /** True when setup completed because at least one task launched. */
  setupCompleted: boolean;
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
  /** Called when the turn ends waiting on structured user input. The caller
   * persists the pending request and marks the session needs_input. */
  requestUserInput?: (request: FastAgentInputRequest) => Promise<void>;
  /** Setup-only: launch validated starter-task catalog entries. */
  launchSetupStarterTasks?: (params: {
    taskIds: string[];
  }) => Promise<FastAgentSetupStarterLaunchResult>;
};
