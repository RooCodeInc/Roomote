import EventEmitter from 'node:events';

import type {
  AcpMessage,
  AcpRequestUserInputAnswers,
  TaskEventAbortedPayload,
  TaskEventCompletedPayload,
  TaskEvent,
  TaskEventMessagePayload,
  TaskEventStartedPayload,
  TaskPhase,
  TaskGoal,
  TaskStateEvent,
} from '@roomote/types';

import {
  ACP_ENVELOPE_EVENT_TYPES,
  isActiveTaskPhase,
  SANDBOX_TIMEOUT_MS,
  SNAPSHOT_CHECK_THRESHOLD_MS,
} from '@roomote/types';
import { captureWorkerMessage } from '../../monitoring/sentry';

export { isActiveTaskPhase };
export type { TaskPhase };

import {
  TERMINAL_PROVIDER_ERROR_SAY,
  type CancelTaskAttribution,
  type Harness,
} from './harness';

/**
 * Event names used by the HarnessManager.
 */
const HarnessEvent = {
  Message: 'message',
  TaskStarted: 'taskStarted' satisfies TaskStateEvent,
  TaskCompleted: 'taskCompleted' satisfies TaskStateEvent,
  TaskAborted: 'taskAborted' satisfies TaskStateEvent,
  QueuedMessagesUpdated: 'queuedMessagesUpdated',
} as const;

/**
 * Command names sent to the harness.
 */
const HarnessCommand = {
  StartNewTask: 'StartNewTask',
  SendMessage: 'SendMessage',
  AnswerUserInputRequest: 'AnswerUserInputRequest',
  DeleteQueuedMessage: 'DeleteQueuedMessage',
  PrioritizeQueuedMessage: 'PrioritizeQueuedMessage',
  ReorderQueuedMessage: 'ReorderQueuedMessage',
  CancelTask: 'CancelTask',
  CloseTask: 'CloseTask',
} as const;

/**
 * Task lifecycle state tracked by the HarnessManager.
 */
export interface TaskState {
  sessionId: string | undefined;
  lastMessageAt: number | undefined;
  lastActivityAt: number | undefined;
  taskFinishedAt: number | undefined;
  taskAbortedAt: number | undefined;
  clientDisconnectedAt: number | undefined;
  cancelTriggeredAt: number | undefined;
  lastErrorMessage: string | undefined;
}

export function createInitialTaskState(): TaskState {
  return {
    sessionId: undefined,
    lastMessageAt: undefined,
    lastActivityAt: undefined,
    taskFinishedAt: undefined,
    taskAbortedAt: undefined,
    clientDisconnectedAt: undefined,
    cancelTriggeredAt: undefined,
    lastErrorMessage: undefined,
  };
}

/** Task event names that represent observable task state transitions. */
const TASK_STATE_EVENTS = new Set([
  HarnessEvent.TaskStarted,
  HarnessEvent.TaskCompleted,
  HarnessEvent.TaskAborted,
]);

interface HarnessManagerEvents {
  stateChange: [phase: TaskPhase, state: TaskState];
  taskStateEvent: [eventName: TaskStateEvent];
  shutdown: [state: TaskState];
}

/** Say types that indicate provider errors. */
const ERROR_SAY_TYPES = new Set([
  'error',
  'api_req_failed',
  'api_req_retry_delayed',
  TERMINAL_PROVIDER_ERROR_SAY,
]);

const ACTIVE_SLEEP_HEARTBEAT_INTERVAL_MS = 45 * 1_000;
// Active turns need a small lease floor so zero-idle policies do not make
// in-flight work immediately eligible for external due-sleep handling.
const MIN_ACTIVE_SLEEP_WINDOW_MS = 60 * 1_000;

const UNEXPECTED_DISCONNECT_ERROR =
  'Harness disconnected unexpectedly before task completion';

interface HarnessManagerLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
}

export interface HarnessManagerCallbacks {
  onStart?: (taskId: string) => Promise<void>;
  onExit?: () => Promise<void>;
  onTaskUpdate?: (update: {
    taskId?: string;
    status?: string;
  }) => Promise<void>;
  onBeforeTaskCompletion?: (
    completionId: string,
  ) => Promise<HarnessManagerCompletionDecision>;
}

interface HarnessFollowUpPromptOptions {
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
}

export type HarnessManagerCompletionDecision =
  | 'finalize'
  | 'ignore'
  | {
      disposition: 'continue';
      prompt: HarnessFollowUpPromptOptions;
      onAccepted?: () => void;
      onRejected?: () => Promise<void>;
    };

interface HarnessManagerConfig {
  harness: Harness;
  keepaliveMs: number;
  /** Sandbox hard-deadline override. Defaults to {@link SANDBOX_TIMEOUT_MS}. */
  sandboxTimeoutMs?: number;
  /** Absolute machine expiry deadline in epoch milliseconds, if known. */
  sandboxExpiresAtMs?: number;
  runId?: number;
  taskId?: string | null;
  logger: HarnessManagerLogger;
  callbacks?: HarnessManagerCallbacks;
}

function formatCallbackError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStoppingPhase(phase: TaskPhase): boolean {
  return phase === 'shutting_down' || phase === 'stopped';
}

type MessageTaskEvent = Extract<
  TaskEvent,
  { eventName: typeof HarnessEvent.Message }
>;
type TaskStartedEvent = Extract<
  TaskEvent,
  { eventName: typeof HarnessEvent.TaskStarted }
>;
type TaskAbortedEvent = Extract<
  TaskEvent,
  { eventName: typeof HarnessEvent.TaskAborted }
>;
type TaskCompletedEvent = Extract<
  TaskEvent,
  { eventName: typeof HarnessEvent.TaskCompleted }
>;
type DeferredTurnSettlement =
  | typeof HarnessEvent.TaskCompleted
  | typeof HarnessEvent.TaskAborted;

function countDeliverableQueuedMessages(queuedMessages: unknown[]): number {
  return queuedMessages.filter((message) => {
    if (!message || typeof message !== 'object') {
      return true;
    }

    return !('queueOnly' in message) || message.queueOnly !== true;
  }).length;
}

