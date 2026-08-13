import type {
  AcpRequestUserInputAnswers,
  AcpRequestUserInputPayload,
  AcpRequestUserInputResponsePayload,
  RunStatus,
  CommunicationProvider,
  EnvironmentConfig,
  RequestedWorkKind,
  TaskGoal,
} from '@roomote/types';
import type { TaskRun, DequeuedTaskRun } from '@roomote/sdk/client';

import type {
  TaskPhase,
  TaskState,
} from '../sandbox-server/lib/harness-manager';

import type { WorkerEnv } from '../env';
import type { HarnessLogger } from '../logging';
import type { RepoLocalSkill } from '../workspace/repo-local-skills';
import type {
  ActorMismatchPolicy,
  PrepareActorScopedTurnResult,
} from './prepare-actor-scoped-turn';

export type RunTaskContext = Record<string, unknown>;

/**
 * How background environment setup (repository setup commands + Docker
 * projects) ended, as delivered to `onSettled` listeners.
 */
export type EnvironmentSetupSettledOutcome =
  | { status: 'fulfilled'; warningMessages: string[] }
  | { status: 'rejected'; errorMessage: string };

/**
 * Lets the task runtime observe background environment setup without owning
 * it. Implemented by BackgroundEnvironmentSetupController; consumed by
 * runTask to (a) tell the agent whether setup is still running and (b) push a
 * notification into the harness session when it settles mid-task. Delivery is
 * withheld while a request_user_input is outstanding so the notice cannot
 * make the agent re-issue a pending question (#661). A task that went idle
 * while setup was still running is woken with an idle-aware variant so it can
 * resume work it reported as blocked; stopped or shutting-down tasks drop the
 * notice. `.roomote/setup-status.json` stays the on-disk ground truth either
 * way.
 */
export interface BackgroundEnvironmentSetupNotifier {
  /** True while environment setup is still running in the background. */
  readonly hasPendingBackgroundSetup: boolean;
  /**
   * Register a listener invoked once background setup settles. Fires
   * immediately (synchronously) if setup already settled; never fires when
   * there is no background setup.
   */
  onSettled(listener: (outcome: EnvironmentSetupSettledOutcome) => void): void;
}

/**
 * Task-level channel bindings from the SDK dequeue/resume response's `task`
 * object. These live on the tasks row and are the preferred source for
 * Slack/Linear routing decisions; payload-derived extraction remains the
 * fallback for payloads that predate the task columns.
 */
type TaskChannelBindings = Pick<
  DequeuedTaskRun['task'],
  'slackChannelId' | 'slackThreadTs' | 'linearSessionId'
> & {
  goal?: DequeuedTaskRun['task']['goal'];
};

type Todo = {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
};

/**
 * Harness-agnostic callback events. Runtime output maps into these semantic
 * types so callbacks never need to know which transport produced the message.
 */
export type CallbackEvent =
  | {
      type: 'completion';
      text: string;
      ts: number;
    }
  | {
      type: 'followup';
      question: string;
      suggestions: Array<string | { answer: string }>;
      ts: number;
    }
  | {
      type: 'request_user_input';
      request: AcpRequestUserInputPayload;
      ts: number;
    }
  | {
      type: 'request_user_input_response';
      response: AcpRequestUserInputResponsePayload;
      ts: number;
    }
  | {
      type: 'todo_update';
      todos: Todo[];
      ts: number;
    }
  | {
      type: 'reasoning';
      text: string;
      ts: number;
    }
  | {
      type: 'text';
      text: string;
      ts: number;
    }
  | {
      type: 'tool_action';
      usage: {
        action: string;
        details?: string;
        todoData?: { todos: Todo[] };
      };
      ts: number;
    }
  | {
      type: 'mcp_action';
      usage: {
        action: string;
        details?: string;
        todoData?: { todos: Todo[] };
      };
      ts: number;
    };

export type RunTaskCallbacks = {
  onStart?: (
    taskRun: TaskRun,
    taskId: string,
    context: RunTaskContext,
  ) => Promise<void>;
  onMessage?: (
    taskRun: TaskRun,
    taskId: string,
    event: CallbackEvent,
    context: RunTaskContext,
  ) => Promise<void>;
  onExit?: (
    taskRun: TaskRun,
    status: RunStatus,
    context: RunTaskContext,
  ) => Promise<void>;
};

