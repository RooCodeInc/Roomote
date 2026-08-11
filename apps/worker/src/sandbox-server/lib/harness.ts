import EventEmitter from 'node:events';

import type {
  AcpMessage,
  AcpPersistedEnvelope,
  AcpRequestUserInputPayload,
  AcpRequestUserInputAnswers,
  AcpTurnCompletedEvent,
  TaskEnvVarRequestVariable,
  TaskEvent,
} from '@roomote/types';

/** Internal task-message signal for an unrecoverable provider failure. */
export const TERMINAL_PROVIDER_ERROR_SAY = 'terminal_provider_error';

/**
 * Command names supported by the sandbox harness layer.
 * This is the local subset currently used by the OpenCode runtime.
 */
export const TaskCommandName = {
  StartNewTask: 'StartNewTask',
  CancelTask: 'CancelTask',
  CloseTask: 'CloseTask',
  ResumeTask: 'ResumeTask',
  SendMessage: 'SendMessage',
  RestoreQueuedMessages: 'RestoreQueuedMessages',
  DeleteQueuedMessage: 'DeleteQueuedMessage',
  PrioritizeQueuedMessage: 'PrioritizeQueuedMessage',
  ReorderQueuedMessage: 'ReorderQueuedMessage',
  AnswerUserInputRequest: 'AnswerUserInputRequest',
} as const;

export type TaskCommandName =
  (typeof TaskCommandName)[keyof typeof TaskCommandName];

export interface StartNewTaskCommand {
  commandName: typeof TaskCommandName.StartNewTask;
  data: {
    text: string;
    images?: string[];
    workflowPhase?: string;
    visibleInTranscript?: boolean;
    source?: string;
    userId?: string;
    userName?: string;
    userImageUrl?: string;
    clientMessageId?: string;
    goalGeneration?: string | null;
    configuration?: Record<string, unknown>;
    newTab?: boolean;
  };
}

export interface SendMessageCommand {
  commandName: typeof TaskCommandName.SendMessage;
  data: {
    text?: string;
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
    goalGeneration?: string | null;
  };
}

export interface QueuedPromptMessageSnapshot {
  id: string;
  text: string;
  images?: string[];
  workflowPhase?: string;
  queueOnly?: boolean;
  visibleInTranscript?: boolean;
  userId?: string;
  userName?: string;
  userImageUrl?: string;
  clientMessageId?: string;
  goalGeneration?: string | null;
  timestamp: number;
}

export function cloneQueuedPromptMessageSnapshot(
  queuedMessage: QueuedPromptMessageSnapshot,
): QueuedPromptMessageSnapshot {
  return {
    ...queuedMessage,
    ...(queuedMessage.images ? { images: [...queuedMessage.images] } : {}),
  };
}

export interface HarnessQueuedMessage {
  id: string;
  text: string;
  images?: string[];
  userName?: string;
  userImageUrl?: string;
  clientMessageId?: string;
  timestamp: number;
}

export interface RestoreQueuedMessagesCommand {
  commandName: typeof TaskCommandName.RestoreQueuedMessages;
  data: {
    queuedMessages: QueuedPromptMessageSnapshot[];
  };
}

export interface DeleteQueuedMessageCommand {
  commandName: typeof TaskCommandName.DeleteQueuedMessage;
  data: {
    id: string;
  };
}

export interface PrioritizeQueuedMessageCommand {
  commandName: typeof TaskCommandName.PrioritizeQueuedMessage;
  data: {
    id: string;
  };
}

export interface ReorderQueuedMessageCommand {
  commandName: typeof TaskCommandName.ReorderQueuedMessage;
  data: {
    id: string;
    targetId: string;
    position: 'before' | 'after';
  };
}

export interface AnswerUserInputRequestCommand {
  commandName: typeof TaskCommandName.AnswerUserInputRequest;
  data: {
    requestId: string;
    answers: AcpRequestUserInputAnswers;
    userId?: string;
  };
}