export class HarnessManager extends EventEmitter<HarnessManagerEvents> {
  private phase: TaskPhase = 'idle';
  private state: TaskState;
  private harness: Harness;
  private keepaliveMs: number;
  private sandboxTimeoutMs: number;
  private sandboxExpiresAtMs?: number;
  private runId?: number;
  private taskId?: string | null;
  private logger: HarnessManagerLogger;
  private callbacks: HarnessManagerCallbacks;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private sleepHeartbeatTimer: NodeJS.Timeout | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private unsubscribeRuntimeOutput: (() => void) | null = null;
  private unsubscribeCommandError: (() => void) | null = null;
  private shutdownResolve: ((state: TaskState) => void) | null = null;
  private shutdownPromise: Promise<TaskState>;
  private runtimeQueuedMessagesCount = 0;
  private deferredTurnSettlement: DeferredTurnSettlement | null = null;
  private terminalProviderErrorPending = false;
  private completionDecisionPending = false;
  private completionDecisionSequence = 0;
  private continuationStartPending = false;
  private fallbackCompletionSequence = 0;
  private pendingCompletionId: string | null = null;

  /** Last task state event received for the parent task. */
  private lastTaskStateEvent: TaskStateEvent | null = null;

  constructor(config: HarnessManagerConfig) {
    super();

    this.harness = config.harness;
    this.keepaliveMs = config.keepaliveMs;
    this.sandboxTimeoutMs = config.sandboxTimeoutMs ?? SANDBOX_TIMEOUT_MS;
    this.sandboxExpiresAtMs = config.sandboxExpiresAtMs;
    this.runId = config.runId;
    this.taskId = config.taskId;
    this.logger = config.logger;
    this.callbacks = config.callbacks ?? {};

    this.state = this.createFreshState();

    this.shutdownPromise = new Promise<TaskState>((resolve) => {
      this.shutdownResolve = resolve;
    });

    this.attachHandlers();
  }

  get supportsNativeTurnSteering(): boolean {
    return this.harness.supportsNativeTurnSteering;
  }

  /**
   * Send a follow-up prompt to the currently running task and transition
   * to running phase. Clears completion timestamps so the keepalive timer
   * doesn't fire prematurely.
   */
  sendFollowUpPrompt(options: HarnessFollowUpPromptOptions): boolean {
    if (this.phase === 'shutting_down') {
      this.logger.warn(
        '[HarnessManager#sendFollowUpPrompt] Refusing follow-up while shutting down',
      );
      return false;
    }

    const success = this.sendHarnessCommand({
      commandName: HarnessCommand.SendMessage,
      data: {
        text: options.prompt,
        images: options.images,
        ...(options.workflowPhase
          ? { workflowPhase: options.workflowPhase }
          : {}),
        autoSteerWhenQueued: options.autoSteerWhenQueued,
        queueOnly: options.queueOnly,
        visibleInTranscript: options.visibleInTranscript,
        ...(options.source ? { source: options.source } : {}),
        userId: options.userId,
        userName: options.userName,
        userImageUrl: options.userImageUrl,
        clientMessageId: options.clientMessageId,
        goalContext: options.goalContext,
      },
    });

    if (success) {
      if (options.queueOnly) {
        return true;
      }

      // A successful send means we're attempting recovery from any previous
      // provider error; clear stale error UI until a new error arrives.
      this.state.lastErrorMessage = undefined;
      this.terminalProviderErrorPending = false;

      const hasPendingUserInput =
        (this.harness.getPendingUserInputRequests?.() ?? []).length > 0;

      if (hasPendingUserInput) {
        // The harness cannot inject a prompt while a question blocks the
        // turn — the message is at best queued (or about to trigger an
        // abort-and-replay that abandons the question, whose drained
        // user_prompt then promotes the phase back to running). Report the
        // blocked state for now instead of claiming active work, so the UI
        // shows the question rather than "Working". (shutting_down already
        // returned above.)
        if (
          this.phase !== 'waiting_for_user_input' &&
          this.phase !== 'stopped'
        ) {
          this.setPhase('waiting_for_user_input');
        }
      } else if (this.phase !== 'running') {
        this.clearTurnSettlementState();
        this.setPhase('running');
      }
    }

    return success;
  }

  answerUserInputRequest(options: {
    requestId: string;
    answers: AcpRequestUserInputAnswers;
    userId?: string;
  }): boolean {
    return this.sendHarnessCommand({
      commandName: HarnessCommand.AnswerUserInputRequest,
      data: {
        requestId: options.requestId,
        answers: options.answers,
        ...(options.userId ? { userId: options.userId } : {}),
      },
    });
  }

  deleteQueuedMessage(id: string): boolean {
    return this.sendHarnessCommand({
      commandName: HarnessCommand.DeleteQueuedMessage,
      data: { id },
    });
  }

  prioritizeQueuedMessage(id: string): boolean {
    return this.sendHarnessCommand({
      commandName: HarnessCommand.PrioritizeQueuedMessage,
      data: { id },
    });
  }

  /**
   * Prioritize a queued follow-up and interrupt the current turn so the
   * promoted message becomes the next runtime turn without transitioning the
   * parent task into the user-visible stopped/idle state.
   */
  steerQueuedMessage(id: string): boolean {
    const canNativeSteerQueuedMessage =
      this.supportsNativeTurnSteering &&
      this.harness.isConnected &&
      (isActiveTaskPhase(this.phase) || this.phase === 'waiting_for_prompt');

    // Native steering can still interrupt delegated/subagent work after the
    // parent task settles back to waiting_for_prompt, but it must not wake a
    // disconnected or shutting-down task back up.
    if (canNativeSteerQueuedMessage) {
      const queuedMessage = this.harness
        .getQueuedMessageSnapshots?.()
        ?.find((message) => message.id === id && !message.queueOnly);

      if (!queuedMessage) {
        return false;
      }

      this.clearTurnSettlementState();

      if (this.phase !== 'running') {
        this.setPhase('running');
      }

      const deleted = this.deleteQueuedMessage(id);

      if (!deleted) {
        return false;
      }

      return this.sendFollowUpPrompt({
        prompt: queuedMessage.text,
        images: queuedMessage.images,
        workflowPhase: queuedMessage.workflowPhase,
        autoSteerWhenQueued: true,
        visibleInTranscript: queuedMessage.visibleInTranscript,
        userId: queuedMessage.userId,
        userName: queuedMessage.userName,
        userImageUrl: queuedMessage.userImageUrl,
        clientMessageId: queuedMessage.clientMessageId,
        goalContext: queuedMessage.goalContext,
      });
    }

    const prioritized = this.prioritizeQueuedMessage(id);

    if (!prioritized) {
      return false;
    }

    if (this.phase === 'running' || this.phase === 'waiting_for_user_input') {
      // Steering swaps the active turn for queued work inside the same task.
      // Unlike a user-initiated cancel, it should stay live/running.
      this.clearTurnSettlementState();

      if (this.phase !== 'running') {
        this.setPhase('running');
      }

      this.sendHarnessCommand({ commandName: HarnessCommand.CancelTask });
    }

    return true;
  }

