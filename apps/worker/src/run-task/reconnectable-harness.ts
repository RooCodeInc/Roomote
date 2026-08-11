import EventEmitter from 'node:events';

import type { ResultPromise } from 'execa';

import {
  ACP_ENVELOPE_EVENT_TYPES,
  AcpMessage,
  AcpPersistedEnvelope,
  AcpTurnCompletedEvent,
  TaskEvent,
  asRecord,
  asString,
  getRequestedDeploymentEnvVarNamesFromToolPayload,
  isEnvVarRequestFulfillmentClientMessageId,
} from '@roomote/types';

import type { Harness } from '../sandbox-server';
import { markExpectedSubprocessExitIfAlive } from '../sandbox-server/lib/harnesses/opencode-server/expected-exit';
import type { DiagnosticEventRecorder } from './diagnostic-events';
import type {
  HarnessEvents,
  HarnessInferenceUsageEvent,
  HarnessPendingEnvVarRequest,
  HarnessPendingUserInputRequest,
  HarnessRestartRequest,
  HarnessQueuedMessage,
  HarnessCommandError,
  QueuedPromptMessageSnapshot,
  TaskCommand,
} from '../sandbox-server/lib/harness';
import {
  cloneQueuedPromptMessageSnapshot,
  extractQueuedMessageId,
  extractQueuedMessageMove,
} from '../sandbox-server/lib/harness';
import type { HarnessLogger } from '../logging';

interface SpawnHarnessResult {
  harness: Harness;
  subprocess: ResultPromise;
}

interface ReconnectableHarnessConfig {
  logger: HarnessLogger;
  spawnHarness: (options?: {
    initialSessionId?: string;
  }) => Promise<SpawnHarnessResult>;
  maxReconnectAttempts?: number;
  /** Durable breadcrumbs for harness lifecycle transitions; observer-only. */
  diagnosticEvents?: DiagnosticEventRecorder;
}

interface BoundHarnessListeners {
  taskEvent: (event: TaskEvent) => void;
  connected: () => void;
  disconnected: () => void;
  restartRequested: (request: HarnessRestartRequest) => void;
  runtimeOutput: (event: AcpMessage) => void;
  runtimePersistedEnvelope: (envelope: AcpPersistedEnvelope) => void;
  runtimeTurnCompleted: (event: AcpTurnCompletedEvent) => void;
  runtimeInferenceUsage: (event: HarnessInferenceUsageEvent) => void;
  commandError: (error: HarnessCommandError) => void;
  commandErrorUnsubscribe?: () => void;
}

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 7;
const RECONNECT_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function eventSessionId(event: {
  metadata?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
  sessionId?: string | null;
}): string | undefined {
  return (
    event.sessionId ??
    (typeof event.metadata?.sessionId === 'string'
      ? event.metadata.sessionId
      : undefined) ??
    (typeof event.payload?.sessionId === 'string'
      ? event.payload.sessionId
      : undefined)
  );
}

function isReplayableReconnectCommand(command: TaskCommand): boolean {
  return (
    command.commandName === 'StartNewTask' ||
    command.commandName === 'SendMessage' ||
    command.commandName === 'ResumeTask' ||
    command.commandName === 'AnswerUserInputRequest' ||
    command.commandName === 'DeleteQueuedMessage' ||
    command.commandName === 'PrioritizeQueuedMessage' ||
    command.commandName === 'ReorderQueuedMessage'
  );
}

function cloneQueuedPromptMessageSnapshots(
  queuedMessages: QueuedPromptMessageSnapshot[],
): QueuedPromptMessageSnapshot[] {
  return queuedMessages.map(cloneQueuedPromptMessageSnapshot);
}

function cloneTaskCommandForReplay(command: TaskCommand): TaskCommand {
  return structuredClone(command);
}

