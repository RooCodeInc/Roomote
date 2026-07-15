import EventEmitter from 'node:events';

import {
  type AcpMessage,
  type AcpPersistedEnvelope,
  ACP_ENVELOPE_EVENT_TYPES,
  type AcpTurnCompletedEvent,
  type TaskEvent,
  TaskEventName,
} from '@roomote/types';

import {
  type TaskCommand,
  TaskCommandName,
  type Harness,
  type HarnessCommandError,
  type HarnessEvents,
} from '../harness';
import {
  type HarnessManagerCallbacks,
  HarnessManager,
} from '../harness-manager';

const { captureWorkerMessageMock } = vi.hoisted(() => ({
  captureWorkerMessageMock: vi.fn(),
}));

vi.mock('../../../monitoring/sentry', () => ({
  captureWorkerMessage: captureWorkerMessageMock,
}));

class FakeHarness extends EventEmitter<HarnessEvents> implements Harness {
  sentCommands: TaskCommand[] = [];
  pendingUserInputRequests: Array<Record<string, unknown>> = [];
  queuedMessageSnapshots: Array<{
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
    timestamp: number;
  }> = [];
  connected = true;
  nativeTurnSteering = false;

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

  subscribeCommandError(
    listener: (error: HarnessCommandError) => void,
  ): () => void {
    this.on('commandError', listener);
    return () => this.off('commandError', listener);
  }

  sendCommand(command: TaskCommand): boolean {
    this.sentCommands.push(command);
    return true;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get supportsNativeTurnSteering(): boolean {
    return this.nativeTurnSteering;
  }

  getPendingUserInputRequests() {
    return this.pendingUserInputRequests as never;
  }

  getQueuedMessageSnapshots() {
    return this.queuedMessageSnapshots as never;
  }

  dispose(): void {
    this.removeAllListeners();
  }

  emitTaskEvent(event: TaskEvent): void {
    this.emit('taskEvent', event);
  }

  emitRuntimeOutput(event: AcpMessage): void {
    this.emit('runtimeOutput', event);
  }

  emitCommandError(error: HarnessCommandError): void {
    this.emit('commandError', error);
  }
}

function createManager(
  options: {
    keepaliveMs?: number;
    sandboxTimeoutMs?: number;
    sandboxExpiresAtMs?: number;
    nativeTurnSteering?: boolean;
    runId?: number;
    taskId?: string | null;
  } & HarnessManagerCallbacks = {},
) {
  const harness = new FakeHarness();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
  };
  const {
    keepaliveMs = 60_000,
    sandboxTimeoutMs,
    sandboxExpiresAtMs,
    nativeTurnSteering,
    runId,
    taskId,
    ...callbacks
  } = options;

  if (nativeTurnSteering !== undefined) {
    harness.nativeTurnSteering = nativeTurnSteering;
  }

  const manager = new HarnessManager({
    harness,
    keepaliveMs,
    sandboxTimeoutMs,
    sandboxExpiresAtMs,
    runId,
    taskId,
    logger,
    callbacks,
  });

  return { harness, logger, manager };
}