  reorderQueuedMessage(
    id: string,
    targetId: string,
    position: 'before' | 'after',
  ): boolean {
    return this.sendHarnessCommand({
      commandName: HarnessCommand.ReorderQueuedMessage,
      data: { id, targetId, position },
    });
  }

  /**
   * Record user activity (e.g. preview navigation) to extend the keepalive
   * timer without sending a prompt. Only effective while in
   * `waiting_for_prompt` phase.
   */
  touchKeepalive(): void {
    this.state.lastActivityAt = Date.now();

    if (this.phase === 'waiting_for_prompt') {
      this.scheduleKeepaliveShutdown();
      this.emit('stateChange', this.phase, this.state);
    }
  }

  getQueuedDeliverableMessageCount(): number {
    return this.runtimeQueuedMessagesCount;
  }

  startNewTask(options: {
    prompt: string;
    images?: string[];
    workflowPhase?: string;
    visibleInTranscript?: boolean;
    goalContext?: TaskGoal;
  }): void {
    this.logger.info('[HarnessManager#startNewTask] Starting new task');
    this.executeStartNewTask(options);
  }

  /**
   * Initialize the HarnessManager with a configuration but without starting a task.
   * Used for Session jobs.
   */
  initializeWithoutPrompt(): void {
    // Seed a stable idle anchor for brand-new sessions so the initial keepalive
    // window counts down instead of resetting on every getSleepAt() call.
    if (
      !this.state.lastMessageAt &&
      !this.state.lastActivityAt &&
      !this.state.taskFinishedAt &&
      !this.state.taskAbortedAt
    ) {
      this.state.lastActivityAt = Date.now();
    }

    this.setPhase('waiting_for_prompt');
  }

  /**
   * Start a new task, reusing the stored base configuration.
   * Returns false if no base configuration is available.
   */
  startNewTaskFromPrompt(options: {
    prompt: string;
    images?: string[];
    workflowPhase?: string;
    visibleInTranscript?: boolean;
    source?: string;
    taskId?: string;
    userId?: string;
    userName?: string;
    userImageUrl?: string;
    clientMessageId?: string;
    goalContext?: TaskGoal;
  }): boolean {
    // If a task is currently running, cancel and close it first.
    if (this.state.sessionId && this.phase === 'running') {
      this.logger.info(
        `[HarnessManager#startNewTaskFromPrompt] Canceling current task ${this.state.sessionId}`,
      );

      this.sendHarnessCommand({ commandName: HarnessCommand.CancelTask });
      this.sendHarnessCommand({ commandName: HarnessCommand.CloseTask });
    }

    this.executeStartNewTask(options);

    return true;
  }

  /**
   * Resume a task from a snapshot (used by the worker for SnapshotResume runs).
   */
  resumeTask(harnessSessionId: string): void {
    this.resetState();

    this.state.sessionId = harnessSessionId;

    // Snapshot resumes restore a prompt-ready parent task. If the resumed
    // session starts doing work immediately, parent activity will promote it
    // back to running.
    this.setPhase('waiting_for_prompt');

    this.logger.info(
      `[HarnessManager] Resuming task ${harnessSessionId} from snapshot`,
    );
  }

  /**
   * Resume a stopped task using implicit runtime semantics.
   */
  resumeCurrentTask(): boolean {
    if (this.phase !== 'stopped') {
      this.logger.warn(
        `[HarnessManager#resumeCurrentTask] Phase is ${this.phase}, expected 'stopped'`,
      );

      return false;
    }

    if (!this.state.sessionId) {
      this.logger.warn(
        '[HarnessManager#resumeCurrentTask] No sessionId stored',
      );

      return false;
    }

    this.logger.info(
      `[HarnessManager] Resuming stopped task ${this.state.sessionId}`,
    );

    // Reset completion timestamps so the task is considered active again.
    this.state.taskFinishedAt = undefined;
    this.state.taskAbortedAt = undefined;
    this.state.cancelTriggeredAt = undefined;
    this.state.lastErrorMessage = undefined;
    this.terminalProviderErrorPending = false;
    this.completionDecisionPending = false;
    this.continuationStartPending = false;
    this.fallbackCompletionSequence = 0;
    this.pendingCompletionId = null;

    // Keep stopped-task resume as an inert handoff until the caller sends or
    // resumes work explicitly.
    this.setPhase('idle');

    return true;
  }

  /**
   * Cancel the current task. Soft cancel keeps the sandbox in a resumable
   * stopped state. Pass `terminate: true` for provider Cancel buttons so the
   * sandbox shuts down and the run can finalize as canceled.
   * Pass `cancelledBy` only for explicit user stops — it makes the harness
   * leave a visible `task_cancelled` marker in the transcript.
   */
  cancelTask(options?: {
    cancelledBy?: CancelTaskAttribution;
    terminate?: boolean;
  }): void {
    const canCancelRunningTask = this.phase === 'running';
    const canCancelUserInputTask = this.phase === 'waiting_for_user_input';

    const canCancelResumingTask =
      Boolean(this.state.sessionId) &&
      ((this.phase === 'idle' && !this.state.taskFinishedAt) ||
        (this.phase === 'waiting_for_prompt' &&
          !this.state.taskFinishedAt &&
          !this.state.taskAbortedAt));

    if (
      !canCancelRunningTask &&
      !canCancelUserInputTask &&
      !canCancelResumingTask
    ) {
      this.logger.warn('[HarnessManager#cancelTask] No active task');

      // Terminal cancel still tears the sandbox down even if the turn already
      // settled — provider Cancel should never leave a live machine behind.
      if (options?.terminate && this.phase !== 'shutting_down') {
        this.state.cancelTriggeredAt =
          this.state.cancelTriggeredAt ?? Date.now();
        this.state.taskAbortedAt = this.state.taskAbortedAt ?? Date.now();
        this.triggerShutdown();
      }

      return;
    }

    if (this.state.sessionId) {
      this.logger.info(
        `[HarnessManager#cancelTask] Canceling task ${this.state.sessionId}${options?.terminate ? ' (terminal)' : ''}`,
      );
    } else {
      this.logger.info(
        `[HarnessManager#cancelTask] Canceling active task (taskId not known yet)${options?.terminate ? ' (terminal)' : ''}`,
      );
    }

    this.state.cancelTriggeredAt = Date.now();
    this.setPhase('stopped');

    this.sendHarnessCommand({
      commandName: HarnessCommand.CancelTask,
      ...(options?.cancelledBy
        ? { data: { cancelledBy: options.cancelledBy } }
        : {}),
    });

    if (options?.terminate) {
      // Stamp abort so finalization maps to Canceled even if the harness
      // abort event races with process teardown.
      this.state.taskAbortedAt = this.state.taskAbortedAt ?? Date.now();
      this.triggerShutdown();
    }
  }