export class ReconnectableHarness
  extends EventEmitter<HarnessEvents>
  implements Harness
{
  private readonly logger: HarnessLogger;
  private readonly spawnHarness: ReconnectableHarnessConfig['spawnHarness'];
  private readonly maxReconnectAttempts: number;
  private readonly diagnosticEvents: DiagnosticEventRecorder | undefined;

  private currentHarness: Harness | null = null;
  private currentSubprocess: ResultPromise | null = null;
  private currentListeners: BoundHarnessListeners | null = null;

  private reconnectPromise: Promise<void> | null = null;
  private readonly queuedCommands: TaskCommand[] = [];
  private disposed = false;
  private latestSessionId: string | undefined;
  private currentCommandEnv: Record<string, string> | undefined;
  private flushingQueuedCommands = false;
  private reconnectQueuedMessages: QueuedPromptMessageSnapshot[] | undefined;
  private cachedSupportsNativeTurnSteering = false;
  private pendingEnvVarRequest: HarnessPendingEnvVarRequest | null = null;

  constructor(config: ReconnectableHarnessConfig) {
    super();
    this.logger = config.logger;
    this.spawnHarness = config.spawnHarness;
    this.maxReconnectAttempts =
      config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.diagnosticEvents = config.diagnosticEvents;
  }

  async start(options?: { initialSessionId?: string }): Promise<void> {
    this.updateSessionTracking(options?.initialSessionId);
    const spawned = await this.spawnHarness(options);
    this.attachHarness(spawned);
  }

  subscribe(listener: (event: TaskEvent) => void): () => void {
    this.on('taskEvent', listener);
    return () => this.off('taskEvent', listener);
  }

  subscribeRuntimeOutput(listener: (event: AcpMessage) => void): () => void {
    this.on('runtimeOutput', listener);
    return () => this.off('runtimeOutput', listener);
  }

  subscribeRuntimePersistedEnvelope(
    listener: (envelope: AcpPersistedEnvelope) => void,
  ): () => void {
    this.on('runtimePersistedEnvelope', listener);
    return () => this.off('runtimePersistedEnvelope', listener);
  }

  subscribeRuntimeTurnCompleted(
    listener: (event: AcpTurnCompletedEvent) => void,
  ): () => void {
    this.on('runtimeTurnCompleted', listener);
    return () => this.off('runtimeTurnCompleted', listener);
  }

  subscribeRuntimeInferenceUsage(
    listener: (event: HarnessInferenceUsageEvent) => void,
  ): () => void {
    this.on('runtimeInferenceUsage', listener);
    return () => this.off('runtimeInferenceUsage', listener);
  }

  subscribeCommandError(
    listener: (error: HarnessCommandError) => void,
  ): () => void {
    this.on('commandError', listener);
    return () => this.off('commandError', listener);
  }

  sendCommand(command: TaskCommand): boolean {
    this.updateSessionTrackingForCommand(command);
    this.updateReconnectReplayStateForCommand(command);

    const harness = this.currentHarness;
    if (harness) {
      const sent = harness.sendCommand(command);
      if (sent) {
        return true;
      }

      if (harness.isConnected || !isReplayableReconnectCommand(command)) {
        return false;
      }
    }

    if (this.disposed || !isReplayableReconnectCommand(command)) {
      return false;
    }

    const queueMutationApplied =
      this.applyReconnectQueuedMessageMutation(command);
    if (queueMutationApplied !== undefined) {
      void this.ensureReconnect();
      return queueMutationApplied;
    }

    this.queuedCommands.push(cloneTaskCommandForReplay(command));
    void this.ensureReconnect();
    return true;
  }

  get isConnected(): boolean {
    return this.currentHarness?.isConnected ?? false;
  }

  get supportsNativeTurnSteering(): boolean {
    return this.cachedSupportsNativeTurnSteering;
  }

  getPendingUserInputRequests(): HarnessPendingUserInputRequest[] {
    return this.currentHarness?.getPendingUserInputRequests?.() ?? [];
  }

  getPendingEnvVarRequest(): HarnessPendingEnvVarRequest | null {
    return this.pendingEnvVarRequest;
  }

  getQueuedMessages(): HarnessQueuedMessage[] {
    return this.currentHarness?.getQueuedMessages?.() ?? [];
  }

  getCurrentWorkflowPhase(): string | null {
    return this.currentHarness?.getCurrentWorkflowPhase?.() ?? null;
  }

  getActiveModel(): string | null {
    return this.currentHarness?.getActiveModel?.() ?? null;
  }

  getLaunchModel(): string | null {
    return this.currentHarness?.getLaunchModel?.() ?? null;
  }

  getSwitchableModels(): string[] {
    return this.currentHarness?.getSwitchableModels?.() ?? [];
  }

  getQueuedMessageSnapshots(): QueuedPromptMessageSnapshot[] {
    return this.currentHarness?.getQueuedMessageSnapshots?.() ?? [];
  }

  dispose(): void {
    this.disposed = true;
    this.queuedCommands.length = 0;
    this.detachCurrentHarness();
  }

  setCommandEnv(env: Record<string, string>): void {
    this.currentCommandEnv = env;
    this.currentHarness?.setCommandEnv?.(env);
  }

  getCommandEnv(): Record<string, string> {
    return (
      this.currentHarness?.getCommandEnv?.() ?? this.currentCommandEnv ?? {}
    );
  }

  getCurrentSubprocess(): ResultPromise | null {
    return this.currentSubprocess;
  }

  isReconnecting(): boolean {
    return this.reconnectPromise !== null;
  }

  getLatestSessionId(): string | undefined {
    return this.latestSessionId;
  }

  async requestReconnect(options: {
    reason: string;
    replayCommands?: TaskCommand[];
    afterCurrentTurn?: boolean;
  }): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.logger.info(
      `[ReconnectableHarness] External reconnect requested: ${options.reason} (sessionId=${this.latestSessionId ?? 'none'}, afterCurrentTurn=${options.afterCurrentTurn === true})`,
    );
    this.diagnosticEvents?.record({
      kind: 'harness_restart_requested',
      message: `External reconnect requested: ${options.reason}`,
      details: {
        source: 'external',
        reason: options.reason,
        sessionId: this.latestSessionId ?? null,
        afterCurrentTurn: options.afterCurrentTurn === true,
      },
    });

    if (!this.currentHarness) {
      if (options.replayCommands?.length) {
        this.prependQueuedCommands(options.replayCommands);
      }
      await this.ensureReconnect();
      return;
    }

    if (options.afterCurrentTurn && this.currentHarness.requestReconnect) {
      await this.currentHarness.requestReconnect({
        reason: options.reason,
        replayCommands: options.replayCommands,
        afterCurrentTurn: true,
      });
      return;
    }

    await this.restartCurrentHarness({
      reason: options.reason,
      sessionId: this.latestSessionId,
      replayCommands: options.replayCommands,
    });
  }

  private attachHarness({ harness, subprocess }: SpawnHarnessResult): void {
    if (this.disposed) {
      harness.dispose();
      return;
    }

    this.detachCurrentHarness();

    this.currentHarness = harness;
    this.currentSubprocess = subprocess;
    this.cachedSupportsNativeTurnSteering = harness.supportsNativeTurnSteering;

    if (this.currentCommandEnv) {
      harness.setCommandEnv?.(this.currentCommandEnv);
    }

    const listeners: BoundHarnessListeners = {
      taskEvent: (event) => {
        this.updateSessionTrackingForTaskEvent(event);
        this.emit('taskEvent', event);
        this.requestQueuedCommandFlush();
      },
      connected: () => {
        this.emit('connected');
        this.requestQueuedCommandFlush();
      },
      disconnected: () => {
        if (this.disposed || harness !== this.currentHarness) {
          return;
        }

        this.logger.warn(
          `[ReconnectableHarness] Underlying harness disconnected; attempting reconnect (sessionId=${this.latestSessionId ?? 'none'})`,
        );
        this.diagnosticEvents?.record({
          kind: 'harness_disconnected',
          message: 'Underlying harness disconnected; attempting reconnect',
          details: { sessionId: this.latestSessionId ?? null },
        });

        this.captureReconnectQueuedMessages(harness);
        const subprocess = this.currentSubprocess;
        this.detachCurrentHarness();
        this.terminateSubprocess(subprocess, 'disconnect cleanup');
        void this.ensureReconnect();
      },
      restartRequested: (request) => {
        if (this.disposed || harness !== this.currentHarness) {
          return;
        }

        this.logger.warn(
          `[ReconnectableHarness] Underlying harness requested restart: ${request.reason} (sessionId=${request.sessionId ?? this.latestSessionId ?? 'none'})`,
        );
        this.diagnosticEvents?.record({
          kind: 'harness_restart_requested',
          message: `Harness requested restart: ${request.reason}`,
          details: {
            source: 'harness',
            reason: request.reason,
            sessionId: request.sessionId ?? this.latestSessionId ?? null,
          },
        });

        void this.restartCurrentHarness(request);
      },
      runtimeOutput: (event) => {
        this.updateSessionTracking(eventSessionId(event));
        this.emit('runtimeOutput', event);
        this.requestQueuedCommandFlush();
      },
      runtimePersistedEnvelope: (envelope) => {
        this.updateSessionTracking(eventSessionId(envelope));
        this.applyPendingEnvVarEnvelope(envelope);
        this.emit('runtimePersistedEnvelope', envelope);
        this.requestQueuedCommandFlush();
      },
      runtimeTurnCompleted: (event) => {
        this.updateSessionTracking(event.sessionId);
        this.emit('runtimeTurnCompleted', event);
        this.requestQueuedCommandFlush();
      },
      runtimeInferenceUsage: (event) => {
        this.updateSessionTracking(event.sessionId);
        this.emit('runtimeInferenceUsage', event);
      },
      commandError: (error) => {
        this.emit('commandError', error);
      },
    };

    this.currentListeners = listeners;

    harness.on('taskEvent', listeners.taskEvent);
    harness.on('connected', listeners.connected);
    harness.on('disconnected', listeners.disconnected);
    harness.on('restartRequested', listeners.restartRequested);
    harness.on('runtimeOutput', listeners.runtimeOutput);
    harness.on('runtimePersistedEnvelope', listeners.runtimePersistedEnvelope);
    harness.on('runtimeTurnCompleted', listeners.runtimeTurnCompleted);
    harness.on('runtimeInferenceUsage', listeners.runtimeInferenceUsage);
    listeners.commandErrorUnsubscribe = harness.subscribeCommandError?.(
      listeners.commandError,
    );

    this.requestQueuedCommandFlush();
  }

  private detachCurrentHarness(options?: { dispose?: boolean }): void {
    const harness = this.currentHarness;
    const listeners = this.currentListeners;

    if (harness && listeners) {
      harness.off('taskEvent', listeners.taskEvent);
      harness.off('connected', listeners.connected);
      harness.off('disconnected', listeners.disconnected);
      harness.off('restartRequested', listeners.restartRequested);
      harness.off('runtimeOutput', listeners.runtimeOutput);
      harness.off(
        'runtimePersistedEnvelope',
        listeners.runtimePersistedEnvelope,
      );
      harness.off('runtimeTurnCompleted', listeners.runtimeTurnCompleted);
      harness.off('runtimeInferenceUsage', listeners.runtimeInferenceUsage);
      listeners.commandErrorUnsubscribe?.();
    }

    if (harness && options?.dispose !== false) {
      harness.dispose();
    }

    this.currentHarness = null;
    this.currentSubprocess = null;
    this.currentListeners = null;
  }

  private async ensureReconnect(): Promise<void> {
    if (this.reconnectPromise || this.disposed) {
      return;
    }

    this.reconnectPromise = this.reconnectLoop().finally(() => {
      this.reconnectPromise = null;
    });

    await this.reconnectPromise;
  }

  private async restartCurrentHarness(
    request: HarnessRestartRequest,
  ): Promise<void> {
    if (request.sessionId) {
      this.updateSessionTracking(request.sessionId);
    }

    this.captureReconnectQueuedMessages(this.currentHarness);
    if (request.replayCommands?.length) {
      this.prependQueuedCommands(request.replayCommands);
    }
    const subprocess = this.currentSubprocess;
    this.detachCurrentHarness();

    this.terminateSubprocess(subprocess, 'restart');

    await this.ensureReconnect();
  }

  private terminateSubprocess(
    subprocess: ResultPromise | null,
    reason: string,
  ): void {
    if (!subprocess) {
      return;
    }

    try {
      // A live process killed here is deliberate teardown; one that already
      // exited died on its own and keeps its death certificate.
      markExpectedSubprocessExitIfAlive(subprocess);
      const terminated = subprocess.kill('SIGTERM');
      this.logger.info(
        `[ReconnectableHarness] Terminated subprocess during ${reason} sentSignal=${terminated}`,
      );
    } catch (error) {
      this.logger.warn(
        `[ReconnectableHarness] Failed to terminate subprocess during ${reason}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private applyPendingEnvVarEnvelope(envelope: AcpPersistedEnvelope): void {
    if (envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolResult) {
      const requestedNames = getRequestedDeploymentEnvVarNamesFromToolPayload(
        asRecord(envelope.payload) ?? null,
      );

      if (requestedNames.length === 0) {
        return;
      }

      this.pendingEnvVarRequest = {
        key:
          asString(asRecord(envelope.payload)?.toolCallId) ??
          `env-var-request:${envelope.ts}`,
        ts: envelope.ts,
        variables: requestedNames.map((name) => ({ name })),
      };
      return;
    }

    if (envelope.eventType !== ACP_ENVELOPE_EVENT_TYPES.UserPrompt) {
      return;
    }

    const clientMessageId = asString(
      asRecord(envelope.payload)?.clientMessageId,
    );

    if (isEnvVarRequestFulfillmentClientMessageId(clientMessageId)) {
      this.pendingEnvVarRequest = null;
    }
  }

  private async reconnectLoop(): Promise<void> {
    for (let attempt = 1; attempt <= this.maxReconnectAttempts; attempt += 1) {
      if (this.disposed) {
        return;
      }

      try {
        const spawned = await this.spawnHarness({
          initialSessionId: this.latestSessionId,
        });

        this.logger.info(
          `[ReconnectableHarness] Reconnected harness on attempt ${attempt}/${this.maxReconnectAttempts} (sessionId=${this.latestSessionId ?? 'none'})`,
        );
        this.diagnosticEvents?.record({
          kind: 'harness_reconnected',
          message: `Reconnected harness on attempt ${attempt}/${this.maxReconnectAttempts}`,
          details: {
            attempt,
            maxAttempts: this.maxReconnectAttempts,
            sessionId: this.latestSessionId ?? null,
          },
        });
        this.attachHarness(spawned);
        return;
      } catch (error) {
        this.logger.error(
          `[ReconnectableHarness] Failed reconnect attempt ${attempt}/${this.maxReconnectAttempts}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );

        if (attempt >= this.maxReconnectAttempts) {
          break;
        }

        await sleep(
          RECONNECT_BACKOFF_MS[
            Math.min(attempt - 1, RECONNECT_BACKOFF_MS.length - 1)
          ] ?? RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1]!,
        );
      }
    }

    if (!this.disposed) {
      this.diagnosticEvents?.record({
        kind: 'harness_reconnect_exhausted',
        message: `Gave up reconnecting after ${this.maxReconnectAttempts} attempts`,
        details: {
          maxAttempts: this.maxReconnectAttempts,
          sessionId: this.latestSessionId ?? null,
        },
      });
      this.emit('disconnected');
    }
  }

  private async flushQueuedCommands(): Promise<void> {
    const harness = this.currentHarness;
    if (
      !harness ||
      (this.queuedCommands.length === 0 &&
        this.reconnectQueuedMessages === undefined) ||
      this.flushingQueuedCommands
    ) {
      return;
    }

    this.flushingQueuedCommands = true;

    try {
      if (this.reconnectQueuedMessages) {
        if (this.reconnectQueuedMessages.length > 0) {
          const restoreCommand: TaskCommand = {
            commandName: 'RestoreQueuedMessages',
            data: {
              queuedMessages: cloneQueuedPromptMessageSnapshots(
                this.reconnectQueuedMessages,
              ),
            },
          };

          if (!harness.sendCommand(restoreCommand)) {
            return;
          }
        }

        this.reconnectQueuedMessages = undefined;
      }

      while (this.queuedCommands.length > 0) {
        const command = this.queuedCommands[0]!;

        if (this.shouldWaitForPendingUserInputRequest(harness, command)) {
          return;
        }

        if (!harness.sendCommand(command)) {
          return;
        }

        this.queuedCommands.shift();
      }
    } finally {
      this.flushingQueuedCommands = false;
    }
  }

  private requestQueuedCommandFlush(): void {
    void this.flushQueuedCommands();
  }

  private shouldWaitForPendingUserInputRequest(
    harness: Harness,
    command: TaskCommand,
  ): boolean {
    if (command.commandName !== 'AnswerUserInputRequest') {
      return false;
    }

    const pendingRequests = harness.getPendingUserInputRequests?.();

    if (!pendingRequests) {
      return false;
    }

    return !pendingRequests.some(
      (request) => request.requestId === command.data.requestId,
    );
  }

  private prependQueuedCommands(commands: TaskCommand[]): void {
    if (commands.length === 0) {
      return;
    }

    const nextQueuedCommands: TaskCommand[] = [];

    for (const command of commands) {
      if (command.commandName === 'RestoreQueuedMessages') {
        if (this.reconnectQueuedMessages === undefined) {
          this.reconnectQueuedMessages = cloneQueuedPromptMessageSnapshots(
            command.data.queuedMessages,
          );
        }
        continue;
      }

      nextQueuedCommands.push(cloneTaskCommandForReplay(command));
    }

    this.queuedCommands.unshift(...nextQueuedCommands);
  }

  private captureReconnectQueuedMessages(harness: Harness | null): void {
    const queuedMessages = harness?.getQueuedMessageSnapshots?.();

    if (queuedMessages && queuedMessages.length > 0) {
      this.reconnectQueuedMessages =
        cloneQueuedPromptMessageSnapshots(queuedMessages);
    }
  }

  private applyReconnectQueuedMessageMutation(
    command: TaskCommand,
  ): boolean | undefined {
    if (
      command.commandName !== 'DeleteQueuedMessage' &&
      command.commandName !== 'PrioritizeQueuedMessage' &&
      command.commandName !== 'ReorderQueuedMessage'
    ) {
      return undefined;
    }

    const queuedMessages = this.reconnectQueuedMessages;
    if (!queuedMessages) {
      return false;
    }

    const removeQueuedMessageById = (
      queuedMessageId: string,
    ): QueuedPromptMessageSnapshot | null => {
      const index = queuedMessages.findIndex(
        (queuedMessage) => queuedMessage.id === queuedMessageId,
      );

      if (index < 0) {
        return null;
      }

      const [queuedMessage] = queuedMessages.splice(index, 1);
      return queuedMessage ?? null;
    };

    if (command.commandName === 'DeleteQueuedMessage') {
      const queuedMessageId = extractQueuedMessageId(command);

      if (!queuedMessageId) {
        return false;
      }

      return removeQueuedMessageById(queuedMessageId) !== null;
    }

    if (command.commandName === 'PrioritizeQueuedMessage') {
      const queuedMessageId = extractQueuedMessageId(command);

      if (!queuedMessageId) {
        return false;
      }

      const queuedMessage = removeQueuedMessageById(queuedMessageId);
      if (!queuedMessage) {
        return false;
      }

      queuedMessages.unshift(queuedMessage);
      return true;
    }

    const queuedMessageMove = extractQueuedMessageMove(command);
    if (!queuedMessageMove) {
      return false;
    }

    if (queuedMessageMove.id === queuedMessageMove.targetId) {
      return true;
    }

    const sourceIndex = queuedMessages.findIndex(
      (queuedMessage) => queuedMessage.id === queuedMessageMove.id,
    );
    const targetIndex = queuedMessages.findIndex(
      (queuedMessage) => queuedMessage.id === queuedMessageMove.targetId,
    );

    if (sourceIndex < 0 || targetIndex < 0) {
      return false;
    }

    const [queuedMessage] = queuedMessages.splice(sourceIndex, 1);

    if (!queuedMessage) {
      return false;
    }

    const nextTargetIndex = queuedMessages.findIndex(
      (candidate) => candidate.id === queuedMessageMove.targetId,
    );

    if (nextTargetIndex < 0) {
      return false;
    }

    queuedMessages.splice(
      queuedMessageMove.position === 'before'
        ? nextTargetIndex
        : nextTargetIndex + 1,
      0,
      queuedMessage,
    );

    return true;
  }

  private updateSessionTrackingForCommand(command: TaskCommand): void {
    switch (command.commandName) {
      case 'StartNewTask':
      case 'CloseTask':
        this.pendingEnvVarRequest = null;
        this.latestSessionId = undefined;
        return;
      case 'ResumeTask':
        if (typeof command.data === 'string' && command.data.length > 0) {
          this.latestSessionId = command.data;
        }
        return;
      default:
        return;
    }
  }

  private updateSessionTrackingForTaskEvent(event: TaskEvent): void {
    if (
      (event.eventName === 'taskStarted' ||
        event.eventName === 'taskCompleted' ||
        event.eventName === 'taskAborted') &&
      Array.isArray(event.payload) &&
      typeof event.payload[0] === 'string'
    ) {
      this.updateSessionTracking(event.payload[0]);
    }
  }

  private updateSessionTracking(sessionId: string | undefined): void {
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      this.latestSessionId = sessionId;
    }
  }

  private updateReconnectReplayStateForCommand(command: TaskCommand): void {
    switch (command.commandName) {
      case 'StartNewTask':
      case 'CloseTask':
      case 'ResumeTask':
        this.reconnectQueuedMessages = undefined;
        return;
      default:
        return;
    }
  }
}