describe('HarnessManager deleteQueuedMessage', () => {
  it('forwards queued-message deletion commands to the harness', () => {
    const { harness, manager } = createManager();

    try {
      const deleted = manager.deleteQueuedMessage('runtime-queued-1');

      expect(deleted).toBe(true);
      expect(harness.sentCommands.at(-1)).toMatchObject({
        commandName: TaskCommandName.DeleteQueuedMessage,
        data: { id: 'runtime-queued-1' },
      });
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });
});

describe('HarnessManager prioritizeQueuedMessage', () => {
  it('forwards queued-message prioritize commands to the harness', () => {
    const { harness, manager } = createManager();

    try {
      const prioritized = manager.prioritizeQueuedMessage('runtime-queued-2');

      expect(prioritized).toBe(true);
      expect(harness.sentCommands.at(-1)).toMatchObject({
        commandName: TaskCommandName.PrioritizeQueuedMessage,
        data: { id: 'runtime-queued-2' },
      });
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });
});

describe('HarnessManager steerQueuedMessage', () => {
  it('interrupts the current turn without transitioning into stopped', () => {
    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-steer-queued'],
      } as TaskEvent);

      const steered = manager.steerQueuedMessage('runtime-queued-2');

      expect(steered).toBe(true);
      expect(manager.getStatus().phase).toBe('running');
      expect(manager.getState().cancelTriggeredAt).toBeUndefined();
      expect(harness.sentCommands.at(-2)).toMatchObject({
        commandName: TaskCommandName.PrioritizeQueuedMessage,
        data: { id: 'runtime-queued-2' },
      });
      expect(harness.sentCommands.at(-1)).toMatchObject({
        commandName: TaskCommandName.CancelTask,
      });
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('moves waiting_for_user_input back to running before interrupting', () => {
    const { harness, manager } = createManager();

    try {
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-steer-interactive'],
      } as TaskEvent);

      harness.emitRuntimeOutput({
        id: 'task-steer-interactive:1',
        ts: 1,
        eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
        kind: 'unknown',
        role: 'assistant',
        contentBlocks: [],
        metadata: { sessionId: 'task-steer-interactive', sequence: 1 },
        payload: {
          requestId: 'rui:task-steer-interactive:turn-1:call-1',
          sessionId: 'task-steer-interactive',
          turnId: 'turn-1',
          callId: 'call-1',
          status: 'pending',
          questions: [],
        },
      } as AcpMessage);

      expect(manager.getStatus().phase).toBe('waiting_for_user_input');

      const steered = manager.steerQueuedMessage('runtime-queued-3');

      expect(steered).toBe(true);
      expect(manager.getStatus().phase).toBe('running');
      expect(manager.getState().cancelTriggeredAt).toBeUndefined();
      expect(harness.sentCommands.at(-1)).toMatchObject({
        commandName: TaskCommandName.CancelTask,
      });
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('force-sends the queued message without interrupting when native turn steering is enabled', () => {
    const { harness, manager } = createManager({ nativeTurnSteering: true });
    harness.queuedMessageSnapshots = [
      {
        id: 'opencode-queued-1',
        text: 'Use this queued prompt now',
        images: ['data:image/png;base64,abc'],
        workflowPhase: 'review-code',
        userId: 'user-1',
        userName: 'Chris',
        userImageUrl: 'https://example.com/avatar.png',
        clientMessageId: 'client-message-1',
        timestamp: 1,
      },
    ];

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-native-steer-queued'],
      } as TaskEvent);

      const steered = manager.steerQueuedMessage('opencode-queued-1');

      expect(steered).toBe(true);
      expect(manager.getStatus().phase).toBe('running');
      expect(manager.getState().cancelTriggeredAt).toBeUndefined();
      expect(harness.sentCommands.at(-2)).toMatchObject({
        commandName: TaskCommandName.DeleteQueuedMessage,
        data: { id: 'opencode-queued-1' },
      });
      expect(harness.sentCommands.at(-1)).toMatchObject({
        commandName: TaskCommandName.SendMessage,
        data: {
          text: 'Use this queued prompt now',
          images: ['data:image/png;base64,abc'],
          workflowPhase: 'review-code',
          autoSteerWhenQueued: true,
          userId: 'user-1',
          userName: 'Chris',
          userImageUrl: 'https://example.com/avatar.png',
          clientMessageId: 'client-message-1',
        },
      });
      expect(
        harness.sentCommands.some(
          (command) => command.commandName === TaskCommandName.CancelTask,
        ),
      ).toBe(false);
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('force-sends the queued message from waiting_for_prompt when native turn steering is enabled', () => {
    const { harness, manager } = createManager({ nativeTurnSteering: true });
    harness.queuedMessageSnapshots = [
      {
        id: 'opencode-queued-waiting-1',
        text: 'Interrupt the delegated turn now',
        workflowPhase: 'review-code',
        timestamp: 1,
      },
    ];

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-native-steer-waiting'],
      } as TaskEvent);

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'task-native-steer-waiting',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('waiting_for_prompt');

      const steered = manager.steerQueuedMessage('opencode-queued-waiting-1');

      expect(steered).toBe(true);
      expect(manager.getStatus().phase).toBe('running');
      expect(manager.getState().cancelTriggeredAt).toBeUndefined();
      expect(harness.sentCommands.at(-2)).toMatchObject({
        commandName: TaskCommandName.DeleteQueuedMessage,
        data: { id: 'opencode-queued-waiting-1' },
      });
      expect(harness.sentCommands.at(-1)).toMatchObject({
        commandName: TaskCommandName.SendMessage,
        data: {
          text: 'Interrupt the delegated turn now',
          workflowPhase: 'review-code',
          autoSteerWhenQueued: true,
        },
      });
      expect(
        harness.sentCommands.some(
          (command) => command.commandName === TaskCommandName.CancelTask,
        ),
      ).toBe(false);
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });
});

describe('HarnessManager reorderQueuedMessage', () => {
  it('forwards queued-message reorder commands to the harness', () => {
    const { harness, manager } = createManager();

    try {
      const reordered = manager.reorderQueuedMessage(
        'runtime-queued-3',
        'runtime-queued-1',
        'before',
      );

      expect(reordered).toBe(true);
      expect(harness.sentCommands.at(-1)).toMatchObject({
        commandName: TaskCommandName.ReorderQueuedMessage,
        data: {
          id: 'runtime-queued-3',
          targetId: 'runtime-queued-1',
          position: 'before',
        },
      });
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });
});

describe('HarnessManager phase reporting', () => {
  function startAndSettleTask(
    harness: FakeHarness,
    manager: HarnessManager,
    taskId = 'task-phase-1',
  ) {
    manager.initializeWithoutPrompt();
    manager.startNewTaskFromPrompt({ prompt: 'hello' });
    harness.emitTaskEvent({
      eventName: TaskEventName.TaskStarted,
      payload: [taskId],
    } as TaskEvent);
    harness.emitTaskEvent({
      eventName: TaskEventName.TaskCompleted,
      payload: [taskId],
    } as TaskEvent);
    expect(manager.getStatus().phase).toBe('waiting_for_prompt');
    return taskId;
  }

  it('promotes a settled task back to running when a user prompt starts a turn', () => {
    const { harness, manager } = createManager();

    try {
      const taskId = startAndSettleTask(harness, manager);

      // A drained queue follow-up / steered replay / question answer is
      // delivered as a user_prompt runtime event without going through
      // startNewTask or sendFollowUpPrompt.
      harness.emitRuntimeOutput({
        id: `${taskId}:prompt-1`,
        ts: 10,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        kind: 'text',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'drained follow-up' }],
        metadata: { sessionId: taskId, sequence: 2 },
        payload: { sessionId: taskId, text: 'drained follow-up' },
      } as AcpMessage);

      expect(manager.getStatus().phase).toBe('running');
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('does not promote past a pending question on a user prompt event', () => {
    const { harness, manager } = createManager();

    try {
      const taskId = 'task-phase-question';
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });
      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: [taskId],
      } as TaskEvent);
      // The real harness populates its pending-request map when it emits a
      // RequestUserInput event; mirror that so getPendingUserInputRequests
      // reflects a genuinely blocked turn.
      harness.pendingUserInputRequests = [
        {
          requestId: `rui:${taskId}:turn-1:call-1`,
          sessionId: taskId,
          turnId: 'turn-1',
          callId: 'call-1',
          status: 'pending',
          questions: [],
          ts: 1,
        },
      ];
      harness.emitRuntimeOutput({
        id: `${taskId}:rui-1`,
        ts: 5,
        eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
        kind: 'unknown',
        role: 'assistant',
        contentBlocks: [],
        metadata: { sessionId: taskId, sequence: 1 },
        payload: {
          requestId: `rui:${taskId}:turn-1:call-1`,
          sessionId: taskId,
          turnId: 'turn-1',
          callId: 'call-1',
          status: 'pending',
          questions: [],
        },
      } as AcpMessage);
      expect(manager.getStatus().phase).toBe('waiting_for_user_input');

      // A user_prompt arrives while the question is still genuinely
      // pending: the phase must stay blocked.
      harness.emitRuntimeOutput({
        id: `${taskId}:prompt-1`,
        ts: 10,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        kind: 'text',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'unrelated' }],
        metadata: { sessionId: taskId, sequence: 2 },
        payload: { sessionId: taskId, text: 'unrelated' },
      } as AcpMessage);

      expect(manager.getStatus().phase).toBe('waiting_for_user_input');
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('promotes out of waiting_for_user_input when the question is cleared before the replayed prompt', () => {
    const { harness, manager } = createManager();

    try {
      const taskId = 'task-phase-steer-replay';
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });
      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: [taskId],
      } as TaskEvent);
      harness.pendingUserInputRequests = [
        {
          requestId: `rui:${taskId}:turn-1:call-1`,
          sessionId: taskId,
          status: 'pending',
          questions: [],
          ts: 1,
        },
      ];
      harness.emitRuntimeOutput({
        id: `${taskId}:rui-1`,
        ts: 5,
        eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
        kind: 'unknown',
        role: 'assistant',
        contentBlocks: [],
        metadata: { sessionId: taskId, sequence: 1 },
        payload: {
          requestId: `rui:${taskId}:turn-1:call-1`,
          sessionId: taskId,
          status: 'pending',
          questions: [],
        },
      } as AcpMessage);
      expect(manager.getStatus().phase).toBe('waiting_for_user_input');

      // The auto-steer abort-and-replay abandons the question (the harness
      // clears its pending map) and then drains the steered prompt as a
      // user_prompt. The phase must promote back to running.
      harness.pendingUserInputRequests = [];
      harness.emitRuntimeOutput({
        id: `${taskId}:prompt-steer`,
        ts: 10,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        kind: 'text',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'steer while blocked' }],
        metadata: { sessionId: taskId, sequence: 2 },
        payload: { sessionId: taskId, text: 'steer while blocked' },
      } as AcpMessage);

      expect(manager.getStatus().phase).toBe('running');
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('reports waiting_for_user_input instead of running when a follow-up is sent behind a pending question', () => {
    const { harness, manager } = createManager();

    try {
      const taskId = 'task-phase-blocked';
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });
      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: [taskId],
      } as TaskEvent);
      expect(manager.getStatus().phase).toBe('running');

      harness.pendingUserInputRequests = [
        {
          requestId: `rui:${taskId}:turn-1:call-1`,
          sessionId: taskId,
          turnId: 'turn-1',
          callId: 'call-1',
          status: 'pending',
          questions: [],
          ts: 1,
        },
      ];

      const sent = manager.sendFollowUpPrompt({
        prompt: 'steer while blocked',
        autoSteerWhenQueued: true,
      });

      expect(sent).toBe(true);
      expect(manager.getStatus().phase).toBe('waiting_for_user_input');
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('still promotes a settled task to running for a follow-up with no pending question', () => {
    const { harness, manager } = createManager();

    try {
      startAndSettleTask(harness, manager, 'task-phase-follow-up');

      const sent = manager.sendFollowUpPrompt({ prompt: 'more work' });

      expect(sent).toBe(true);
      expect(manager.getStatus().phase).toBe('running');
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });
});