/**
 * Attribution for a user-initiated cancel. Presence of this data is what
 * marks the cancel as an explicit user stop (and produces a visible
 * `task_cancelled` transcript marker); internal cancels (steer replay,
 * env-var resumable stop, task replacement) omit it.
 */
export interface CancelTaskAttribution {
  name?: string;
  source?: string;
}

export interface CancelTaskCommand {
  commandName: typeof TaskCommandName.CancelTask;
  data?: {
    cancelledBy?: CancelTaskAttribution;
  };
}

export interface CloseTaskCommand {
  commandName: typeof TaskCommandName.CloseTask;
}

export interface ResumeTaskCommand {
  commandName: typeof TaskCommandName.ResumeTask;
  data: string;
}

export type TaskCommand =
  | StartNewTaskCommand
  | SendMessageCommand
  | RestoreQueuedMessagesCommand
  | DeleteQueuedMessageCommand
  | PrioritizeQueuedMessageCommand
  | ReorderQueuedMessageCommand
  | AnswerUserInputRequestCommand
  | CancelTaskCommand
  | CloseTaskCommand
  | ResumeTaskCommand;

export function extractQueuedMessageId(command: TaskCommand): string | null {
  const data = (command as { data?: { id?: string } }).data;
  const id = data?.id;

  if (typeof id !== 'string' || id.trim().length === 0) {
    return null;
  }

  return id;
}

export function extractQueuedMessageMove(command: TaskCommand): {
  id: string;
  targetId: string;
  position: 'before' | 'after';
} | null {
  const data = (
    command as {
      data?: {
        id?: string;
        targetId?: string;
        position?: 'before' | 'after';
      };
    }
  ).data;

  const id = data?.id;
  const targetId = data?.targetId;
  const position = data?.position;

  if (typeof id !== 'string' || id.trim().length === 0) {
    return null;
  }

  if (typeof targetId !== 'string' || targetId.trim().length === 0) {
    return null;
  }

  if (position !== 'before' && position !== 'after') {
    return null;
  }

  return { id, targetId, position };
}

export interface HarnessPendingUserInputRequest extends AcpRequestUserInputPayload {
  ts: number;
}

export interface HarnessPendingEnvVarRequest {
  key: string;
  ts: number;
  variables: TaskEnvVarRequestVariable[];
}

export interface HarnessRestartRequest {
  reason: string;
  sessionId?: string;
  replayCommands?: TaskCommand[];
}

/**
 * Fired when a background command handler rejects asynchronously after
 * `sendCommand` has already returned. The sync boolean from `sendCommand`
 * only reflects whether the harness accepted the command; anything that
 * happens during the async dispatch (RPC failure, thread start failure)
 * surfaces here.
 */
export interface HarnessCommandError {
  command: TaskCommand;
  error: unknown;
}

export type HarnessInferenceUsageCostSource = 'opencode_message' | 'missing';

export interface HarnessInferenceUsageEvent {
  sessionId: string;
  messageId: string;
  providerId?: string;
  modelId?: string;
  /**
   * Harness agent that produced the message: the main agent (for example
   * `build`) or a subagent name (for example `explore` or `visual`).
   */
  agent?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  contextTokens: number;
  costMicroUsd: number;
  costSource: HarnessInferenceUsageCostSource;
  messageCreatedAt?: Date;
  messageCompletedAt?: Date;
}

/**
 * Events emitted by all Harness implementations.
 */
export interface HarnessEvents {
  taskEvent: [event: TaskEvent];
  connected: [];
  disconnected: [];
  restartRequested: [request: HarnessRestartRequest];
  runtimeOutput: [event: AcpMessage];
  runtimePersistedEnvelope: [envelope: AcpPersistedEnvelope];
  runtimeTurnCompleted: [event: AcpTurnCompletedEvent];
  runtimeInferenceUsage: [event: HarnessInferenceUsageEvent];
  commandError: [error: HarnessCommandError];
}