  /**
   * Cancel the current turn and wait until the cancellation has fully settled
   * before returning.
   */
  async cancelTaskAndWaitForTurnExit(options?: {
    timeoutMs?: number;
  }): Promise<boolean> {
    const timeoutMs = options?.timeoutMs ?? 15_000;

    const previousCancelTriggeredAt = this.state.cancelTriggeredAt;
    this.cancelTask();

    const cancelTriggeredAt = this.state.cancelTriggeredAt;

    if (!cancelTriggeredAt || cancelTriggeredAt === previousCancelTriggeredAt) {
      return false;
    }

    const turnAlreadySettled =
      Math.max(this.state.taskAbortedAt ?? 0, this.state.taskFinishedAt ?? 0) >=
      cancelTriggeredAt;

    if (turnAlreadySettled) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return true;
    }

    return await new Promise<boolean>((resolve) => {
      const handleTaskStateEvent = (eventName: TaskStateEvent) => {
        if (
          eventName !== HarnessEvent.TaskAborted &&
          eventName !== HarnessEvent.TaskCompleted
        ) {
          return;
        }

        const settledAt = Math.max(
          this.state.taskAbortedAt ?? 0,
          this.state.taskFinishedAt ?? 0,
        );

        if (settledAt < cancelTriggeredAt) {
          return;
        }

        cleanup();
        setImmediate(() => resolve(true));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.off('taskStateEvent', handleTaskStateEvent);
      };

      const timeout = setTimeout(() => {
        cleanup();

        this.logger.warn(
          `[HarnessManager#cancelTaskAndWaitForTurnExit] Timed out waiting for turn exit after ${timeoutMs}ms`,
        );

        resolve(false);
      }, timeoutMs);

      this.on('taskStateEvent', handleTaskStateEvent);
    });
  }

  /**
   * Get the current task status for tRPC queries.
   */
  getStatus(): {
    phase: TaskPhase;
    taskStateEvent: TaskStateEvent | null;
    sessionId: string | undefined;
    isConnected: boolean;
    sleepRemainingMs: number | null;
    lastErrorMessage: string | undefined;
  } {
    const sleepAt = this.getSleepAt();

    return {
      phase: this.phase,
      taskStateEvent: this.getVisibleTaskStateEvent(),
      sessionId: this.state.sessionId,
      isConnected: this.harness.isConnected,
      sleepRemainingMs:
        sleepAt == null ? null : Math.max(0, sleepAt - Date.now()),
      lastErrorMessage: this.state.lastErrorMessage,
    };
  }

  /**
   * Compute the authoritative auto-sleep deadline.
   * This is the single deadline that should drive both the UI countdown and
   * BullMQ auto-snapshot eligibility.
   */
  getSleepAt(): number | null {
    if (this.phase === 'stopped') {
      return null;
    }

    // Terminal cancel must not publish a due sleep deadline. That would turn a
    // deliberate stop into a resumable snapshot/standby handoff.
    if (this.state.cancelTriggeredAt) {
      return null;
    }

    // Failures without a usable runtime session still need terminal
    // finalization. A provider error from an existing session is a failed turn
    // instead, so it remains eligible for the ordinary idle retention path.
    if (
      this.phase === 'shutting_down' &&
      this.state.lastErrorMessage &&
      !this.state.taskFinishedAt &&
      !this.terminalProviderErrorPending
    ) {
      return null;
    }

    if (this.phase === 'shutting_down' || this.state.clientDisconnectedAt) {
      return Date.now();
    }

    const hardSleepAt = this.getHardSleepAt();

    if (isActiveTaskPhase(this.phase)) {
      const activeSleepWindowMs = Math.max(
        this.keepaliveMs,
        MIN_ACTIVE_SLEEP_WINDOW_MS,
      );

      return Math.min(Date.now() + activeSleepWindowMs, hardSleepAt);
    }

    if (
      this.phase === 'waiting_for_prompt' ||
      this.state.taskFinishedAt ||
      this.state.taskAbortedAt
    ) {
      const anchor =
        Math.max(
          this.state.lastMessageAt ?? 0,
          this.state.lastActivityAt ?? 0,
          this.state.taskFinishedAt ?? 0,
          this.state.taskAbortedAt ?? 0,
        ) || Date.now();

      const idleSleepAt = anchor + this.keepaliveMs;

      return Math.min(idleSleepAt, hardSleepAt);
    }

    return hardSleepAt;
  }

  /**
   * Compute how many ms remain before the sandbox auto-sleeps.
   * Returns null when the current state should not auto-sleep (for example
   * while a task is actively running or explicitly stopped).
   */
  getKeepaliveRemainingMs(): number | null {
    if (isActiveTaskPhase(this.phase)) {
      return null;
    }

    const sleepAt = this.getSleepAt();

    if (sleepAt == null) {
      return null;
    }

    return Math.max(0, sleepAt - Date.now());
  }

  /**
   * Get a snapshot of the current task state.
   */
  getState(): Readonly<TaskState> {
    return { ...this.state };
  }

  /**
   * Returns a promise that resolves when the container should shut down.
   * This replaces the worker's waitForCompletion().
   */
  waitForShutdown(): Promise<TaskState> {
    return this.shutdownPromise;
  }

  /**
   * Clean up timers and listeners.
   */
  dispose(): void {
    this.clearKeepaliveTimer();
    this.clearSleepHeartbeatTimer();
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    this.unsubscribeRuntimeOutput?.();
    this.unsubscribeRuntimeOutput = null;
    this.unsubscribeCommandError?.();
    this.unsubscribeCommandError = null;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private createFreshState(): TaskState {
    return createInitialTaskState();
  }

  private resetState(): void {
    const fresh = this.createFreshState();
    Object.assign(this.state, fresh);
    this.lastTaskStateEvent = null;
    this.runtimeQueuedMessagesCount = 0;
    this.deferredTurnSettlement = null;
    this.terminalProviderErrorPending = false;
  }

  private clearTurnSettlementState(): void {
    this.state.taskFinishedAt = undefined;
    this.state.taskAbortedAt = undefined;
    this.state.cancelTriggeredAt = undefined;
    this.terminalProviderErrorPending = false;
  }

  private invokeOnStart(taskId: string): void {
    const result = this.callbacks.onStart?.(taskId);

    if (!result) {
      return;
    }

    void result.catch((error) => {
      this.logger.warn(
        `[HarnessManager] onStart callback failed: ${formatCallbackError(error)}`,
      );
    });
  }

  private invokeOnExit(): void {
    const result = this.callbacks.onExit?.();

    if (!result) {
      return;
    }

    void result.catch((error) => {
      this.logger.warn(
        `[HarnessManager] onExit callback failed: ${formatCallbackError(error)}`,
      );
    });
  }

  private invokeOnTaskUpdate(update: {
    taskId?: string;
    status?: string;
  }): void {
    const result = this.callbacks.onTaskUpdate?.(update);

    if (!result) {
      return;
    }

    void result.catch((error) => {
      this.logger.warn(
        `[HarnessManager] onTaskUpdate callback failed: ${formatCallbackError(error)}`,
      );
    });
  }

  private finalizeTaskCompletionNow(): void {
    this.deferredTurnSettlement = null;
    this.state.taskFinishedAt = Date.now();

    if (this.phase === 'running') {
      this.setPhase('waiting_for_prompt');
    }

    this.invokeOnExit();
    this.invokeOnTaskUpdate({ status: 'completed' });
  }

  private finalizeTaskCompletion(): void {
    const decide = this.callbacks.onBeforeTaskCompletion;
    if (!decide) {
      this.finalizeTaskCompletionNow();
      return;
    }
    if (this.completionDecisionPending || this.continuationStartPending) {
      return;
    }

    this.completionDecisionPending = true;
    const decisionSequence = ++this.completionDecisionSequence;
    const sessionId = this.state.sessionId;
    const completionId =
      this.pendingCompletionId ??
      `${sessionId ?? 'unknown'}:fallback:${++this.fallbackCompletionSequence}`;
    void decide(completionId)
      .then(async (disposition) => {
        if (decisionSequence !== this.completionDecisionSequence) {
          if (typeof disposition === 'object') {
            try {
              await disposition.onRejected?.();
            } catch (error) {
              this.logger.warn(
                `[HarnessManager] Stale continuation cleanup failed: ${formatCallbackError(error)}`,
              );
            }
          }
          return;
        }
        this.completionDecisionPending = false;
        if (
          this.state.sessionId !== sessionId ||
          this.phase === 'shutting_down' ||
          this.phase === 'stopped' ||
          this.state.cancelTriggeredAt
        ) {
          return;
        }
        if (typeof disposition === 'object') {
          this.continuationStartPending = true;
          this.clearTurnSettlementState();
          if (this.phase !== 'running') {
            this.setPhase('running');
          }

          const sent = this.sendFollowUpPrompt(disposition.prompt);
          if (sent) {
            try {
              disposition.onAccepted?.();
            } catch (error) {
              this.logger.warn(
                `[HarnessManager] Continuation acceptance callback failed: ${formatCallbackError(error)}`,
              );
            }
            return;
          }

          try {
            await disposition.onRejected?.();
          } catch (error) {
            this.logger.warn(
              `[HarnessManager] Continuation rejection callback failed: ${formatCallbackError(error)}`,
            );
          }
          this.continuationStartPending = false;
          if (
            this.state.sessionId === sessionId &&
            !isStoppingPhase(this.phase) &&
            !this.state.cancelTriggeredAt
          ) {
            this.finalizeTaskCompletionNow();
          }
          return;
        }
        if (disposition === 'ignore') {
          return;
        }
        this.finalizeTaskCompletionNow();
      })
      .catch((error) => {
        if (decisionSequence !== this.completionDecisionSequence) {
          this.logger.warn(
            `[HarnessManager] Stale pre-completion decision failed: ${formatCallbackError(error)}`,
          );
          return;
        }
        this.completionDecisionPending = false;
        this.continuationStartPending = false;
        this.logger.warn(
          `[HarnessManager] Pre-completion decision failed: ${formatCallbackError(error)}`,
        );
        if (this.phase !== 'shutting_down' && this.phase !== 'stopped') {
          this.finalizeTaskCompletionNow();
        }
      });
  }

  private setPhase(phase: TaskPhase): void {
    if (this.phase === phase) {
      return;
    }

    this.logger.info(`[HarnessManager] Phase: ${this.phase} -> ${phase}`);

    this.phase = phase;
    this.emit('stateChange', phase, this.state);
    this.syncSleepHeartbeat();

    if (phase === 'waiting_for_prompt') {
      this.scheduleKeepaliveShutdown();
    } else {
      this.clearKeepaliveTimer();
    }
  }

  private getVisibleTaskStateEvent(): TaskStateEvent | null {
    if (
      isActiveTaskPhase(this.phase) &&
      (this.lastTaskStateEvent === HarnessEvent.TaskCompleted ||
        this.lastTaskStateEvent === HarnessEvent.TaskAborted)
    ) {
      return null;
    }

    return this.lastTaskStateEvent;
  }

  // Abort finalization only transitions the phase — it does not invoke
  // onExit / onTaskUpdate callbacks because the runtime session is still alive
  // and may resume with queued follow-up work.  Compare with
  // finalizeTaskCompletion() which fires both callbacks.
  private finalizeTaskAbort(): void {
    this.deferredTurnSettlement = null;

    if (this.phase !== 'stopped') {
      this.setPhase(
        this.state.cancelTriggeredAt ? 'stopped' : 'waiting_for_prompt',
      );
    }
  }

  private handleDeferredQueuedTurnSettlement(options: {
    queuedMessagesCount: number;
    sessionId: string | undefined;
    updateCause: string | undefined;
  }): boolean {
    const { queuedMessagesCount, sessionId, updateCause } = options;
    const pendingSettlement = this.deferredTurnSettlement;
    const sessionLabel = sessionId ?? 'unknown';

    if (!pendingSettlement) {
      return false;
    }

    const settlementLabel =
      pendingSettlement === HarnessEvent.TaskCompleted ? 'completion' : 'abort';

    if (updateCause === 'dequeue') {
      // A queued follow-up is starting — absorb the deferred settlement so
      // the new turn runs cleanly.  Returns false (not "fully handled") so
      // the caller continues with normal queue-update processing.
      this.logger.info(
        `[HarnessManager] Deferred ${settlementLabel} for task ${sessionLabel} absorbed by a queued runtime follow-up starting`,
      );
      this.deferredTurnSettlement = null;

      if (pendingSettlement === HarnessEvent.TaskAborted) {
        this.clearTurnSettlementState();
      }

      return false;
    }

    if (
      queuedMessagesCount === 0 &&
      (updateCause === 'clear' || updateCause === 'delete')
    ) {
      this.logger.info(
        `[HarnessManager] Finalizing deferred ${settlementLabel} for task ${sessionLabel} after queued runtime prompts were ${updateCause === 'clear' ? 'cleared' : 'deleted'}`,
      );

      if (pendingSettlement === HarnessEvent.TaskCompleted) {
        this.finalizeTaskCompletion();
      } else {
        this.finalizeTaskAbort();
      }

      return true;
    }

    return false;
  }

  private attachHandlers(): void {
    this.unsubscribeEvents = this.harness.subscribe((taskEvent) => {
      this.handleTaskEvent(taskEvent);
    });

    this.unsubscribeRuntimeOutput = this.harness.subscribeRuntimeOutput(
      (event) => {
        this.handleRuntimeOutput(event);
      },
    );

    this.unsubscribeCommandError =
      this.harness.subscribeCommandError?.(({ command, error }) => {
        this.handleCommandError(command.commandName, error);
      }) ?? null;

    this.harness.on('connected', () => {
      if (this.state.clientDisconnectedAt) {
        this.logger.info(
          `[HarnessManager] Harness reconnected (phase=${this.phase}, sessionId=${this.state.sessionId})`,
        );
      }

      this.state.clientDisconnectedAt = undefined;

      if (this.state.lastErrorMessage === UNEXPECTED_DISCONNECT_ERROR) {
        this.state.lastErrorMessage = undefined;
      }

      this.emit('stateChange', this.phase, this.state);
    });

    this.harness.on('disconnected', () => {
      this.logger.info(
        `[HarnessManager] Harness disconnected (phase=${this.phase}, sessionId=${this.state.sessionId})`,
      );

      this.state.clientDisconnectedAt = Date.now();

      if (
        !this.state.taskFinishedAt &&
        !this.state.taskAbortedAt &&
        !this.state.cancelTriggeredAt &&
        !this.state.lastErrorMessage
      ) {
        this.state.lastErrorMessage = UNEXPECTED_DISCONNECT_ERROR;
      }

      this.emit('stateChange', this.phase, this.state);

      // ReconnectableHarness absorbs inner disconnects until reconnect retries fail.
      if (this.phase !== 'shutting_down') {
        captureWorkerMessage(
          'Harness exhausted reconnect attempts and is shutting down the sandbox runtime',
          {
            runId: this.runId,
            taskId: this.taskId,
            stage: 'harness-manager.disconnected',
            taskPhase: this.phase,
            runtimeTaskId: this.state.sessionId,
            keepaliveMs: this.keepaliveMs,
            sandboxTimeoutMs: this.sandboxTimeoutMs,
            sandboxExpiresAtMs: this.sandboxExpiresAtMs,
            cancelTriggeredAt: this.state.cancelTriggeredAt,
            lastMessageAt: this.state.lastMessageAt,
            taskFinishedAt: this.state.taskFinishedAt,
            taskAbortedAt: this.state.taskAbortedAt,
            clientDisconnectedAt: this.state.clientDisconnectedAt,
            lastErrorMessage: this.state.lastErrorMessage,
          },
          {
            component: 'harness-manager',
            level: 'error',
            signal: 'harness-reconnect-exhausted',
          },
        );
        this.triggerShutdown();
      }
    });
  }

  private handleRuntimeOutput(event: AcpMessage): void {
    const sessionId =
      event.metadata &&
      typeof event.metadata === 'object' &&
      'sessionId' in event.metadata
        ? (event.metadata.sessionId as string)
        : (event.payload?.sessionId as string | undefined);

    if (sessionId !== this.state.sessionId) {
      return;
    }

    if (event.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt) {
      if (this.completionDecisionPending) {
        this.completionDecisionPending = false;
        this.completionDecisionSequence += 1;
      }
      this.continuationStartPending = false;
      // A user prompt entering the session means a turn is starting — a
      // drained queue follow-up, a steered replay, or a question answer.
      // Those paths do not go through startNewTask/sendFollowUpPrompt, so
      // without this the phase stays settled and the UI keeps showing the
      // idle countdown (or a stale question-blocked state) while the agent
      // is actively working. Do not promote past a question that is still
      // genuinely pending for this session — a steered replay abandons the
      // question and clears it, so only a live one blocks promotion.
      const promotableFromPhase =
        this.phase === 'idle' ||
        this.phase === 'waiting_for_prompt' ||
        this.phase === 'waiting_for_user_input';
      const stillPending =
        this.harness
          .getPendingUserInputRequests?.()
          .some((request) => request.sessionId === this.state.sessionId) ??
        false;

      if (promotableFromPhase && !stillPending) {
        this.clearTurnSettlementState();
        this.setPhase('running');
      }
      return;
    }

    if (event.eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInput) {
      if (this.phase !== 'stopped') {
        this.setPhase('waiting_for_user_input');
      }
      return;
    }

    if (event.eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse) {
      const stillPending =
        this.harness
          .getPendingUserInputRequests?.()
          .some((request) => request.sessionId === this.state.sessionId) ??
        false;

      if (!stillPending && this.phase === 'waiting_for_user_input') {
        this.setPhase('running');
      }

      return;
    }

    if (event.role === 'assistant') {
      const hasTextContent = event.contentBlocks.some(
        (block) =>
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.trim().length > 0,
      );

      if (hasTextContent) {
        this.state.lastMessageAt = Date.now();

        if (
          this.phase === 'waiting_for_prompt' &&
          event.eventType !== ACP_ENVELOPE_EVENT_TYPES.QueuedMessagesUpdate
        ) {
          this.scheduleKeepaliveShutdown();
          this.emit('stateChange', this.phase, this.state);
        }
      }
    }

    if (event.eventType !== ACP_ENVELOPE_EVENT_TYPES.QueuedMessagesUpdate) {
      return;
    }

    const queuedMessages = Array.isArray(event.payload?.queuedMessages)
      ? event.payload.queuedMessages
      : [];
    const updateCause =
      event.payload &&
      typeof event.payload === 'object' &&
      'cause' in event.payload &&
      typeof event.payload.cause === 'string'
        ? event.payload.cause
        : undefined;

    const payloadDeliverableCount =
      event.payload &&
      typeof event.payload === 'object' &&
      'deliverableCount' in event.payload &&
      typeof event.payload.deliverableCount === 'number'
        ? event.payload.deliverableCount
        : undefined;

    const deliverableQueuedMessagesCount =
      payloadDeliverableCount ?? countDeliverableQueuedMessages(queuedMessages);

    this.runtimeQueuedMessagesCount = deliverableQueuedMessagesCount;

    if (
      this.handleDeferredQueuedTurnSettlement({
        queuedMessagesCount: deliverableQueuedMessagesCount,
        sessionId,
        updateCause,
      })
    ) {
      return;
    }

    if (this.phase === 'waiting_for_prompt') {
      this.scheduleKeepaliveShutdown();
    }

    this.emit('stateChange', this.phase, this.state);
  }

  private handleTaskEvent(taskEvent: TaskEvent): void {
    const { eventName, payload } = taskEvent;

    switch (eventName) {
      case HarnessEvent.Message:
        this.onMessage((taskEvent as MessageTaskEvent).payload);
        break;

      case HarnessEvent.TaskStarted:
        this.onTaskStarted((taskEvent as TaskStartedEvent).payload);
        break;

      case HarnessEvent.TaskAborted:
        this.onTaskAborted((taskEvent as TaskAbortedEvent).payload);
        break;

      case HarnessEvent.TaskCompleted:
        this.onTaskCompleted((taskEvent as TaskCompletedEvent).payload);
        break;
    }

    // Promote idle → running when we see activity for the resumed task.
    if (eventName === HarnessEvent.TaskStarted && payload?.[0]) {
      this.promoteIdleIfActive(payload[0] as string);
    } else if (eventName === HarnessEvent.Message && payload?.[0]) {
      const { taskId } = payload[0] as { taskId?: string };
      if (taskId) {
        this.promoteIdleIfActive(taskId);
      }
    }

    // Emit task state events so subscribers can track the granular state
    // (active, idle, interactive, etc.).
    if (
      TASK_STATE_EVENTS.has(eventName as TaskStateEvent) &&
      payload &&
      this.state.sessionId
    ) {
      const taskId = payload[0];
      const isParent = taskId === this.state.sessionId;

      this.logger.info(
        `[HarnessManager] TaskStateEvent: ${eventName} (taskId=${taskId}, isParent=${isParent})`,
      );

      // Preserve the deferred abort event even if the runtime sends a
      // trailing completion while queued follow-up work is pending.
      const tracked =
        eventName === HarnessEvent.TaskCompleted &&
        this.deferredTurnSettlement === HarnessEvent.TaskAborted
          ? HarnessEvent.TaskAborted
          : (eventName as TaskStateEvent);
      this.lastTaskStateEvent = tracked;
      this.emit('taskStateEvent', this.lastTaskStateEvent);
    }
  }

  private onMessage(payload: TaskEventMessagePayload): void {
    const { message } = payload[0];
    const isPartial = message.partial === true;

    if (!isPartial) {
      if (ERROR_SAY_TYPES.has(message.say ?? '')) {
        this.state.lastErrorMessage =
          message.text || message.say || 'Unknown error';
        if (message.say === TERMINAL_PROVIDER_ERROR_SAY) {
          this.terminalProviderErrorPending = true;
        }

        this.logger.warn(`[HarnessManager] provider error '${message.say}'`);
      }
    }

    this.state.lastMessageAt = Date.now();
  }

  /**
   * Fail closed on async StartNewTask failures (e.g. OpenCode session create
   * timeout). TaskAborted is intentionally not used for the plain failure
   * path: it is resumable and resolveStatus maps it to Canceled. Terminal
   * Failed is lastErrorMessage without abort/finish stamps, then immediate
   * shutdown.
   *
   * If the user already canceled before a session existed, CancelTask is
   * effectively a no-op and leaves phase `stopped` with getSleepAt() null —
   * do not silent-ignore the later StartNewTask settle; still shut down so
   * the sandbox cannot linger forever.
   */
  private handleCommandError(commandName: string, error: unknown): void {
    if (commandName !== HarnessCommand.StartNewTask) {
      this.logger.error(
        `[HarnessManager] Background command failed command=${commandName} error=${formatCallbackError(error)}`,
      );
      return;
    }

    if (this.phase === 'shutting_down') {
      return;
    }

    const message = formatCallbackError(error);

    if (this.state.cancelTriggeredAt) {
      if (!this.state.taskAbortedAt) {
        // Preserve cancel semantics for resolveStatus while closing the
        // session-create race where CancelTask had nothing to abort yet.
        this.state.taskAbortedAt = this.state.cancelTriggeredAt;
      }
      this.logger.info(
        `[HarnessManager] StartNewTask failed after cancel; completing canceled shutdown error=${message}`,
      );
      this.emit('stateChange', this.phase, this.state);
      this.triggerShutdown();
      return;
    }

    this.state.lastErrorMessage = message;
    this.logger.error(
      `[HarnessManager] StartNewTask failed; shutting down terminally error=${message}`,
    );
    this.emit('stateChange', this.phase, this.state);
    this.triggerShutdown();
  }

  private onTaskStarted(payload: TaskEventStartedPayload): void {
    const taskId = payload[0];

    if (!taskId) {
      return;
    }

    if (taskId === this.state.sessionId) {
      this.continuationStartPending = false;
    }

    if (!this.state.sessionId) {
      this.state.sessionId = taskId;
      this.invokeOnStart(taskId);
      this.invokeOnTaskUpdate({ taskId });
      // Emit stateChange so polling state gets the sessionId.
      // setPhase('running') may have already been called by startNewTask(),
      // which means the phase-change in handleTaskEvent won't fire again.
      this.emit('stateChange', this.phase, this.state);
      return;
    }

    if (this.state.sessionId !== taskId) {
      // Subtasks are not supported in Roomote harnesses. If we receive a
      // different task ID, reconcile to the runtime task ID so lifecycle
      // tracking remains consistent.
      this.logger.warn(
        `[HarnessManager] Reconciled task ID from ${this.state.sessionId} to ${taskId}`,
      );
      this.state.sessionId = taskId;
      this.invokeOnStart(taskId);
      this.invokeOnTaskUpdate({ taskId });
      this.emit('stateChange', this.phase, this.state);
      return;
    }

    this.logger.info(`[HarnessManager] Task started: ${taskId}`);
  }

  private onTaskAborted(payload: TaskEventAbortedPayload): void {
    if (payload[0] === this.state.sessionId) {
      this.logger.info(`[HarnessManager] Task aborted: ${payload[0]}`);

      // A terminal provider error ends the current model turn, not the live
      // task session. Keep its error visible and leave the session available
      // for follow-ups until the ordinary idle keepalive expires.
      if (!this.terminalProviderErrorPending || this.state.cancelTriggeredAt) {
        this.state.taskAbortedAt = Date.now();
      }

      if (this.runtimeQueuedMessagesCount > 0) {
        // Abort takes priority: never downgrade a deferred abort to completion.
        this.deferredTurnSettlement = HarnessEvent.TaskAborted;

        if (this.phase !== 'stopped') {
          this.setPhase('running');
        }

        return;
      }

      this.finalizeTaskAbort();
    } else {
      this.logger.warn(
        `[HarnessManager] Ignoring taskAborted for unexpected task ID ${payload[0]}`,
      );
    }
  }

  private onTaskCompleted(payload: TaskEventCompletedPayload): void {
    if (payload[0] === this.state.sessionId) {
      if (this.completionDecisionPending || this.continuationStartPending) {
        this.logger.info(
          `[HarnessManager] Ignoring duplicate task completion while continuation settlement is pending for ${payload[0]}`,
        );
        return;
      }
      this.pendingCompletionId = payload[3]?.completionId ?? null;
      if (
        this.state.taskFinishedAt !== undefined &&
        !isActiveTaskPhase(this.phase)
      ) {
        this.logger.info(
          `[HarnessManager] Ignoring duplicate task completion for settled task ${payload[0]} (phase=${this.phase})`,
        );
        return;
      }

      this.logger.info(
        `[HarnessManager] Task completed: ${payload[0]} (phase=${this.phase}, queuedRuntimePrompts=${this.runtimeQueuedMessagesCount}, deferredSettlement=${this.deferredTurnSettlement ?? 'none'})`,
      );

      if (this.runtimeQueuedMessagesCount > 0) {
        // A deferred abort takes priority — don't overwrite it with a
        // trailing completion, and skip clearing settlement timestamps so
        // the abort state is preserved for finalizeTaskAbort().
        const abortTakesPriority =
          this.deferredTurnSettlement === HarnessEvent.TaskAborted;

        if (abortTakesPriority) {
          this.logger.info(
            `[HarnessManager] Preserving deferred abort for task ${payload[0]} while ${this.runtimeQueuedMessagesCount} queued runtime follow-up(s) remain`,
          );
          return;
        }

        if (this.phase === 'running') {
          this.deferredTurnSettlement = HarnessEvent.TaskCompleted;
          this.clearTurnSettlementState();
          this.logger.info(
            `[HarnessManager] Keeping task ${payload[0]} running while ${this.runtimeQueuedMessagesCount} queued runtime follow-up(s) remain`,
          );
          return;
        }
      }

      this.finalizeTaskCompletion();
    } else {
      this.logger.warn(
        `[HarnessManager] Ignoring taskCompleted for unexpected task ID ${payload[0]}`,
      );
    }
  }

  private executeStartNewTask(options: {
    prompt: string;
    images?: string[];
    workflowPhase?: string;
    visibleInTranscript?: boolean;
    source?: string;
    taskId?: string;
    userId?: string;
    userName?: string;
    userImageUrl?: string;
    clientMessageId?: string;
    goalContext?: TaskGoal;
  }): void {
    this.resetState();
    this.setPhase('running');

    // When a pre-allocated taskId is provided, set it on the state
    // immediately so downstream callers (e.g., recordUserPrompt) can
    // reference it without waiting for the CLI's taskStarted event.
    if (options.taskId) {
      this.state.sessionId = options.taskId;
    }

    this.sendHarnessCommand({
      commandName: HarnessCommand.StartNewTask,
      data: {
        text: options.prompt,
        images: options.images,
        ...(options.workflowPhase
          ? { workflowPhase: options.workflowPhase }
          : {}),
        visibleInTranscript: options.visibleInTranscript,
        ...(options.source ? { source: options.source } : {}),
        userId: options.userId,
        userName: options.userName,
        userImageUrl: options.userImageUrl,
        taskId: options.taskId,
        clientMessageId: options.clientMessageId,
        goalContext: options.goalContext,
      },
    });
  }

  private sendHarnessCommand(command: {
    commandName: string;
    data?: unknown;
  }): boolean {
    return this.harness.sendCommand(
      command as Parameters<Harness['sendCommand']>[0],
    );
  }

  /** Promote restored prompt-ready state to running once the parent is active. */
  private promoteIdleIfActive(taskId: string): void {
    if (
      this.state.sessionId === taskId &&
      (this.phase === 'idle' || this.phase === 'waiting_for_prompt')
    ) {
      this.setPhase('running');
    }
  }

  private getHardSleepAt(): number {
    if (this.sandboxExpiresAtMs !== undefined) {
      return Math.max(
        Date.now(),
        this.sandboxExpiresAtMs - SNAPSHOT_CHECK_THRESHOLD_MS,
      );
    }

    // Keep a buffer before the provider hard timeout so BullMQ has room to
    // capture a snapshot without racing sandbox termination.
    const remainingMs = Math.max(
      0,
      this.sandboxTimeoutMs -
        process.uptime() * 1_000 -
        SNAPSHOT_CHECK_THRESHOLD_MS,
    );

    return Date.now() + remainingMs;
  }

  private syncSleepHeartbeat(): void {
    if (!isActiveTaskPhase(this.phase)) {
      this.clearSleepHeartbeatTimer();
      return;
    }

    if (this.sleepHeartbeatTimer) {
      return;
    }

    this.sleepHeartbeatTimer = setInterval(() => {
      if (!isActiveTaskPhase(this.phase)) {
        this.clearSleepHeartbeatTimer();
        return;
      }

      this.emit('stateChange', this.phase, this.state);
    }, ACTIVE_SLEEP_HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Schedule a keepalive shutdown timer. Called when entering
   * `waiting_for_prompt`. Replaces the old 5-second polling interval
   * with a precise setTimeout.
   */
  private scheduleKeepaliveShutdown(): void {
    this.clearKeepaliveTimer();

    if (this.phase !== 'waiting_for_prompt') {
      return;
    }

    if (this.state.clientDisconnectedAt) {
      this.triggerShutdown();
      return;
    }

    // Runtime follow-ups may already be queued for execution even though the
    // latest turn reported completion; don't start keepalive countdown until
    // the queue drains.
    if (this.runtimeQueuedMessagesCount > 0) {
      this.logger.info(
        `[HarnessManager] Deferring keepalive shutdown: queued runtime prompts=${this.runtimeQueuedMessagesCount}`,
      );
      return;
    }

    const sleepAt = this.getSleepAt();

    if (sleepAt == null) {
      return;
    }

    const remaining = Math.max(0, sleepAt - Date.now());

    this.keepaliveTimer = setTimeout(() => this.triggerShutdown(), remaining);
  }

  private clearKeepaliveTimer(): void {
    if (this.keepaliveTimer) {
      clearTimeout(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private clearSleepHeartbeatTimer(): void {
    if (!this.sleepHeartbeatTimer) {
      return;
    }

    clearInterval(this.sleepHeartbeatTimer);
    this.sleepHeartbeatTimer = null;
  }

  private triggerShutdown(): void {
    this.clearKeepaliveTimer();
    this.clearSleepHeartbeatTimer();
    this.logger.info('[HarnessManager] Ready for shutdown');
    this.setPhase('shutting_down');
    this.emit('shutdown', this.state);
    this.shutdownResolve?.(this.state);
  }
}
