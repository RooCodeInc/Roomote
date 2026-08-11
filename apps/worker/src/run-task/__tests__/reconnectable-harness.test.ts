import EventEmitter from 'node:events';

import { TaskCommandName } from '../../sandbox-server/lib/harness';
import type {
  Harness,
  HarnessEvents,
  HarnessPendingUserInputRequest,
  QueuedPromptMessageSnapshot,
  TaskCommand,
} from '../../sandbox-server/lib/harness';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  TaskEventName,
  type AcpMessage,
  type TaskEvent,
} from '@roomote/types';

import { ReconnectableHarness } from '../reconnectable-harness';

function createLogger() {
  return {
    runId: 1,
    filePath: '/tmp/test.log',
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createSubprocess() {
  return Object.assign(new Promise<never>(() => undefined), {
    kill: vi.fn(() => true),
  }) as never as Promise<never> & { kill: ReturnType<typeof vi.fn> };
}

class FakeHarness extends EventEmitter<HarnessEvents> implements Harness {
  readonly sentCommands: TaskCommand[] = [];
  connected = true;
  currentWorkflowPhase: string | null = null;
  activeModel: string | null = null;
  launchModel: string | null = null;
  switchableModels: string[] = [];
  pendingUserInputRequests: HarnessPendingUserInputRequest[] = [];
  queuedMessageSnapshots: QueuedPromptMessageSnapshot[] = [];
  sendCommandImpl?: (command: TaskCommand) => boolean;

  subscribe(listener: (event: TaskEvent) => void): () => void {
    this.on('taskEvent', listener);
    return () => this.off('taskEvent', listener);
  }

  subscribeRuntimeOutput(listener: (event: AcpMessage) => void): () => void {
    this.on('runtimeOutput', listener);
    return () => this.off('runtimeOutput', listener);
  }

  subscribeRuntimePersistedEnvelope(): () => void {
    return () => {};
  }

  subscribeRuntimeTurnCompleted(): () => void {
    return () => {};
  }

  sendCommand(command: TaskCommand): boolean {
    if (this.sendCommandImpl) {
      return this.sendCommandImpl(command);
    }

    if (!this.connected) {
      return false;
    }

    this.sentCommands.push(command);
    return true;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get supportsNativeTurnSteering(): boolean {
    return false;
  }

  getPendingUserInputRequests(): HarnessPendingUserInputRequest[] {
    return this.pendingUserInputRequests;
  }

  getQueuedMessageSnapshots(): QueuedPromptMessageSnapshot[] {
    return this.queuedMessageSnapshots.map((message) => ({
      ...message,
      ...(message.images ? { images: [...message.images] } : {}),
    }));
  }

  getCurrentWorkflowPhase(): string | null {
    return this.currentWorkflowPhase;
  }

  getActiveModel(): string | null {
    return this.activeModel;
  }

  getLaunchModel(): string | null {
    return this.launchModel;
  }

  getSwitchableModels(): string[] {
    return this.switchableModels;
  }

  dispose(): void {
    this.connected = false;
  }
}

function createWrappedToolResultOutput(
  payload: Record<string, unknown>,
): string {
  return JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: null,
    _meta: null,
  });
}

describe('ReconnectableHarness', () => {
  it('forwards model state from the current harness', async () => {
    const harness = new FakeHarness();
    harness.activeModel = 'provider/active';
    harness.launchModel = 'provider/launch';
    harness.switchableModels = ['provider/launch', 'provider/active'];

    const reconnectableHarness = new ReconnectableHarness({
      logger: createLogger(),
      spawnHarness: async () => ({
        harness,
        subprocess: createSubprocess() as never,
      }),
    });

    await reconnectableHarness.start();

    expect(reconnectableHarness.getActiveModel()).toBe('provider/active');
    expect(reconnectableHarness.getLaunchModel()).toBe('provider/launch');
    expect(reconnectableHarness.getSwitchableModels()).toEqual([
      'provider/launch',
      'provider/active',
    ]);
  });

  it('tracks pending env-var requests from persisted MCP tool results', async () => {
    const harness = new FakeHarness();

    const reconnectableHarness = new ReconnectableHarness({
      logger: createLogger(),
      spawnHarness: async () => ({
        harness,
        subprocess: createSubprocess() as never,
      }),
    });

    await reconnectableHarness.start();

    harness.emit('runtimePersistedEnvelope', {
      ts: 101,
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
      role: 'tool',
      protocol: 'roomote_runtime',
      contentBlocks: [],
      metadata: null,
      payload: {
        toolCallId: 'tool-call-env-1',
        isMcp: true,
        toolName: 'request_environment_variables',
        mcpToolName: 'request_environment_variables',
        output: JSON.stringify({
          success: true,
          requestCreated: true,
          requestedNames: ['OPENAI_API_KEY'],
        }),
      },
    });

    expect(reconnectableHarness.getPendingEnvVarRequest()).toEqual({
      key: 'tool-call-env-1',
      ts: 101,
      variables: [{ name: 'OPENAI_API_KEY' }],
    });

    harness.emit('runtimePersistedEnvelope', {
      ts: 102,
      eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
      role: 'user',
      protocol: 'roomote_runtime',
      contentBlocks: [],
      metadata: null,
      payload: {
        clientMessageId: 'env-var-request-fulfilled:runtime-follow-up',
      },
    });

    expect(reconnectableHarness.getPendingEnvVarRequest()).toBeNull();
  });

  it('tracks pending env-var requests from wrapped MCP tool results', async () => {
    const harness = new FakeHarness();

    const reconnectableHarness = new ReconnectableHarness({
      logger: createLogger(),
      spawnHarness: async () => ({
        harness,
        subprocess: createSubprocess() as never,
      }),
    });

    await reconnectableHarness.start();

    harness.emit('runtimePersistedEnvelope', {
      ts: 101,
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
      role: 'tool',
      protocol: 'roomote_runtime',
      contentBlocks: [],
      metadata: null,
      payload: {
        toolCallId: 'tool-call-env-2',
        isMcp: true,
        toolName: 'request_environment_variables',
        mcpToolName: 'request_environment_variables',
        output: createWrappedToolResultOutput({
          success: true,
          requestCreated: true,
          requestedNames: ['ANTHROPIC_API_KEY'],
          taskStopRequested: true,
        }),
      },
    });

    expect(reconnectableHarness.getPendingEnvVarRequest()).toEqual({
      key: 'tool-call-env-2',
      ts: 101,
      variables: [{ name: 'ANTHROPIC_API_KEY' }],
    });
  });

  it('clears cached pending env-var requests when a task starts or closes', async () => {
    const harness = new FakeHarness();

    const reconnectableHarness = new ReconnectableHarness({
      logger: createLogger(),
      spawnHarness: async () => ({
        harness,
        subprocess: createSubprocess() as never,
      }),
    });

    await reconnectableHarness.start();

    harness.emit('runtimePersistedEnvelope', {
      ts: 101,
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
      role: 'tool',
      protocol: 'roomote_runtime',
      contentBlocks: [],
      metadata: null,
      payload: {
        toolCallId: 'tool-call-env-3',
        isMcp: true,
        toolName: 'request_environment_variables',
        mcpToolName: 'request_environment_variables',
        output: JSON.stringify({
          success: true,
          requestCreated: true,
          requestedNames: ['OPENAI_API_KEY'],
        }),
      },
    });

    expect(reconnectableHarness.getPendingEnvVarRequest()).toEqual({
      key: 'tool-call-env-3',
      ts: 101,
      variables: [{ name: 'OPENAI_API_KEY' }],
    });

    expect(
      reconnectableHarness.sendCommand({
        commandName: TaskCommandName.StartNewTask,
        data: { text: 'start another task' },
      }),
    ).toBe(true);
    expect(reconnectableHarness.getPendingEnvVarRequest()).toBeNull();

    harness.emit('runtimePersistedEnvelope', {
      ts: 102,
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
      role: 'tool',
      protocol: 'roomote_runtime',
      contentBlocks: [],
      metadata: null,
      payload: {
        toolCallId: 'tool-call-env-4',
        isMcp: true,
        toolName: 'request_environment_variables',
        mcpToolName: 'request_environment_variables',
        output: JSON.stringify({
          success: true,
          requestCreated: true,
          requestedNames: ['STRIPE_API_KEY'],
        }),
      },
    });

    expect(reconnectableHarness.getPendingEnvVarRequest()).toEqual({
      key: 'tool-call-env-4',
      ts: 102,
      variables: [{ name: 'STRIPE_API_KEY' }],
    });

    expect(
      reconnectableHarness.sendCommand({
        commandName: TaskCommandName.CloseTask,
      }),
    ).toBe(true);
    expect(reconnectableHarness.getPendingEnvVarRequest()).toBeNull();
  });

  it('forwards the current workflow phase from the active harness', async () => {
    const harness = new FakeHarness();
    harness.currentWorkflowPhase = 'implement-changes';

    const reconnectableHarness = new ReconnectableHarness({
      logger: createLogger(),
      spawnHarness: async () => ({
        harness,
        subprocess: createSubprocess() as never,
      }),
    });

    await reconnectableHarness.start();

    expect(reconnectableHarness.getCurrentWorkflowPhase()).toBe(
      'implement-changes',
    );

    harness.currentWorkflowPhase = 'review-code';

    expect(reconnectableHarness.getCurrentWorkflowPhase()).toBe('review-code');
  });

  it('preserves false for invalid non-replayable commands', async () => {
    const harness = new FakeHarness();
    harness.sendCommandImpl = (command) => {
      if (command.commandName === TaskCommandName.DeleteQueuedMessage) {
        return false;
      }

      harness.sentCommands.push(command);
      return true;
    };

    const spawnHarness = vi.fn().mockResolvedValue({
      harness,
      subprocess: new Promise<never>(() => undefined) as never,
    });

    const reconnectableHarness = new ReconnectableHarness({
      logger: createLogger(),
      spawnHarness,
    });

    await reconnectableHarness.start();

    const sent = reconnectableHarness.sendCommand({
      commandName: TaskCommandName.DeleteQueuedMessage,
      data: {
        id: 'queued:missing',
      },
    });

    expect(sent).toBe(false);
    expect(spawnHarness).toHaveBeenCalledTimes(1);
  });

  it('reconnects with the latest session id and flushes queued commands', async () => {
    const harnessOne = new FakeHarness();
    const harnessTwo = new FakeHarness();
    const subprocessOne = createSubprocess();
    const logger = createLogger();
    const reconnectDeferred = deferred<{
      harness: Harness;
      subprocess: Promise<never> | null;
    }>();

    const spawnHarness = vi
      .fn()
      .mockResolvedValueOnce({
        harness: harnessOne,
        subprocess: subprocessOne,
      })
      .mockImplementationOnce(
        async (options?: { initialSessionId?: string }) => {
          expect(options?.initialSessionId).toBe('session-recover');
          const result = await reconnectDeferred.promise;
          return result;
        },
      );

    const reconnectableHarness = new ReconnectableHarness({
      logger,
      spawnHarness: async (options) => {
        const result = await spawnHarness(options);
        return {
          harness: result.harness,
          subprocess: (result.subprocess ??
            (new Promise<never>(() => undefined) as never)) as never,
        };
      },
      maxReconnectAttempts: 1,
    });

    await reconnectableHarness.start({ initialSessionId: 'session-recover' });
    expect(reconnectableHarness.getLatestSessionId()).toBe('session-recover');

    harnessOne.connected = false;
    harnessOne.emit('disconnected');

    expect(subprocessOne.kill).toHaveBeenCalledWith('SIGTERM');
    expect(logger.info).toHaveBeenCalledWith(
      '[ReconnectableHarness] Terminated subprocess during disconnect cleanup sentSignal=true',
    );

    const sent = reconnectableHarness.sendCommand({
      commandName: TaskCommandName.SendMessage,
      data: { text: 'retry after reconnect' },
    });

    expect(sent).toBe(true);
    expect(harnessOne.sentCommands).toHaveLength(0);

    reconnectDeferred.resolve({
      harness: harnessTwo,
      subprocess: null,
    });
    await reconnectDeferred.promise;
    await vi.waitFor(() => {
      expect(harnessTwo.sentCommands).toContainEqual({
        commandName: TaskCommandName.SendMessage,
        data: { text: 'retry after reconnect' },
      });
    });
  });

  it('restores the latest queued-message snapshot and replays queue edits made while reconnecting', async () => {
    const harnessOne = new FakeHarness();
    harnessOne.queuedMessageSnapshots = [
      {
        id: 'runtime-queued-1',
        text: 'first queued prompt',
        timestamp: 1,
      },
      {
        id: 'runtime-queued-2',
        text: 'second queued prompt',
        timestamp: 2,
      },
      {
        id: 'runtime-queued-3',
        text: 'third queued prompt',
        timestamp: 3,
      },
    ];
    const harnessTwo = new FakeHarness();
    const reconnectDeferred = deferred<{
      harness: Harness;
      subprocess: Promise<never> | null;
    }>();

    const spawnHarness = vi
      .fn()
      .mockResolvedValueOnce({
        harness: harnessOne,
        subprocess: null,
      })
      .mockImplementationOnce(async () => await reconnectDeferred.promise);

    const reconnectableHarness = new ReconnectableHarness({
      logger: createLogger(),
      spawnHarness: async (options) => {
        const result = await spawnHarness(options);
        return {
          harness: result.harness,
          subprocess: (result.subprocess ??
            (new Promise<never>(() => undefined) as never)) as never,
        };
      },
      maxReconnectAttempts: 1,
    });

    await reconnectableHarness.start({ initialSessionId: 'session-recover' });

    harnessOne.connected = false;
    harnessOne.emit('disconnected');

    expect(
      reconnectableHarness.sendCommand({
        commandName: TaskCommandName.ReorderQueuedMessage,
        data: {
          id: 'runtime-queued-3',
          targetId: 'runtime-queued-1',
          position: 'before',
        },
      }),
    ).toBe(true);
    expect(
      reconnectableHarness.sendCommand({
        commandName: TaskCommandName.DeleteQueuedMessage,
        data: { id: 'runtime-queued-2' },
      }),
    ).toBe(true);

    reconnectDeferred.resolve({
      harness: harnessTwo,
      subprocess: null,
    });
    await reconnectDeferred.promise;

    await vi.waitFor(() => {
      expect(harnessTwo.sentCommands).toEqual([
        {
          commandName: TaskCommandName.RestoreQueuedMessages,
          data: {
            queuedMessages: [
              harnessOne.queuedMessageSnapshots[2],
              harnessOne.queuedMessageSnapshots[0],
            ],
          },
        },
      ]);
    });
  });

  it('restarts on harness request, reuses the session id, and replays buffered commands', async () => {
    const harnessOne = new FakeHarness();
    const harnessTwo = new FakeHarness();
    const reconnectDeferred = deferred<{
      harness: Harness;
      subprocess: Promise<never> | null;
    }>();
    const taskEvents: TaskEvent[] = [];

    const spawnHarness = vi
      .fn()
      .mockResolvedValueOnce({
        harness: harnessOne,
        subprocess: null,
      })
      .mockImplementationOnce(
        async (options?: { initialSessionId?: string }) => {
          expect(options?.initialSessionId).toBe('session-restart');
          return await reconnectDeferred.promise;
        },
      );

    const reconnectableHarness = new ReconnectableHarness({
      logger: createLogger(),
      spawnHarness: async (options) => {
        const result = await spawnHarness(options);
        return {
          harness: result.harness,
          subprocess: (result.subprocess ??
            (new Promise<never>(() => undefined) as never)) as never,
        };
      },
      maxReconnectAttempts: 1,
    });

    reconnectableHarness.subscribe((event) => {
      taskEvents.push(event);
    });

    await reconnectableHarness.start();

    harnessOne.emit('taskEvent', {
      eventName: TaskEventName.TaskStarted,
      payload: ['session-restart'],
    } as TaskEvent);

    harnessOne.emit('restartRequested', {
      reason: 'restart for test',
      sessionId: 'session-restart',
      replayCommands: [
        {
          commandName: TaskCommandName.RestoreQueuedMessages,
          data: {
            queuedMessages: [
              {
                id: 'runtime-queued-1',
                text: 'queued retry after restart',
                timestamp: 1,
              },
            ],
          },
        },
        {
          commandName: TaskCommandName.SendMessage,
          data: { text: 'retry after restart' },
        },
      ],
    });

    reconnectDeferred.resolve({
      harness: harnessTwo,
      subprocess: null,
    });
    await reconnectDeferred.promise;

    await vi.waitFor(() => {
      expect(harnessTwo.sentCommands).toContainEqual({
        commandName: TaskCommandName.RestoreQueuedMessages,
        data: {
          queuedMessages: [
            {
              id: 'runtime-queued-1',
              text: 'queued retry after restart',
              timestamp: 1,
            },
          ],
        },
      });
      expect(harnessTwo.sentCommands).toContainEqual({
        commandName: TaskCommandName.SendMessage,
        data: { text: 'retry after restart' },
      });
    });
    expect(harnessTwo.sentCommands[0]).toMatchObject({
      commandName: TaskCommandName.RestoreQueuedMessages,
    });
    expect(harnessTwo.sentCommands[1]).toMatchObject({
      commandName: TaskCommandName.SendMessage,
      data: { text: 'retry after restart' },
    });

    harnessOne.emit('taskEvent', {
      eventName: TaskEventName.TaskCompleted,
      payload: ['session-restart'],
    } as TaskEvent);

    harnessTwo.emit('taskEvent', {
      eventName: TaskEventName.TaskCompleted,
      payload: ['session-restart'],
    } as TaskEvent);

    expect(taskEvents).toEqual([
      expect.objectContaining({
        eventName: TaskEventName.TaskStarted,
        payload: ['session-restart'],
      }),
      expect.objectContaining({
        eventName: TaskEventName.TaskCompleted,
        payload: ['session-restart'],
      }),
    ]);
  });

  it('supports external reconnect requests and replays queued user-input answers', async () => {
    const harnessOne = new FakeHarness();
    const harnessTwo = new FakeHarness();
    harnessTwo.pendingUserInputRequests = [
      {
        requestId: 'rui:session:turn:call',
        sessionId: 'session-answer',
        turnId: 'turn-1',
        callId: 'call-1',
        status: 'pending',
        questions: [],
        ts: Date.now(),
      },
    ];
    const reconnectDeferred = deferred<{
      harness: Harness;
      subprocess: Promise<never> | null;
    }>();

    const spawnHarness = vi
      .fn()
      .mockResolvedValueOnce({
        harness: harnessOne,
        subprocess: null,
      })
      .mockImplementationOnce(
        async (options?: { initialSessionId?: string }) => {
          expect(options?.initialSessionId).toBe('session-answer');
          return await reconnectDeferred.promise;
        },
      );

    const reconnectableHarness = new ReconnectableHarness({
      logger: createLogger(),
      spawnHarness: async (options) => {
        const result = await spawnHarness(options);
        return {
          harness: result.harness,
          subprocess: (result.subprocess ??
            (new Promise<never>(() => undefined) as never)) as never,
        };
      },
      maxReconnectAttempts: 1,
    });

    await reconnectableHarness.start({ initialSessionId: 'session-answer' });

    const reconnectPromise = reconnectableHarness.requestReconnect({
      reason: 'actor-scoped MCP refresh',
    });

    const sent = reconnectableHarness.sendCommand({
      commandName: TaskCommandName.AnswerUserInputRequest,
      data: {
        requestId: 'rui:session:turn:call',
        answers: {
          language: {
            answers: ['Rust'],
          },
        },
      },
    });

    expect(sent).toBe(true);

    reconnectDeferred.resolve({
      harness: harnessTwo,
      subprocess: null,
    });
    await reconnectPromise;

    await vi.waitFor(() => {
      expect(harnessTwo.sentCommands).toContainEqual({
        commandName: TaskCommandName.AnswerUserInputRequest,
        data: {
          requestId: 'rui:session:turn:call',
          answers: {
            language: {
              answers: ['Rust'],
            },
          },
        },
      });
    });
  });

  it('waits to replay queued user-input answers until the request is restored', async () => {
    const harnessOne = new FakeHarness();
    const harnessTwo = new FakeHarness();
    harnessTwo.sendCommandImpl = (command) => {
      if (
        command.commandName === TaskCommandName.AnswerUserInputRequest &&
        !harnessTwo.pendingUserInputRequests.some(
          (request) => request.requestId === command.data.requestId,
        )
      ) {
        return false;
      }

      harnessTwo.sentCommands.push(command);
      return true;
    };

    const reconnectDeferred = deferred<{
      harness: Harness;
      subprocess: Promise<never> | null;
    }>();

    const spawnHarness = vi
      .fn()
      .mockResolvedValueOnce({
        harness: harnessOne,
        subprocess: null,
      })
      .mockImplementationOnce(
        async (options?: { initialSessionId?: string }) => {
          expect(options?.initialSessionId).toBe('session-answer');
          return await reconnectDeferred.promise;
        },
      );

    const reconnectableHarness = new ReconnectableHarness({
      logger: createLogger(),
      spawnHarness: async (options) => {
        const result = await spawnHarness(options);
        return {
          harness: result.harness,
          subprocess: (result.subprocess ??
            (new Promise<never>(() => undefined) as never)) as never,
        };
      },
      maxReconnectAttempts: 1,
    });

    await reconnectableHarness.start({ initialSessionId: 'session-answer' });

    const reconnectPromise = reconnectableHarness.requestReconnect({
      reason: 'actor-scoped MCP refresh',
    });

    const sent = reconnectableHarness.sendCommand({
      commandName: TaskCommandName.AnswerUserInputRequest,
      data: {
        requestId: 'rui:session:turn:call',
        answers: {
          language: {
            answers: ['Rust'],
          },
        },
      },
    });

    expect(sent).toBe(true);

    reconnectDeferred.resolve({
      harness: harnessTwo,
      subprocess: null,
    });
    await reconnectPromise;

    expect(harnessTwo.sentCommands).toHaveLength(0);

    harnessTwo.pendingUserInputRequests = [
      {
        requestId: 'rui:session:turn:call',
        sessionId: 'session-answer',
        turnId: 'turn-1',
        callId: 'call-1',
        status: 'pending',
        questions: [],
        ts: Date.now(),
      },
    ];
    harnessTwo.emit('runtimeOutput', {} as AcpMessage);

    await vi.waitFor(() => {
      expect(harnessTwo.sentCommands).toContainEqual({
        commandName: TaskCommandName.AnswerUserInputRequest,
        data: {
          requestId: 'rui:session:turn:call',
          answers: {
            language: {
              answers: ['Rust'],
            },
          },
        },
      });
    });
  });

  it('does not forward late events from the disconnected harness after reconnect', async () => {
    const harnessOne = new FakeHarness();
    const harnessTwo = new FakeHarness();
    const reconnectDeferred = deferred<{
      harness: Harness;
      subprocess: Promise<never> | null;
    }>();
    const taskEvents: TaskEvent[] = [];

    const spawnHarness = vi
      .fn()
      .mockResolvedValueOnce({
        harness: harnessOne,
        subprocess: null,
      })
      .mockImplementationOnce(async () => reconnectDeferred.promise);

    const reconnectableHarness = new ReconnectableHarness({
      logger: createLogger(),
      spawnHarness: async (options) => {
        const result = await spawnHarness(options);
        return {
          harness: result.harness,
          subprocess: (result.subprocess ??
            (new Promise<never>(() => undefined) as never)) as never,
        };
      },
      maxReconnectAttempts: 1,
    });

    reconnectableHarness.subscribe((event) => {
      taskEvents.push(event);
    });

    await reconnectableHarness.start();

    harnessOne.emit('taskEvent', {
      eventName: TaskEventName.TaskStarted,
      payload: ['session-recover'],
    } as TaskEvent);

    harnessOne.connected = false;
    harnessOne.emit('disconnected');

    reconnectDeferred.resolve({
      harness: harnessTwo,
      subprocess: null,
    });
    await reconnectDeferred.promise;
    await vi.waitFor(() => {
      expect(harnessTwo.listenerCount('taskEvent')).toBe(1);
    });

    harnessOne.emit('taskEvent', {
      eventName: TaskEventName.TaskCompleted,
      payload: ['session-recover'],
    } as TaskEvent);

    harnessTwo.emit('taskEvent', {
      eventName: TaskEventName.TaskCompleted,
      payload: ['session-recover-new'],
    } as TaskEvent);

    expect(taskEvents).toEqual([
      expect.objectContaining({
        eventName: TaskEventName.TaskStarted,
        payload: ['session-recover'],
      }),
      expect.objectContaining({
        eventName: TaskEventName.TaskCompleted,
        payload: ['session-recover-new'],
      }),
    ]);
  });

  describe('diagnostic breadcrumbs', () => {
    it('records disconnect and reconnect breadcrumbs', async () => {
      const harnesses = [new FakeHarness(), new FakeHarness()];
      const record = vi.fn();
      const reconnectableHarness = new ReconnectableHarness({
        logger: createLogger(),
        spawnHarness: async () => ({
          harness: harnesses.shift()!,
          subprocess: createSubprocess() as never,
        }),
        diagnosticEvents: { record },
      });
      const first = harnesses[0]!;

      await reconnectableHarness.start();
      first.emit('disconnected');

      await vi.waitFor(() => {
        expect(record).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'harness_reconnected' }),
        );
      });
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'harness_disconnected' }),
      );

      reconnectableHarness.dispose();
    });

    it('records exhaustion when reconnecting gives up', async () => {
      const first = new FakeHarness();
      let spawnedOnce = false;
      const record = vi.fn();
      const reconnectableHarness = new ReconnectableHarness({
        logger: createLogger(),
        maxReconnectAttempts: 1,
        spawnHarness: async () => {
          if (!spawnedOnce) {
            spawnedOnce = true;
            return { harness: first, subprocess: createSubprocess() as never };
          }
          throw new Error('spawn failed');
        },
        diagnosticEvents: { record },
      });

      await reconnectableHarness.start();
      first.emit('disconnected');

      await vi.waitFor(() => {
        expect(record).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: 'harness_reconnect_exhausted',
            details: expect.objectContaining({ maxAttempts: 1 }),
          }),
        );
      });

      reconnectableHarness.dispose();
    });

    it('records external reconnect requests with their reason', async () => {
      const harnesses = [new FakeHarness(), new FakeHarness()];
      const record = vi.fn();
      const reconnectableHarness = new ReconnectableHarness({
        logger: createLogger(),
        spawnHarness: async () => ({
          harness: harnesses.shift()!,
          subprocess: createSubprocess() as never,
        }),
        diagnosticEvents: { record },
      });

      await reconnectableHarness.start();
      await reconnectableHarness.requestReconnect({
        reason: 'environment variables updated',
      });

      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'harness_restart_requested',
          details: expect.objectContaining({
            source: 'external',
            reason: 'environment variables updated',
          }),
        }),
      );

      reconnectableHarness.dispose();
    });
  });
});
