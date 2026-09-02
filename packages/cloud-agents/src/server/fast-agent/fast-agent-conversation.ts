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

export type FastAgentReactionExternalInput = {
  type: 'reaction_added';
  provider: 'slack' | 'discord' | 'teams' | 'telegram';
  reactions: Array<{ name: string; id?: string }>;
  reactor: { externalUserId: string; displayName?: string };
  message: {
    workspaceId: string;
    channelId: string;
    messageId: string;
    threadId?: string;
    text?: string;
  };
  eventId: string;
};

export const FAST_AGENT_REACTION_INPUT_TYPE = 'reaction' as const;

export type FastAgentHumanInput =
  | { type: 'message' }
  | {
      type: typeof FAST_AGENT_REACTION_INPUT_TYPE;
      externalInput: FastAgentReactionExternalInput;
    };

export function buildFastAgentReactionExternalInputQuestion(
  input: FastAgentReactionExternalInput,
): string {
  return `<external_input>${JSON.stringify(input)}</external_input>`;
}

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
  branch?: string;
  /** Optional launch idempotency key persisted in the standard task-run
   * payload; a partial unique index makes concurrent retries converge. */
  launchIdempotencyKey?: string;
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

export type FastAgentTurnActivity = {
  start: () => void;
  settle: () => Promise<void>;
  updateTitle?: (title: string | null) => void;
};

export type FastAgentMcpServerConfig = {
  url: string;
  headers: Record<string, string>;
  disabledTools?: string[];
};

/** Structured input request issued with the Fast-native request_user_input tool. */
export type FastAgentInputRequest = {
  requestId: string;
  preset?: FastAgentInputPreset;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    isOther: boolean;
    isSecret: boolean;
    options?: Array<{ label: string; description: string }>;
    multiple?: boolean;
  }>;
};

export type FastAgentInputPreset = 'setup_starter_tasks';

/** Surface adapter for side effects available during one Fast turn. */
export type FastAgentTurnAdapter = {
  launchTask: LaunchFastAgentTask;
  /**
   * Optional surface-specific launch gate. Use this for durable product
   * readiness conditions that the model prompt alone must not enforce.
   */
  assertTaskLaunch?: () => Promise<void>;
  postReply: (reply: FastAgentReply) => Promise<FastAgentReplyHandle | void>;
  replaceReply?: (
    handle: FastAgentReplyHandle,
    reply: FastAgentReply,
  ) => Promise<FastAgentReplyHandle | void>;
  postReaction?: (reaction: FastAgentReaction) => Promise<void>;
  activity?: FastAgentTurnActivity;
  retryTaskStart?: RetryFastAgentTaskStart;
  resolveMcpServerConfigs?: () => Promise<
    Record<string, FastAgentMcpServerConfig>
  >;
  /** Called when the turn ends waiting on structured user input. The caller
   * persists the pending request and marks the session needs_input. */
  requestUserInput?: (request: FastAgentInputRequest) => Promise<void>;
  /** Resolve a trusted preset without accepting model-supplied options. */
  resolveUserInputPreset?: (
    preset: FastAgentInputPreset,
  ) => Promise<FastAgentInputRequest['questions']>;
  /**
   * Called when an interrupted turn is still safe to replay and has handed
   * itself back to the durable queue; wakes the queue so recovery does not
   * wait for the next sweep. Best effort.
   */
  requestDurableResume?: () => Promise<void>;
};