/**
 * A Harness abstracts the communication layer between the worker process
 * and the HarnessManager. Runtime-specific transports normalize into this
 * contract before worker callbacks consume them.
 */
export interface Harness extends EventEmitter<HarnessEvents> {
  /**
   * Subscribe to task events from the runtime.
   * Returns an unsubscribe function.
   */
  subscribe(listener: (event: TaskEvent) => void): () => void;

  /**
   * Subscribe to live Roomote runtime output events.
   * Returns an unsubscribe function.
   */
  subscribeRuntimeOutput(listener: (event: AcpMessage) => void): () => void;

  /**
   * Subscribe to persisted Roomote runtime envelope events.
   * Returns an unsubscribe function.
   */
  subscribeRuntimePersistedEnvelope(
    listener: (envelope: AcpPersistedEnvelope) => void,
  ): () => void;

  /**
   * Subscribe to runtime turn-completed events.
   * Returns an unsubscribe function.
   */
  subscribeRuntimeTurnCompleted(
    listener: (event: AcpTurnCompletedEvent) => void,
  ): () => void;

  /**
   * Subscribe to task inference usage events. Runtimes emit these for finalized
   * model messages so the worker can persist hidden accounting data separately
   * from user-facing transcript envelopes.
   */
  subscribeRuntimeInferenceUsage?(
    listener: (event: HarnessInferenceUsageEvent) => void,
  ): () => void;

  /**
   * Send a command to the runtime.
   * Returns false if the command could not be accepted (harness is not
   * connected or has been disposed). Returning true only means the command
   * was dispatched: actual execution happens asynchronously and failures
   * surface via the `commandError` event.
   */
  sendCommand(command: TaskCommand): boolean;

  /**
   * Subscribe to background command handler failures. Optional because not
   * every harness implementation emits structured async errors today.
   */
  subscribeCommandError?(
    listener: (error: HarnessCommandError) => void,
  ): () => void;

  /**
   * Check if the runtime is connected and ready to receive commands.
   */
  get isConnected(): boolean;

  /**
   * Whether this harness can steer a new user prompt into the active turn via
   * the runtime's native protocol (e.g. `turn/steer`). Harnesses that can only
   * steer by prioritizing queued work and cancelling return `false`.
   */
  get supportsNativeTurnSteering(): boolean;

  /**
   * Return any currently pending request_user_input prompts for the active
   * runtime task.
   */
  getPendingUserInputRequests?(): HarnessPendingUserInputRequest[];

  /**
   * Return the current pending org env-var request for the active runtime
   * task.
   */
  getPendingEnvVarRequest?(): HarnessPendingEnvVarRequest | null;

  /**
   * Return the current in-memory follow-up prompt queue for the active runtime
   * task.
   */
  getQueuedMessages?(): HarnessQueuedMessage[];

  /**
   * Return the current workflow phase for the active runtime turn when the
   * harness tracks that state.
   */
  getCurrentWorkflowPhase?(): string | null;

  /**
   * Return the full queued follow-up snapshot needed to restore the prompt
   * queue on a replacement harness after reconnect.
   */
  getQueuedMessageSnapshots?(): QueuedPromptMessageSnapshot[];

  /**
   * Clean up resources (listeners, intervals, streams).
   */
  dispose(): void;

  /**
   * Replace the environment used for future command/terminal executions when
   * the harness supports mutable command env.
   */
  setCommandEnv?(env: Record<string, string>): void;

  /**
   * Return the current command env when the harness supports mutable command
   * env for future terminal executions.
   */
  getCommandEnv?(): Record<string, string>;

  /**
   * Request a reconnect onto the latest known session after the caller has
   * updated runtime state that only takes effect on harness startup.
   */
  requestReconnect?(options: {
    reason: string;
    replayCommands?: TaskCommand[];
    afterCurrentTurn?: boolean;
  }): Promise<void>;
}