describe('HarnessManager cancelTask', () => {
  it('cancels while running even before sessionId is known', () => {
    const { harness, manager, logger } = createManager();

    try {
      manager.initializeWithoutPrompt();
      const started = manager.startNewTaskFromPrompt({ prompt: 'hello' });

      expect(started).toBe(true);
      expect(manager.getStatus().phase).toBe('running');
      expect(manager.getStatus().sessionId).toBeUndefined();

      manager.cancelTask();

      expect(manager.getStatus().phase).toBe('stopped');
      expect(harness.sentCommands.at(-1)?.commandName).toBe(
        TaskCommandName.CancelTask,
      );
      expect(logger.warn).not.toHaveBeenCalledWith(
        '[HarnessManager#cancelTask] No active task',
      );
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('forwards user-stop attribution to the harness cancel command', () => {
    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      manager.cancelTask({
        cancelledBy: { name: 'Daniel', source: 'web' },
      });

      expect(harness.sentCommands.at(-1)).toMatchObject({
        commandName: TaskCommandName.CancelTask,
        data: { cancelledBy: { name: 'Daniel', source: 'web' } },
      });
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('sends the cancel command without data when no attribution is given', () => {
    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      manager.cancelTask();

      const command = harness.sentCommands.at(-1);
      expect(command?.commandName).toBe(TaskCommandName.CancelTask);
      expect(command).not.toHaveProperty('data');
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('allows cancel while waiting for user input', () => {
    const { harness, manager, logger } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-user-input'],
      } as TaskEvent);
      harness.emitRuntimeOutput({
        id: 'task-user-input:1',
        ts: 1,
        eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
        kind: 'unknown',
        role: 'assistant',
        contentBlocks: [],
        metadata: { sessionId: 'task-user-input', sequence: 1 },
        payload: {
          requestId: 'rui:task-user-input:turn-1:call-1',
          sessionId: 'task-user-input',
          turnId: 'turn-1',
          callId: 'call-1',
          status: 'pending',
          questions: [],
        },
      } as AcpMessage);

      expect(manager.getStatus().phase).toBe('waiting_for_user_input');

      manager.cancelTask();

      expect(manager.getStatus().phase).toBe('stopped');
      expect(harness.sentCommands.at(-1)?.commandName).toBe(
        TaskCommandName.CancelTask,
      );
      expect(logger.warn).not.toHaveBeenCalledWith(
        '[HarnessManager#cancelTask] No active task',
      );
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('does not cancel in waiting_for_prompt even with a stored sessionId', () => {
    const { harness, manager, logger } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-1'],
      } as TaskEvent);
      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'task-1',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('waiting_for_prompt');
      expect(manager.getStatus().sessionId).toBe('task-1');

      const commandCountBeforeCancel = harness.sentCommands.length;
      manager.cancelTask();

      expect(harness.sentCommands).toHaveLength(commandCountBeforeCancel);
      expect(logger.warn).toHaveBeenCalledWith(
        '[HarnessManager#cancelTask] No active task',
      );
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('restores snapshot resumes to waiting_for_prompt', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-19T12:00:00.000Z'));

    const { harness, manager, logger } = createManager({
      keepaliveMs: 30 * 60 * 1_000,
      sandboxTimeoutMs: 5 * 60 * 60 * 1_000,
    });

    try {
      manager.resumeTask('task-2');

      expect(manager.getStatus().phase).toBe('waiting_for_prompt');
      expect(manager.getStatus().sessionId).toBe('task-2');
      const sleepAt = manager.getSleepAt();
      expect(sleepAt).not.toBeNull();
      expect((sleepAt ?? 0) - Date.now()).toBeLessThanOrEqual(30 * 60 * 1_000);
      expect((sleepAt ?? 0) - Date.now()).toBeGreaterThan(29 * 60 * 1_000);

      manager.cancelTask();

      expect(manager.getStatus().phase).toBe('stopped');
      expect(harness.sentCommands.at(-1)?.commandName).toBe(
        TaskCommandName.CancelTask,
      );
      expect(logger.warn).not.toHaveBeenCalledWith(
        '[HarnessManager#cancelTask] No active task',
      );
    } finally {
      vi.useRealTimers();
      manager.dispose();
      harness.dispose();
    }
  });

  it('stays stopped after cancel abort while queued runtime follow-ups still remain', () => {
    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-queued'],
      } as TaskEvent);

      harness.emitRuntimeOutput({
        id: 'task-queued:1',
        ts: Date.now(),
        eventType: 'roomote_runtime.queued_messages_update',
        role: 'assistant',
        kind: 'unknown',
        contentBlocks: [],
        metadata: { sessionId: 'task-queued', sequence: 1 },
        payload: {
          queuedMessages: [{ id: 'q-1', text: 'follow-up', timestamp: 1 }],
        },
      });

      manager.cancelTask();
      expect(manager.getStatus().phase).toBe('stopped');

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskAborted,
        payload: ['task-queued'],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('stopped');
      expect(manager.getStatus().taskStateEvent).toBe(
        TaskEventName.TaskAborted,
      );

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'task-queued',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('stopped');
      expect(manager.getStatus().taskStateEvent).toBe(
        TaskEventName.TaskAborted,
      );
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('stays running after a non-stopped abort while queued runtime follow-ups take over', () => {
    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-follow-up'],
      } as TaskEvent);

      harness.emitRuntimeOutput({
        id: 'task-follow-up:1',
        ts: Date.now(),
        eventType: 'roomote_runtime.queued_messages_update',
        role: 'assistant',
        kind: 'unknown',
        contentBlocks: [],
        metadata: { sessionId: 'task-follow-up', sequence: 1 },
        payload: {
          queuedMessages: [{ id: 'q-1', text: 'follow-up', timestamp: 1 }],
        },
      });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskAborted,
        payload: ['task-follow-up'],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('running');
      expect(manager.getStatus().taskStateEvent).toBeNull();

      harness.emitRuntimeOutput({
        id: 'task-follow-up:2',
        ts: Date.now(),
        eventType: 'roomote_runtime.queued_messages_update',
        role: 'assistant',
        kind: 'unknown',
        contentBlocks: [],
        metadata: { sessionId: 'task-follow-up', sequence: 2 },
        payload: {
          queuedMessages: [],
          cause: 'dequeue',
        },
      });

      expect(manager.getStatus().phase).toBe('running');
      expect(manager.getStatus().taskStateEvent).toBeNull();
      expect(manager.getState().taskAbortedAt).toBeUndefined();
      expect(manager.getState().cancelTriggeredAt).toBeUndefined();
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('finalizes deferred abort when queued prompts are deleted before another turn starts', () => {
    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-abort-delete'],
      } as TaskEvent);

      harness.emitRuntimeOutput({
        id: 'task-abort-delete:1',
        ts: Date.now(),
        eventType: 'roomote_runtime.queued_messages_update',
        role: 'assistant',
        kind: 'unknown',
        contentBlocks: [],
        metadata: { sessionId: 'task-abort-delete', sequence: 1 },
        payload: {
          queuedMessages: [{ id: 'q-1', text: 'follow-up', timestamp: 1 }],
        },
      });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskAborted,
        payload: ['task-abort-delete'],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('running');
      expect(manager.getStatus().taskStateEvent).toBeNull();

      harness.emitRuntimeOutput({
        id: 'task-abort-delete:2',
        ts: Date.now(),
        eventType: 'roomote_runtime.queued_messages_update',
        role: 'assistant',
        kind: 'unknown',
        contentBlocks: [],
        metadata: { sessionId: 'task-abort-delete', sequence: 2 },
        payload: {
          queuedMessages: [],
          cause: 'delete',
        },
      });

      expect(manager.getStatus().phase).toBe('waiting_for_prompt');
      expect(manager.getStatus().taskStateEvent).toBe(
        TaskEventName.TaskAborted,
      );
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('does not let a deferred completion overwrite a cancelled queued abort before the queue clears', () => {
    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-cancelled-delete'],
      } as TaskEvent);

      harness.emitRuntimeOutput({
        id: 'task-cancelled-delete:1',
        ts: Date.now(),
        eventType: 'roomote_runtime.queued_messages_update',
        role: 'assistant',
        kind: 'unknown',
        contentBlocks: [],
        metadata: { sessionId: 'task-cancelled-delete', sequence: 1 },
        payload: {
          queuedMessages: [{ id: 'q-1', text: 'follow-up', timestamp: 1 }],
        },
      });

      manager.cancelTask();
      expect(manager.getStatus().phase).toBe('stopped');

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskAborted,
        payload: ['task-cancelled-delete'],
      } as TaskEvent);

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'task-cancelled-delete',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      harness.emitRuntimeOutput({
        id: 'task-cancelled-delete:2',
        ts: Date.now(),
        eventType: 'roomote_runtime.queued_messages_update',
        role: 'assistant',
        kind: 'unknown',
        contentBlocks: [],
        metadata: { sessionId: 'task-cancelled-delete', sequence: 2 },
        payload: {
          queuedMessages: [],
          cause: 'delete',
        },
      });

      expect(manager.getStatus().phase).toBe('stopped');
      expect(manager.getStatus().taskStateEvent).toBe(
        TaskEventName.TaskAborted,
      );
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('resolves deferred abort to stopped when cancelTask is called before the queue drains', () => {
    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-cancel-mid-defer'],
      } as TaskEvent);

      harness.emitRuntimeOutput({
        id: 'task-cancel-mid-defer:1',
        ts: Date.now(),
        eventType: 'roomote_runtime.queued_messages_update',
        role: 'assistant',
        kind: 'unknown',
        contentBlocks: [],
        metadata: { sessionId: 'task-cancel-mid-defer', sequence: 1 },
        payload: {
          queuedMessages: [{ id: 'q-1', text: 'follow-up', timestamp: 1 }],
        },
      });

      // Abort arrives while queued follow-ups exist → deferred, phase stays running
      harness.emitTaskEvent({
        eventName: TaskEventName.TaskAborted,
        payload: ['task-cancel-mid-defer'],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('running');

      // User cancels while the abort is still deferred
      manager.cancelTask();
      expect(manager.getStatus().phase).toBe('stopped');

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskAborted,
        payload: ['task-cancel-mid-defer'],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('stopped');
      expect(manager.getStatus().taskStateEvent).toBe(
        TaskEventName.TaskAborted,
      );

      // Queue drains via delete — should finalize as stopped (not waiting_for_prompt)
      harness.emitRuntimeOutput({
        id: 'task-cancel-mid-defer:2',
        ts: Date.now(),
        eventType: 'roomote_runtime.queued_messages_update',
        role: 'assistant',
        kind: 'unknown',
        contentBlocks: [],
        metadata: { sessionId: 'task-cancel-mid-defer', sequence: 2 },
        payload: {
          queuedMessages: [],
          cause: 'delete',
        },
      });

      expect(manager.getStatus().phase).toBe('stopped');
      expect(manager.getStatus().taskStateEvent).toBe(
        TaskEventName.TaskAborted,
      );
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('stays running until queued runtime follow-ups drain after completion', () => {
    const onExit = vi.fn();
    const { harness, manager } = createManager({ onExit });

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-queued'],
      } as TaskEvent);

      harness.emitRuntimeOutput({
        id: 'task-queued:1',
        ts: Date.now(),
        eventType: 'roomote_runtime.queued_messages_update',
        role: 'assistant',
        kind: 'unknown',
        contentBlocks: [],
        metadata: { sessionId: 'task-queued', sequence: 1 },
        payload: {
          queuedMessages: [{ id: 'q-1', text: 'follow-up', timestamp: 1 }],
        },
      });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'task-queued',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('running');
      expect(manager.getStatus().taskStateEvent).toBeNull();
      expect(manager.getState().taskFinishedAt).toBeUndefined();
      expect(onExit).not.toHaveBeenCalled();

      harness.emitRuntimeOutput({
        id: 'task-queued:2',
        ts: Date.now(),
        eventType: 'roomote_runtime.queued_messages_update',
        role: 'assistant',
        kind: 'unknown',
        contentBlocks: [],
        metadata: { sessionId: 'task-queued', sequence: 2 },
        payload: {
          queuedMessages: [],
          cause: 'dequeue',
        },
      });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'task-queued',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('waiting_for_prompt');
      expect(manager.getState().taskFinishedAt).toBeDefined();
      expect(onExit).toHaveBeenCalledTimes(1);
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('finalizes deferred completion when queued prompts are deleted before another turn starts', () => {
    const onExit = vi.fn();
    const { harness, manager } = createManager({ onExit });

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-delete'],
      } as TaskEvent);

      harness.emitRuntimeOutput({
        id: 'task-delete:1',
        ts: Date.now(),
        eventType: 'roomote_runtime.queued_messages_update',
        role: 'assistant',
        kind: 'unknown',
        contentBlocks: [],
        metadata: { sessionId: 'task-delete', sequence: 1 },
        payload: {
          queuedMessages: [{ id: 'q-1', text: 'follow-up', timestamp: 1 }],
        },
      });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'task-delete',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('running');
      expect(onExit).not.toHaveBeenCalled();

      harness.emitRuntimeOutput({
        id: 'task-delete:2',
        ts: Date.now(),
        eventType: 'roomote_runtime.queued_messages_update',
        role: 'assistant',
        kind: 'unknown',
        contentBlocks: [],
        metadata: { sessionId: 'task-delete', sequence: 2 },
        payload: {
          queuedMessages: [],
          cause: 'delete',
        },
      });

      expect(manager.getStatus().phase).toBe('waiting_for_prompt');
      expect(onExit).toHaveBeenCalledTimes(1);
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('does not defer completion or keepalive for queue-only runtime prompts', () => {
    vi.useFakeTimers();

    const onExit = vi.fn();
    const { harness, manager } = createManager({ onExit });

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-queue-only'],
      } as TaskEvent);

      harness.emitRuntimeOutput({
        id: 'task-queue-only:1',
        ts: Date.now(),
        eventType: 'roomote_runtime.queued_messages_update',
        role: 'assistant',
        kind: 'unknown',
        contentBlocks: [],
        metadata: { sessionId: 'task-queue-only', sequence: 1 },
        payload: {
          queuedMessages: [
            {
              id: 'q-1',
              text: 'background context',
              queueOnly: true,
              timestamp: 1,
            },
          ],
        },
      });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'task-queue-only',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('waiting_for_prompt');
      expect(manager.getState().taskFinishedAt).toBeDefined();
      expect(onExit).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60_000);
      expect(manager.getStatus().phase).toBe('shutting_down');
    } finally {
      vi.useRealTimers();
      manager.dispose();
      harness.dispose();
    }
  });
});

describe('HarnessManager request_user_input phases', () => {
  it('enters waiting_for_user_input when the active task emits a request', () => {
    const { harness, manager } = createManager();

    try {
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-1'],
      } as TaskEvent);

      harness.emitRuntimeOutput({
        id: 'task-1:1',
        ts: 1,
        eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
        kind: 'unknown',
        role: 'assistant',
        contentBlocks: [],
        metadata: { sessionId: 'task-1', sequence: 1 },
        payload: {
          requestId: 'rui:task-1:turn-1:call-1',
          sessionId: 'task-1',
          turnId: 'turn-1',
          callId: 'call-1',
          status: 'pending',
          questions: [],
        },
      } as AcpMessage);

      expect(manager.getStatus().phase).toBe('waiting_for_user_input');
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('returns to running when a pending request_user_input response arrives', () => {
    const { harness, manager } = createManager();

    try {
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-1'],
      } as TaskEvent);

      harness.pendingUserInputRequests = [
        {
          requestId: 'rui:task-1:turn-1:call-1',
          sessionId: 'task-1',
          turnId: 'turn-1',
          callId: 'call-1',
          status: 'pending',
          ts: 1,
          questions: [],
        },
      ];

      harness.emitRuntimeOutput({
        id: 'task-1:1',
        ts: 1,
        eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
        kind: 'unknown',
        role: 'assistant',
        contentBlocks: [],
        metadata: { sessionId: 'task-1', sequence: 1 },
        payload: {
          requestId: 'rui:task-1:turn-1:call-1',
          sessionId: 'task-1',
          turnId: 'turn-1',
          callId: 'call-1',
          status: 'pending',
          questions: [],
        },
      } as AcpMessage);

      harness.pendingUserInputRequests = [];

      harness.emitRuntimeOutput({
        id: 'task-1:2',
        ts: 2,
        eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse,
        kind: 'unknown',
        role: 'user',
        contentBlocks: [],
        metadata: { sessionId: 'task-1', sequence: 2 },
        payload: {
          requestId: 'rui:task-1:turn-1:call-1',
          sessionId: 'task-1',
          turnId: 'turn-1',
          callId: 'call-1',
          answers: {},
          resolution: 'submitted',
        },
      } as AcpMessage);

      expect(manager.getStatus().phase).toBe('running');
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });
});

describe('HarnessManager cancelTaskAndWaitForTurnExit', () => {
  it('waits for taskAborted before resolving true', async () => {
    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-1'],
      } as TaskEvent);

      const waitForTurnExitPromise = manager.cancelTaskAndWaitForTurnExit({
        timeoutMs: 200,
      });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskAborted,
        payload: ['task-1'],
      } as TaskEvent);

      await expect(waitForTurnExitPromise).resolves.toBe(true);
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('returns false when no active task can be canceled', async () => {
    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();

      await expect(manager.cancelTaskAndWaitForTurnExit()).resolves.toBe(false);
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('clears cancel marker when sending a follow-up after cancellation', () => {
    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-1'],
      } as TaskEvent);

      manager.cancelTask();

      expect(manager.getStatus().phase).toBe('stopped');
      expect(manager.getState().cancelTriggeredAt).toBeDefined();

      const sent = manager.sendFollowUpPrompt({ prompt: 'steer now' });

      expect(sent).toBe(true);
      expect(manager.getStatus().phase).toBe('running');
      expect(manager.getState().cancelTriggeredAt).toBeUndefined();
      expect(harness.sentCommands.at(-1)?.commandName).toBe(
        TaskCommandName.SendMessage,
      );
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('does not reactivate a completed task after shutdown has started', () => {
    vi.useFakeTimers();

    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-shutdown-guard'],
      } as TaskEvent);
      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'task-shutdown-guard',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('waiting_for_prompt');
      expect(manager.getState().taskFinishedAt).toBeDefined();

      vi.advanceTimersByTime(60_000);

      expect(manager.getStatus().phase).toBe('shutting_down');

      const taskFinishedAt = manager.getState().taskFinishedAt;
      const sent = manager.sendFollowUpPrompt({ prompt: 'late retry' });

      expect(sent).toBe(false);
      expect(manager.getStatus().phase).toBe('shutting_down');
      expect(manager.getState().taskFinishedAt).toBe(taskFinishedAt);
      expect(
        harness.sentCommands.some(
          (command) =>
            command.commandName === TaskCommandName.SendMessage &&
            (command.data as { text?: string } | undefined)?.text ===
              'late retry',
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
      manager.dispose();
      harness.dispose();
    }
  });
});

describe('HarnessManager resumeCurrentTask', () => {
  it('resumes a stopped task and transitions to idle without sending commands', () => {
    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-1'],
      } as TaskEvent);

      manager.cancelTask();
      expect(manager.getStatus().phase).toBe('stopped');
      const commandCountBeforeResume = harness.sentCommands.length;

      const resumed = manager.resumeCurrentTask();

      expect(resumed).toBe(true);
      expect(manager.getStatus().phase).toBe('idle');
      expect(harness.sentCommands).toHaveLength(commandCountBeforeResume);
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('returns false when task is not stopped', () => {
    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();
      const resumed = manager.resumeCurrentTask();
      expect(resumed).toBe(false);
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });
});

describe('HarnessManager resumeTask promotion', () => {
  it('promotes idle to running on resumed parent message events', () => {
    const { harness, manager } = createManager();

    try {
      manager.resumeTask('task-resume-message');
      expect(manager.getStatus().phase).toBe('waiting_for_prompt');

      harness.emitTaskEvent({
        eventName: TaskEventName.Message,
        payload: [
          {
            taskId: 'task-resume-message',
            message: {
              ts: Date.now(),
              type: 'say',
              say: 'text',
              text: 'hello',
              partial: false,
            },
          },
        ],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('running');
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('tracks assistant Roomote runtime output as parent message activity', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-19T12:00:00.000Z'));

    const { harness, manager } = createManager();

    try {
      manager.resumeTask('task-resume-acp-output');
      expect(manager.getState().lastMessageAt).toBeUndefined();

      harness.emitRuntimeOutput({
        id: 'acp-output-1',
        ts: Date.now(),
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk,
        role: 'assistant',
        kind: 'text',
        contentBlocks: [{ type: 'text', text: 'still working' }],
        metadata: { sessionId: 'task-resume-acp-output' },
        payload: { sessionId: 'task-resume-acp-output', text: 'still working' },
      });

      expect(manager.getState().lastMessageAt).toBe(Date.now());
    } finally {
      manager.dispose();
      harness.dispose();
      vi.useRealTimers();
    }
  });

  it('refreshes the idle shutdown timer when assistant Roomote runtime output arrives while prompt-ready', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-19T12:00:00.000Z'));

    const { harness, manager } = createManager({ keepaliveMs: 60_000 });
    const onStateChange = vi.fn();
    manager.on('stateChange', onStateChange);

    try {
      manager.resumeTask('task-resume-acp-output-timer');
      onStateChange.mockClear();

      vi.advanceTimersByTime(10_000);

      harness.emitRuntimeOutput({
        id: 'acp-output-2',
        ts: Date.now(),
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk,
        role: 'assistant',
        kind: 'text',
        contentBlocks: [{ type: 'text', text: 'still working' }],
        metadata: { sessionId: 'task-resume-acp-output-timer' },
        payload: {
          sessionId: 'task-resume-acp-output-timer',
          text: 'still working',
        },
      });

      expect(onStateChange).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(51_000);
      expect(manager.getStatus().phase).toBe('waiting_for_prompt');

      vi.advanceTimersByTime(10_000);
      expect(manager.getStatus().phase).toBe('shutting_down');
    } finally {
      manager.dispose();
      harness.dispose();
      vi.useRealTimers();
    }
  });
});

describe('HarnessManager task ID reconciliation', () => {
  it('reconciles preallocated ID to runtime task ID on taskStarted', () => {
    const { harness, manager, logger } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({
        prompt: 'hello',
        taskId: 'preallocated-id',
      });

      expect(manager.getStatus().sessionId).toBe('preallocated-id');

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['runtime-task-id'],
      } as TaskEvent);

      expect(manager.getStatus().sessionId).toBe('runtime-task-id');
      expect(logger.warn).toHaveBeenCalledWith(
        '[HarnessManager] Reconciled task ID from preallocated-id to runtime-task-id',
      );

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'runtime-task-id',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('waiting_for_prompt');
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });
});

describe('HarnessManager async callback safety', () => {
  it('logs rejected onStart callbacks instead of leaking an unhandled rejection', async () => {
    const { harness, manager, logger } = createManager({
      onStart: vi.fn().mockRejectedValue(new Error('start callback failed')),
    });

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-1'],
      } as TaskEvent);

      await Promise.resolve();

      expect(manager.getStatus().sessionId).toBe('task-1');
      expect(logger.warn).toHaveBeenCalledWith(
        '[HarnessManager] onStart callback failed: start callback failed',
      );
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('logs rejected completion callbacks instead of leaking an unhandled rejection', async () => {
    const { harness, manager, logger } = createManager({
      onExit: vi.fn().mockRejectedValue(new Error('exit callback failed')),
      onTaskUpdate: vi
        .fn()
        .mockRejectedValue(new Error('task update callback failed')),
    });

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-1'],
      } as TaskEvent);
      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'task-1',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      await Promise.resolve();

      expect(manager.getStatus().phase).toBe('waiting_for_prompt');
      expect(logger.warn).toHaveBeenCalledWith(
        '[HarnessManager] onExit callback failed: exit callback failed',
      );
      expect(logger.warn).toHaveBeenCalledWith(
        '[HarnessManager] onTaskUpdate callback failed: task update callback failed',
      );
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });
});