export type RunTaskOptions = {
  taskRun: DequeuedTaskRun['taskRun'];
  envVars: Record<string, string | undefined>;
  /**
   * Snapshot of the dequeue-provided env vars taken before injectEnvVars adds
   * runtime-internal entries (auth bypass values, BASH_ENV, ...). This is the
   * operator-owned set used for custom MCP config `${...}` substitution;
   * `envVars` must not be used for that because post-injection it can
   * reclassify internal values as operator-provided.
   */
  userEnvVars?: Record<string, string | undefined>;
  workspacePath: string;
  usesSharedWorkspaceRoot?: boolean;
  repoPaths?: Record<string, string>;
  repoLocalSkills?: RepoLocalSkill[];
  workspaceReadinessWarnings?: string[];
  /**
   * Observer for environment setup still finishing in the background. Used to
   * pick accurate readiness wording for the agent and to notify it in-session
   * when setup settles (withheld while a question is pending, delivered as an
   * idle wake-up when the task settled mid-setup, dropped once the task is
   * stopped or shutting down).
   */
  backgroundEnvironmentSetup?: BackgroundEnvironmentSetupNotifier;
  /**
   * Task prompt. Optional for Session jobs which wait for the first prompt
   * from the web UI.
   */
  prompt?: string;
  /**
   * Harness instructions generated by the prompt builder. These are delivered
   * through the active harness developer-instructions layer together with
   * task-scoped environment guidance.
   */
  harnessInstructions?: string;
  /**
   * Requested work kind stamped on the task at enqueue. Lives on the tasks
   * row and is supplied by the SDK dequeue/resume response
   * (`requestedWorkKind` top-level convenience field, mirrored on `task`).
   * Used only to pick the initial workflow phase.
   */
  requestedWorkKind?: RequestedWorkKind | null;
  /**
   * Task-level channel bindings from the SDK dequeue/resume response.
   * Preferred over payload-derived extraction for Slack/Linear polling and
   * drain gates; payload extraction remains the fallback.
   */
  task?: TaskChannelBindings;
  /**
   * Deployment-wide agent behavior instructions configured in admin
   * settings. When provided, these are merged into the startup
   * environment-instructions block before environment-specific guidance.
   */
  orgAgentInstructions?: string;
  /**
   * Environment-specific instructions for LLM agents.
   * When provided, these are formatted into the environment-instructions
   * block that is delivered through harness developer instructions.
   */
  agentInstructions?: string;
  /**
   * Full environment configuration. Used to build sandbox context
   * instructions that tell the agent about running services and ports.
   */
  environmentConfig?: EnvironmentConfig;
  callbacks: RunTaskCallbacks;
  context: RunTaskContext;
  logger: HarnessLogger;
  /**
   * External cancellation signal controlled by the worker job wrapper. When
   * aborted, the runtime should stop the active task and tear down promptly.
   */
  cancelSignal?: AbortSignal;
  /**
   * For SnapshotResume tasks, this is the source harness session ID that
   * should be resumed instead of starting a new task.
   */
  harnessSessionId?: string;
  /**
   * Centralized environment manager. When provided, child processes get
   * isolated env instead of inheriting process.env.
   */
  workerEnv: WorkerEnv;
  /**
   * Caller-managed direct runs own sandbox cleanup, so they should not wait
   * for the production sleep/snapshot handoff after the harness finishes.
   */
  skipExternalSleepAction?: boolean;
  /**
   * Override the post-turn keepalive window. Direct runs can use this to exit
   * immediately while normal worker dispatch keeps the production keepalive
   * behavior.
   */
  keepaliveMsOverride?: number;
};

export type PollingIntervals = {
  cancelInterval: NodeJS.Timeout | undefined;
  slackMessageInterval: NodeJS.Timeout | undefined;
  slackMessageCleanup?: () => Promise<void>;
  communicationMessageIntervals?: Partial<
    Record<CommunicationProvider, NodeJS.Timeout>
  >;
  communicationMessageCleanups?: Partial<
    Record<CommunicationProvider, () => Promise<void>>
  >;
  linearMessageInterval: NodeJS.Timeout | undefined;
  githubTokenRefreshInterval: NodeJS.Timeout | undefined;
};

export type RunTaskState = TaskState &
  PollingIntervals & {
    phase?: TaskPhase;
    isConnected?: boolean;
  };

export interface ListenerOptions {
  taskRun: DequeuedTaskRun['taskRun'];
  /**
   * Task-level channel bindings from the SDK dequeue/resume response.
   * Preferred over payload-derived extraction when deciding which polling
   * intervals to start; payload extraction remains the fallback.
   */
  task?: TaskChannelBindings;
  state: RunTaskState;
  logger: HarnessLogger;
  workingDirectory: string;
  cancelTask: () => void;
  sendPrompt: (options: {
    prompt: string;
    images?: string[];
    workflowPhase?: string;
    autoSteerWhenQueued?: boolean;
    queueOnly?: boolean;
    visibleInTranscript?: boolean;
    source?: string;
    userId?: string;
    userName?: string;
    userImageUrl?: string;
    clientMessageId?: string;
    goalContext?: TaskGoal;
  }) => boolean;
  slackReplySatisfactionStateFile?: string;
  answerUserInputRequest: (options: {
    requestId: string;
    answers: AcpRequestUserInputAnswers;
    userId?: string;
  }) => boolean;
  prepareActorScopedTurn: (
    targetUserId?: string,
    options?: {
      allowMcpReconnect?: boolean;
      deferReconnectUntilTurnBoundary?: boolean;
      onMismatch?: ActorMismatchPolicy;
    },
  ) => Promise<PrepareActorScopedTurnResult>;
  getVisibleQueuedPromptCount?: () => number;
}