describe('HarnessManager touchKeepalive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('extends keepalive remaining time when in waiting_for_prompt', () => {
    const { harness, manager } = createManager();

    try {
      // Start and complete a task to get into waiting_for_prompt
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-1'],
      } as TaskEvent);
      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'task-1',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('waiting_for_prompt');

      // Advance time by 30 seconds
      vi.advanceTimersByTime(30_000);

      const remainingBefore = manager.getKeepaliveRemainingMs();
      expect(remainingBefore).toBeLessThanOrEqual(30_000);

      // Touch keepalive
      manager.touchKeepalive();

      // Remaining should be back near the full keepalive duration
      const remainingAfter = manager.getKeepaliveRemainingMs();
      expect(remainingAfter).toBeGreaterThan(remainingBefore!);
      expect(remainingAfter).toBeGreaterThan(59_000);
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('uses the keepalive window for an idle session before any task has run', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-19T12:00:00.000Z'));

    const { harness, manager } = createManager({
      keepaliveMs: 30 * 60 * 1_000,
      sandboxTimeoutMs: 5 * 60 * 60 * 1_000,
    });

    try {
      manager.initializeWithoutPrompt();

      const sleepAt = manager.getSleepAt();

      expect(sleepAt).not.toBeNull();
      expect((sleepAt ?? 0) - Date.now()).toBeLessThanOrEqual(30 * 60 * 1_000);
      expect((sleepAt ?? 0) - Date.now()).toBeGreaterThan(29 * 60 * 1_000);

      vi.advanceTimersByTime(30_000);

      expect(manager.getSleepAt()).toBe(sleepAt);
      expect(manager.getKeepaliveRemainingMs()).toBe(29.5 * 60 * 1_000);
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('enters waiting_for_prompt before invoking onExit on task completion', async () => {
    let managerRef: HarnessManager | null = null;
    const onExit = vi.fn(async () => {
      expect(managerRef?.getStatus().phase).toBe('waiting_for_prompt');
    });
    const { harness, manager } = createManager({ onExit });
    managerRef = manager;

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-on-exit-order'],
      } as TaskEvent);

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'task-on-exit-order',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      await Promise.resolve();

      expect(onExit).toHaveBeenCalledTimes(1);
      expect(manager.getStatus().phase).toBe('waiting_for_prompt');
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('is a no-op when in running phase', () => {
    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      expect(manager.getStatus().phase).toBe('running');

      // Should not throw and the keepalive expiry stays null while running.
      manager.touchKeepalive();
      expect(manager.getKeepaliveRemainingMs()).toBeNull();
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('prevents shutdown when touched before timer expires', () => {
    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-1'],
      } as TaskEvent);
      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'task-1',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('waiting_for_prompt');

      // Advance to 50 seconds (keepalive is 60s)
      vi.advanceTimersByTime(50_000);
      expect(manager.getStatus().phase).toBe('waiting_for_prompt');

      // Touch keepalive to push the timer forward
      manager.touchKeepalive();

      // Advance 50 more seconds — would have exceeded original 60s,
      // but the touch should have extended it
      vi.advanceTimersByTime(50_000);
      expect(manager.getStatus().phase).toBe('waiting_for_prompt');

      // Advance the remaining 10s to exceed the new 60s window
      vi.advanceTimersByTime(10_000);
      expect(manager.getStatus().phase).toBe('shutting_down');
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('defers shutdown while runtime queued prompts are non-empty', () => {
    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-1'],
      } as TaskEvent);

      harness.emitRuntimeOutput({
        id: 'task-1:1',
        ts: Date.now(),
        eventType: 'roomote_runtime.queued_messages_update',
        role: 'assistant',
        kind: 'unknown',
        contentBlocks: [],
        metadata: { sessionId: 'task-1', sequence: 1 },
        payload: {
          queuedMessages: [{ id: 'q-1', text: 'follow-up', timestamp: 1 }],
        },
      });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'task-1',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('running');

      // Keepalive should not fire while queued runtime prompts exist.
      vi.advanceTimersByTime(60_000);
      expect(manager.getStatus().phase).toBe('running');

      // Queue drains, but the worker only becomes idle after the queued turn
      // itself finishes.
      harness.emitRuntimeOutput({
        id: 'task-1:2',
        ts: Date.now(),
        eventType: 'roomote_runtime.queued_messages_update',
        role: 'assistant',
        kind: 'unknown',
        contentBlocks: [],
        metadata: { sessionId: 'task-1', sequence: 2 },
        payload: {
          queuedMessages: [],
          cause: 'clear',
        },
      });

      // Since keepalive already elapsed while queued prompts prevented the
      // prior completion from finalizing, clearing the queue should allow
      // immediate transition into waiting_for_prompt and shutdown.
      expect(manager.getStatus().phase).toBe('waiting_for_prompt');
      vi.runOnlyPendingTimers();
      expect(manager.getStatus().phase).toBe('shutting_down');
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('caps the visible sleep deadline to the hard sandbox cutoff', () => {
    const { harness, manager } = createManager({
      keepaliveMs: 60 * 60 * 1_000,
      sandboxTimeoutMs: 20 * 60 * 1_000,
    });

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-hard-cutoff'],
      } as TaskEvent);
      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'task-hard-cutoff',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      const remaining = manager.getKeepaliveRemainingMs();
      expect(remaining).not.toBeNull();
      expect(remaining).toBeLessThanOrEqual(10 * 60 * 1_000);
      expect(remaining).toBeGreaterThan(9 * 60 * 1_000);
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('keeps extending sleepAt while the task is active and stops once idle', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-19T12:00:00.000Z'));

    const { harness, manager } = createManager({
      keepaliveMs: 60_000,
      sandboxTimeoutMs: 20 * 60 * 1_000,
    });

    const onStateChange = vi.fn();
    manager.on('stateChange', onStateChange);

    try {
      manager.initializeWithoutPrompt();
      onStateChange.mockClear();

      manager.startNewTask({ prompt: 'hello' });
      onStateChange.mockClear();

      let remaining = manager.getSleepAt();
      expect(remaining).not.toBeNull();
      expect((remaining ?? 0) - Date.now()).toBeLessThanOrEqual(60_000);
      expect((remaining ?? 0) - Date.now()).toBeGreaterThan(59_000);

      vi.advanceTimersByTime(44_000);
      expect(onStateChange).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1_000);
      expect(onStateChange).toHaveBeenCalledTimes(1);

      remaining = manager.getSleepAt();
      expect((remaining ?? 0) - Date.now()).toBeLessThanOrEqual(60_000);
      expect((remaining ?? 0) - Date.now()).toBeGreaterThan(59_000);

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-heartbeat'],
      } as TaskEvent);
      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'task-heartbeat',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('waiting_for_prompt');
      onStateChange.mockClear();

      vi.advanceTimersByTime(45_000);
      expect(onStateChange).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      manager.dispose();
      harness.dispose();
    }
  });

  it('uses a minimum active sleep window when the idle keepalive is zero', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-19T12:00:00.000Z'));

    const { harness, manager } = createManager({
      keepaliveMs: 0,
      sandboxTimeoutMs: 20 * 60 * 1_000,
    });

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTask({ prompt: 'hello' });

      const activeSleepAt = manager.getSleepAt();
      expect(activeSleepAt).not.toBeNull();
      expect((activeSleepAt ?? 0) - Date.now()).toBeLessThanOrEqual(60_000);
      expect((activeSleepAt ?? 0) - Date.now()).toBeGreaterThan(59_000);

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-zero-keepalive'],
      } as TaskEvent);
      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'task-zero-keepalive',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('waiting_for_prompt');

      const idleSleepAt = manager.getSleepAt();
      expect(idleSleepAt).not.toBeNull();
      expect(Math.abs((idleSleepAt ?? 0) - Date.now())).toBeLessThan(1_000);
    } finally {
      manager.dispose();
      harness.dispose();
      vi.useRealTimers();
    }
  });

  it('uses the absolute sandbox expiry when provided', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-19T12:00:00.000Z'));

    const { harness, manager } = createManager({
      keepaliveMs: 60 * 60 * 1_000,
      sandboxTimeoutMs: 4 * 60 * 60 * 1_000,
      sandboxExpiresAtMs:
        Date.parse('2026-03-19T12:00:00.000Z') + 15 * 60 * 1_000,
    });

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-absolute-expiry'],
      } as TaskEvent);
      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'task-absolute-expiry',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      const remaining = manager.getKeepaliveRemainingMs();
      expect(remaining).not.toBeNull();
      expect(remaining).toBeLessThanOrEqual(5 * 60 * 1_000);
      expect(remaining).toBeGreaterThan(4 * 60 * 1_000);
    } finally {
      vi.useRealTimers();
      manager.dispose();
      harness.dispose();
    }
  });

  it('starts heartbeat on entering running phase and clears on entering waiting_for_prompt', () => {
    vi.setSystemTime(new Date('2026-03-19T12:00:00.000Z'));

    const { harness, manager } = createManager({
      keepaliveMs: 60_000,
      sandboxTimeoutMs: 20 * 60 * 1_000,
    });

    const onStateChange = vi.fn();
    manager.on('stateChange', onStateChange);

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTask({ prompt: 'hello' });
      onStateChange.mockClear();

      // First heartbeat at 45s
      vi.advanceTimersByTime(45_000);
      expect(onStateChange).toHaveBeenCalledTimes(1);

      // Second heartbeat at 90s
      vi.advanceTimersByTime(45_000);
      expect(onStateChange).toHaveBeenCalledTimes(2);

      // Third heartbeat at 135s
      vi.advanceTimersByTime(45_000);
      expect(onStateChange).toHaveBeenCalledTimes(3);

      // Complete task → transitions to waiting_for_prompt, heartbeat should stop
      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-heartbeat-multi'],
      } as TaskEvent);
      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'task-heartbeat-multi',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('waiting_for_prompt');
      onStateChange.mockClear();

      // No more heartbeat emissions after 45s
      vi.advanceTimersByTime(45_000);
      expect(onStateChange).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('restarts heartbeat when a new task starts after idle', () => {
    vi.setSystemTime(new Date('2026-03-19T12:00:00.000Z'));

    const { harness, manager } = createManager({
      keepaliveMs: 60_000,
      sandboxTimeoutMs: 20 * 60 * 1_000,
    });

    const onStateChange = vi.fn();
    manager.on('stateChange', onStateChange);

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTask({ prompt: 'first task' });

      // Complete first task
      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-restart-1'],
      } as TaskEvent);
      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'task-restart-1',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('waiting_for_prompt');
      onStateChange.mockClear();

      // Verify no heartbeat in waiting_for_prompt
      vi.advanceTimersByTime(45_000);
      expect(onStateChange).not.toHaveBeenCalled();

      // Start second task
      manager.startNewTaskFromPrompt({ prompt: 'second task' });
      onStateChange.mockClear();

      // Heartbeat should resume
      vi.advanceTimersByTime(45_000);
      expect(onStateChange).toHaveBeenCalledTimes(1);
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('heartbeat emits stateChange that advances getSleepAt during active phase', () => {
    vi.setSystemTime(new Date('2026-03-19T12:00:00.000Z'));

    const { harness, manager } = createManager({
      keepaliveMs: 60_000,
      sandboxTimeoutMs: 20 * 60 * 1_000,
    });

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTask({ prompt: 'hello' });

      const sleepAtBefore = manager.getSleepAt();
      expect(sleepAtBefore).not.toBeNull();

      vi.advanceTimersByTime(45_000);

      const sleepAtAfter = manager.getSleepAt();
      expect(sleepAtAfter).not.toBeNull();
      expect(sleepAtAfter!).toBeGreaterThan(sleepAtBefore!);
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('does not start heartbeat during waiting_for_prompt phase', () => {
    vi.setSystemTime(new Date('2026-03-19T12:00:00.000Z'));

    const { harness, manager } = createManager({
      keepaliveMs: 10 * 60 * 1_000,
      sandboxTimeoutMs: 20 * 60 * 1_000,
    });

    const onStateChange = vi.fn();
    manager.on('stateChange', onStateChange);

    try {
      manager.initializeWithoutPrompt();
      // Now in waiting_for_prompt phase
      expect(manager.getStatus().phase).toBe('waiting_for_prompt');
      onStateChange.mockClear();

      vi.advanceTimersByTime(45_000);
      expect(onStateChange).not.toHaveBeenCalled();

      vi.advanceTimersByTime(45_000);
      expect(onStateChange).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('getSleepAt returns null for stopped phase', () => {
    vi.setSystemTime(new Date('2026-03-19T12:00:00.000Z'));

    const { harness, manager } = createManager({
      keepaliveMs: 60_000,
      sandboxTimeoutMs: 20 * 60 * 1_000,
    });

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTask({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-stop-1'],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('running');
      expect(manager.getSleepAt()).not.toBeNull();

      manager.cancelTask();
      expect(manager.getStatus().phase).toBe('stopped');
      expect(manager.getSleepAt()).toBeNull();
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('getSleepAt returns approximately Date.now() for shutting_down phase', () => {
    vi.setSystemTime(new Date('2026-03-19T12:00:00.000Z'));

    const { harness, manager } = createManager({
      keepaliveMs: 1_000, // very short keepalive to trigger shutdown quickly
      sandboxTimeoutMs: 20 * 60 * 1_000,
    });

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-shutdown-1'],
      } as TaskEvent);
      harness.emitTaskEvent({
        eventName: TaskEventName.TaskCompleted,
        payload: [
          'task-shutdown-1',
          {
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalCost: 0,
            contextTokens: 0,
          },
          {},
          { isSubtask: false },
        ],
      } as TaskEvent);

      expect(manager.getStatus().phase).toBe('waiting_for_prompt');

      // Advance past the keepalive to trigger shutdown
      vi.advanceTimersByTime(2_000);
      expect(manager.getStatus().phase).toBe('shutting_down');

      const sleepAt = manager.getSleepAt();
      expect(sleepAt).not.toBeNull();
      // shutting_down returns Date.now(), so it should be approximately the current time
      expect(Math.abs(sleepAt! - Date.now())).toBeLessThan(1_000);
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });
});

describe('HarnessManager error status', () => {
  it('shuts down when the harness disconnects during an active task', async () => {
    const { harness, manager } = createManager({
      runId: 51,
      taskId: 'task-harness-disconnect',
    });
    const onStateChange = vi.fn();
    manager.on('stateChange', onStateChange);

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-disconnect'],
      } as TaskEvent);

      onStateChange.mockClear();
      harness.connected = false;
      harness.emit('disconnected');

      await expect(manager.waitForShutdown()).resolves.toMatchObject({
        sessionId: 'task-disconnect',
        lastErrorMessage:
          'Harness disconnected unexpectedly before task completion',
      });
      expect(onStateChange).toHaveBeenCalledTimes(2);
      expect(manager.getStatus()).toMatchObject({
        phase: 'shutting_down',
        isConnected: false,
        lastErrorMessage:
          'Harness disconnected unexpectedly before task completion',
      });
      expect(manager.getState().clientDisconnectedAt).toBeDefined();
      expect(captureWorkerMessageMock).toHaveBeenCalledWith(
        'Harness exhausted reconnect attempts and is shutting down the sandbox runtime',
        expect.objectContaining({
          runId: 51,
          taskId: 'task-harness-disconnect',
          runtimeTaskId: 'task-disconnect',
          taskPhase: 'running',
        }),
        expect.objectContaining({
          component: 'harness-manager',
          signal: 'harness-reconnect-exhausted',
        }),
      );
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('shuts down when the harness disconnects while waiting for user input', async () => {
    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-rui-disconnect'],
      } as TaskEvent);
      harness.emitRuntimeOutput({
        id: 'task-rui-disconnect:1',
        ts: 1,
        eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
        kind: 'unknown',
        role: 'assistant',
        contentBlocks: [],
        metadata: { sessionId: 'task-rui-disconnect', sequence: 1 },
        payload: {
          requestId: 'rui:task-rui-disconnect:turn-1:call-1',
          sessionId: 'task-rui-disconnect',
          turnId: 'turn-1',
          callId: 'call-1',
          status: 'pending',
          questions: [],
        },
      } as AcpMessage);

      expect(manager.getStatus().phase).toBe('waiting_for_user_input');

      harness.connected = false;
      harness.emit('disconnected');

      await expect(manager.waitForShutdown()).resolves.toMatchObject({
        sessionId: 'task-rui-disconnect',
      });
      expect(manager.getStatus()).toMatchObject({
        phase: 'shutting_down',
        isConnected: false,
        lastErrorMessage:
          'Harness disconnected unexpectedly before task completion',
      });
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('surfaces provider errors through getStatus()', () => {
    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-error'],
      } as TaskEvent);

      harness.emitTaskEvent({
        eventName: TaskEventName.Message,
        payload: [
          {
            taskId: 'task-error',
            message: {
              ts: Date.now(),
              type: 'say',
              say: 'error',
              text: 'unexpected status 401 Unauthorized: proxy token rejected',
              partial: false,
            },
          },
        ],
      } as TaskEvent);

      expect(manager.getStatus().lastErrorMessage).toBe(
        'unexpected status 401 Unauthorized: proxy token rejected',
      );
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('clears lastErrorMessage when a follow-up prompt is sent successfully', () => {
    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });

      harness.emitTaskEvent({
        eventName: TaskEventName.TaskStarted,
        payload: ['task-error-clear'],
      } as TaskEvent);

      harness.emitTaskEvent({
        eventName: TaskEventName.Message,
        payload: [
          {
            taskId: 'task-error-clear',
            action: 'created',
            message: {
              ts: Date.now(),
              type: 'say',
              say: 'error',
              text: 'temporary glitch',
            },
          },
        ],
      } as TaskEvent);

      expect(manager.getStatus().lastErrorMessage).toBeDefined();
      manager.sendFollowUpPrompt({ prompt: 'retry' });
      expect(manager.getStatus().lastErrorMessage).toBeUndefined();
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('shuts down terminally when StartNewTask fails asynchronously', async () => {
    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });
      expect(manager.getStatus().phase).toBe('running');

      harness.emitCommandError({
        command: {
          commandName: TaskCommandName.StartNewTask,
          data: { text: 'hello' },
        },
        error: new Error(
          'OpenCode session creation did not respond within 90s',
        ),
      });

      await expect(manager.waitForShutdown()).resolves.toMatchObject({
        lastErrorMessage:
          'OpenCode session creation did not respond within 90s',
        taskAbortedAt: undefined,
        taskFinishedAt: undefined,
      });
      expect(manager.getStatus()).toMatchObject({
        phase: 'shutting_down',
        lastErrorMessage:
          'OpenCode session creation did not respond within 90s',
      });
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });

  it('still shuts down when StartNewTask fails after cancel before a session exists', async () => {
    const { harness, manager } = createManager();

    try {
      manager.initializeWithoutPrompt();
      manager.startNewTaskFromPrompt({ prompt: 'hello' });
      expect(manager.getStatus().phase).toBe('running');
      expect(manager.getStatus().sessionId).toBeUndefined();

      // Cancel before OpenCode invents a session id — CancelTask is a no-op on
      // the runtime side because there is nothing to abort yet.
      manager.cancelTask();
      expect(manager.getStatus().phase).toBe('stopped');
      expect(manager.getSleepAt()).toBeNull();
      expect(manager.getState().cancelTriggeredAt).toBeDefined();

      harness.emitCommandError({
        command: {
          commandName: TaskCommandName.StartNewTask,
          data: { text: 'hello' },
        },
        error: new Error(
          'OpenCode session creation did not respond within 90s',
        ),
      });

      const finalState = await manager.waitForShutdown();
      expect(finalState.taskAbortedAt).toBe(finalState.cancelTriggeredAt);
      expect(finalState.taskFinishedAt).toBeUndefined();
      expect(manager.getStatus().phase).toBe('shutting_down');
      // User cancel wins for report status; do not rewrite it as Failed.
      expect(manager.getStatus().lastErrorMessage).toBeUndefined();
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });
});
