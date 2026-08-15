import { TaskEventName, type TaskEvent } from '@roomote/types';

const {
  mockCancelPendingMissingChatCloseoutFallback,
  mockRecordMissingChatCloseoutFallback,
  mockDeliverShowWidgetFallback,
  mockWaitForMissingChatCloseoutFallbackDelivery,
} = vi.hoisted(() => ({
  mockCancelPendingMissingChatCloseoutFallback: vi.fn(),
  mockRecordMissingChatCloseoutFallback: vi.fn(),
  mockDeliverShowWidgetFallback: vi.fn().mockResolvedValue(undefined),
  mockWaitForMissingChatCloseoutFallbackDelivery: vi
    .fn()
    .mockResolvedValue(undefined),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      recordMessageEnvelope: vi.fn().mockResolvedValue(null),
      recordInferenceUsage: vi.fn().mockResolvedValue({ recorded: true }),
      stampMilestone: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('../show-widget-fallback-delivery', () => ({
  deliverShowWidgetFallback: mockDeliverShowWidgetFallback,
}));

vi.mock('../missing-chat-closeout-fallback-settlement', () => ({
  cancelPendingMissingChatCloseoutFallback:
    mockCancelPendingMissingChatCloseoutFallback,
  recordMissingChatCloseoutFallback: mockRecordMissingChatCloseoutFallback,
  waitForMissingChatCloseoutFallbackDelivery:
    mockWaitForMissingChatCloseoutFallbackDelivery,
}));

vi.mock('../../monitoring/sentry', () => ({
  captureWorkerException: vi.fn(),
}));

import { sdk } from '@roomote/sdk/client';
import { captureWorkerException } from '../../monitoring/sentry';

import {
  ACP_ENVELOPE_EVENT_TYPES,
  ACP_LIVE_EVENT_TYPES,
  type AcpMessage,
  type AcpPersistedEnvelope,
  type AcpTurnCompletedEvent,
} from '@roomote/types';

import { subscribeHarnessCallbacks } from '../subscribe-harness-callbacks';
import type { HarnessInferenceUsageEvent } from '../../sandbox-server/lib/harness';

function createRuntimeHarness() {
  let outputListener: ((event: AcpMessage) => void) | undefined;
  let envelopeListener: ((envelope: AcpPersistedEnvelope) => void) | undefined;
  let turnCompletedListener:
    | ((event: AcpTurnCompletedEvent) => void)
    | undefined;
  let inferenceUsageListener:
    | ((event: HarnessInferenceUsageEvent) => void)
    | undefined;
  let taskListener: ((event: TaskEvent) => void) | undefined;

  return {
    harness: {
      subscribe: (listener: (event: TaskEvent) => void) => {
        taskListener = listener;
        return () => {
          if (taskListener === listener) {
            taskListener = undefined;
          }
        };
      },
      subscribeRuntimeOutput: (listener: (event: AcpMessage) => void) => {
        outputListener = listener;
        return () => {
          if (outputListener === listener) {
            outputListener = undefined;
          }
        };
      },
      subscribeRuntimePersistedEnvelope: (
        listener: (envelope: AcpPersistedEnvelope) => void,
      ) => {
        envelopeListener = listener;
        return () => {
          if (envelopeListener === listener) {
            envelopeListener = undefined;
          }
        };
      },
      subscribeRuntimeTurnCompleted: (
        listener: (event: AcpTurnCompletedEvent) => void,
      ) => {
        turnCompletedListener = listener;
        return () => {
          if (turnCompletedListener === listener) {
            turnCompletedListener = undefined;
          }
        };
      },
      subscribeRuntimeInferenceUsage: (
        listener: (event: HarnessInferenceUsageEvent) => void,
      ) => {
        inferenceUsageListener = listener;
        return () => {
          if (inferenceUsageListener === listener) {
            inferenceUsageListener = undefined;
          }
        };
      },
    } as unknown,
    emitOutput: (event: AcpMessage) => outputListener?.(event),
    emitEnvelope: (envelope: AcpPersistedEnvelope) =>
      envelopeListener?.(envelope),
    emitTurnCompleted: (event: AcpTurnCompletedEvent) =>
      turnCompletedListener?.(event),
    emitInferenceUsage: (event: HarnessInferenceUsageEvent) =>
      inferenceUsageListener?.(event),
    emitTaskEvent: (event: TaskEvent) => taskListener?.(event),
  };
}

describe('subscribeHarnessCallbacks', () => {
  const recordMessageEnvelopeMock = vi.mocked(
    sdk.taskRuns.recordMessageEnvelope,
  );
  const recordInferenceUsageMock = vi.mocked(sdk.taskRuns.recordInferenceUsage);
  const captureWorkerExceptionMock = vi.mocked(captureWorkerException);

  beforeEach(() => {
    recordMessageEnvelopeMock.mockClear();
    recordMessageEnvelopeMock.mockResolvedValue(null);
    recordInferenceUsageMock.mockClear();
    recordInferenceUsageMock.mockResolvedValue({ recorded: true });
    captureWorkerExceptionMock.mockClear();
    mockCancelPendingMissingChatCloseoutFallback.mockClear();
    mockRecordMissingChatCloseoutFallback.mockClear();
    mockWaitForMissingChatCloseoutFallbackDelivery.mockClear();
    mockDeliverShowWidgetFallback.mockClear();
  });

  it('persists Roomote runtime user prompt envelopes to task_messages', async () => {
    const { harness, emitEnvelope } = createRuntimeHarness();

    const callbacks = { onMessage: vi.fn().mockResolvedValue(undefined) };

    const unsubscribe = subscribeHarnessCallbacks({
      harness: harness as never,
      taskRun: { id: 45, taskId: '17294o7tqi124' } as never,
      callbacks,
      context: {},
      logger: {
        runId: 45,
        filePath: '/tmp/test.log',
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      },
    });

    const userPromptEnvelope: AcpPersistedEnvelope = {
      ts: 1772823376000,
      eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
      role: 'user',
      protocol: 'roomote_runtime',
      contentBlocks: [{ type: 'text', text: 'follow up' }],
      metadata: { source: 'session/prompt', sessionId: 'runtime-session-1' },
      payload: {},
    };

    emitEnvelope(userPromptEnvelope);

    expect(recordMessageEnvelopeMock).toHaveBeenCalledWith({
      runId: 45,
      taskId: '17294o7tqi124',
      envelope: userPromptEnvelope,
    });
    // User prompts are persisted but not forwarded to callbacks.
    expect(callbacks.onMessage).not.toHaveBeenCalled();

    await unsubscribe();
  });

  it('delivers a returned show_widget fallback after persistence', async () => {
    const { harness, emitEnvelope } = createRuntimeHarness();
    const fallback = {
      toolCallId: 'call-widget-1',
      title: 'Status',
      textFallback: 'Ready',
      widgetUrl: 'https://app.example.com/task/task-widget#msg-1772823376050',
    };
    recordMessageEnvelopeMock.mockResolvedValue(fallback);

    const logger = {
      runId: 45,
      filePath: '/tmp/test.log',
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    };
    const unsubscribe = subscribeHarnessCallbacks({
      harness: harness as never,
      taskRun: { id: 45, taskId: 'task-widget' } as never,
      callbacks: {},
      context: {},
      logger,
      mcpTaskEnv: {
        ROOMOTE_CLOUD_TOKEN: 'token',
        ROOMOTE_PLATFORM_API_URL: 'https://platform.example.com',
        ROOMOTE_SLACK_CHANNEL: 'C123',
      },
    });

    emitEnvelope({
      ts: 1772823376050,
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
      role: 'tool',
      protocol: 'roomote_runtime',
      contentBlocks: [],
      metadata: { toolCallId: 'call-widget-1' },
      payload: { toolCallId: 'call-widget-1' },
    });

    await vi.waitFor(() => {
      expect(mockDeliverShowWidgetFallback).toHaveBeenCalledWith({
        runId: 45,
        delivery: fallback,
        mcpTaskEnv: {
          ROOMOTE_CLOUD_TOKEN: 'token',
          ROOMOTE_PLATFORM_API_URL: 'https://platform.example.com',
          ROOMOTE_SLACK_CHANNEL: 'C123',
        },
        logger,
      });
    });

    await unsubscribe();
  });

  it('persists hidden inference usage events through the task run SDK', async () => {
    const { harness, emitInferenceUsage } = createRuntimeHarness();
    let resolveRecord: (() => void) | undefined;
    recordInferenceUsageMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRecord = () => resolve({ recorded: true });
        }),
    );

    const unsubscribe = subscribeHarnessCallbacks({
      harness: harness as never,
      taskRun: { id: 145, taskId: 'task-inference' } as never,
      callbacks: { onMessage: vi.fn().mockResolvedValue(undefined) },
      context: {},
      logger: {
        runId: 145,
        filePath: '/tmp/test.log',
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      },
    });

    emitInferenceUsage({
      sessionId: 'ses-inference',
      messageId: 'msg-inference',
      providerId: 'openrouter',
      modelId: 'openai/gpt-5.4',
      agent: 'explore',
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
      totalTokens: 22,
      contextTokens: 14,
      costMicroUsd: 123,
      costSource: 'opencode_message',
      messageCreatedAt: new Date('2026-07-01T12:00:00.000Z'),
      messageCompletedAt: new Date('2026-07-01T12:00:01.000Z'),
    });

    expect(recordInferenceUsageMock).toHaveBeenCalledWith({
      runId: 145,
      harnessSessionId: 'ses-inference',
      messageId: 'msg-inference',
      providerId: 'openrouter',
      modelId: 'openai/gpt-5.4',
      agent: 'explore',
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
      totalTokens: 22,
      contextTokens: 14,
      costMicroUsd: 123,
      costSource: 'opencode_message',
      messageCreatedAt: new Date('2026-07-01T12:00:00.000Z'),
      messageCompletedAt: new Date('2026-07-01T12:00:01.000Z'),
    });

    const unsubscribePromise = unsubscribe();
    await Promise.resolve();
    expect(resolveRecord).toBeDefined();
    resolveRecord?.();
    await unsubscribePromise;
  });

  it('waits for persisted envelope writes before forwarding completion callbacks', async () => {
    const { harness, emitEnvelope, emitTaskEvent, emitTurnCompleted } =
      createRuntimeHarness();
    let resolvePersist: (() => void) | undefined;
    recordMessageEnvelopeMock.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          resolvePersist = () => resolve(null);
        }),
    );

    const callbacks = { onMessage: vi.fn().mockResolvedValue(undefined) };

    const unsubscribe = subscribeHarnessCallbacks({
      harness: harness as never,
      taskRun: { id: 46, taskId: 'task-fallback' } as never,
      callbacks,
      context: {},
      logger: {
        runId: 46,
        filePath: '/tmp/test.log',
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      },
    });

    const pendingEnvelope: AcpPersistedEnvelope = {
      ts: 1772823376999,
      eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
      role: 'user',
      protocol: 'roomote_runtime',
      contentBlocks: [{ type: 'text', text: 'done' }],
      metadata: { source: 'session/prompt', sessionId: 'runtime-session-2' },
      payload: {},
    };

    emitEnvelope(pendingEnvelope);
    emitTurnCompleted({
      protocol: 'roomote_runtime',
      sessionId: 'runtime-session-2',
      ts: 1772823377000,
      text: 'done',
    });

    expect(callbacks.onMessage).not.toHaveBeenCalled();

    emitTaskEvent({
      eventName: TaskEventName.TaskCompleted,
      payload: ['runtime-session-2', {}, {}, {}],
    } as TaskEvent);

    expect(callbacks.onMessage).not.toHaveBeenCalled();

    resolvePersist?.();

    await vi.waitFor(() => {
      expect(callbacks.onMessage).toHaveBeenCalledWith(
        { id: 46, taskId: 'task-fallback' },
        'runtime-session-2',
        {
          type: 'completion',
          text: 'done',
          ts: 1772823377000,
        },
        {},
      );
    });

    expect(recordMessageEnvelopeMock).toHaveBeenCalledWith({
      runId: 46,
      taskId: 'task-fallback',
      envelope: pendingEnvelope,
    });

    await unsubscribe();
  });

  it('records the latest finalized assistant message until completion settles', async () => {
    const { harness, emitTaskEvent, emitTurnCompleted } =
      createRuntimeHarness();
    const logger = {
      runId: 146,
      filePath: '/tmp/test.log',
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    };
    const mcpTaskEnv = {
      ROOMOTE_CLOUD_TOKEN: 'token',
      ROOMOTE_PLATFORM_API_URL: 'https://platform.example.com',
      ROOMOTE_COMMUNICATION_PROVIDER: 'discord',
      ROOMOTE_COMMUNICATION_CHANNEL_ID: 'channel-1',
    };
    const context = {};
    const unsubscribe = subscribeHarnessCallbacks({
      harness: harness as never,
      taskRun: { id: 146, taskId: 'task-closeout' } as never,
      callbacks: { onMessage: vi.fn().mockResolvedValue(undefined) },
      context,
      logger,
      mcpTaskEnv,
    });

    emitTurnCompleted({
      protocol: 'roomote_runtime',
      sessionId: 'runtime-session-closeout',
      ts: 1772823377001,
      text: 'The final assistant answer.',
    });
    emitTaskEvent({
      eventName: TaskEventName.TaskCompleted,
      payload: [
        'runtime-session-closeout',
        {},
        {},
        {
          isSubtask: false,
          completionId: 'completion-closeout-1',
          missingChatCloseout: { reminderCount: 3 },
        },
      ],
    } as TaskEvent);

    await vi.waitFor(() => {
      expect(mockRecordMissingChatCloseoutFallback).toHaveBeenCalledWith(
        context,
        {
          runId: 146,
          completionId: 'completion-closeout-1',
          text: 'The final assistant answer.',
          mcpTaskEnv,
          logger,
        },
      );
    });

    await unsubscribe();
  });

  it('records an empty fallback only for completion events marked as missing closeout', async () => {
    const { harness, emitTaskEvent } = createRuntimeHarness();
    const logger = {
      runId: 147,
      filePath: '/tmp/test.log',
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    };
    const context = {};
    const unsubscribe = subscribeHarnessCallbacks({
      harness: harness as never,
      taskRun: { id: 147, taskId: 'task-empty-closeout' } as never,
      callbacks: {},
      context,
      logger,
    });

    emitTaskEvent({
      eventName: TaskEventName.TaskCompleted,
      payload: [
        'runtime-session-empty-closeout',
        {},
        {},
        { isSubtask: false, missingChatCloseout: { reminderCount: 3 } },
      ],
    } as TaskEvent);

    await vi.waitFor(() => {
      expect(mockRecordMissingChatCloseoutFallback).toHaveBeenCalledWith(
        context,
        {
          runId: 147,
          completionId: 'runtime-session-empty-closeout',
          text: null,
          mcpTaskEnv: undefined,
          logger,
        },
      );
    });

    mockRecordMissingChatCloseoutFallback.mockClear();
    emitTaskEvent({
      eventName: TaskEventName.TaskCompleted,
      payload: ['runtime-session-empty-closeout', {}, {}, { isSubtask: false }],
    } as TaskEvent);

    await Promise.resolve();
    expect(mockRecordMissingChatCloseoutFallback).toHaveBeenCalledWith(
      context,
      null,
    );

    await unsubscribe();
  });

  it('forwards Roomote runtime assistant_message envelopes immediately', async () => {
    const { harness, emitEnvelope, emitTaskEvent } = createRuntimeHarness();

    const callbacks = { onMessage: vi.fn().mockResolvedValue(undefined) };

    const unsubscribe = subscribeHarnessCallbacks({
      harness: harness as never,
      taskRun: { id: 48, taskId: 'task-live-text' } as never,
      callbacks,
      context: {},
      logger: {
        runId: 48,
        filePath: '/tmp/test.log',
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      },
    });

    const textEnvelope: AcpPersistedEnvelope = {
      ts: 1772823377500,
      eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
      role: 'assistant',
      protocol: 'roomote_runtime',
      contentBlocks: [{ type: 'text', text: 'streamed thought' }],
      metadata: { source: 'assistant_message', sessionId: 'runtime-session-4' },
      payload: {},
    };

    emitEnvelope(textEnvelope);

    await vi.waitFor(() => {
      expect(callbacks.onMessage).toHaveBeenCalledWith(
        { id: 48, taskId: 'task-live-text' },
        'runtime-session-4',
        {
          type: 'text',
          text: 'streamed thought',
          ts: 1772823377500,
        },
        {},
      );
    });

    callbacks.onMessage.mockClear();

    emitTaskEvent({
      eventName: TaskEventName.TaskCompleted,
      payload: ['runtime-session-4', {}, {}, {}],
    } as TaskEvent);

    expect(callbacks.onMessage).not.toHaveBeenCalled();

    await unsubscribe();
  });

  it('stamps firstAssistantOutputAt from the first live assistant runtime event', async () => {
    const { harness, emitOutput } = createRuntimeHarness();

    const unsubscribe = subscribeHarnessCallbacks({
      harness: harness as never,
      taskRun: { id: 50, taskId: 'task-first-assistant-output' } as never,
      callbacks: { onMessage: vi.fn().mockResolvedValue(undefined) },
      context: {},
      logger: {
        runId: 50,
        filePath: '/tmp/test.log',
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      },
    });

    const stampMock = vi.mocked(sdk.taskRuns.stampMilestone);
    stampMock.mockClear();

    const makeOutput = (ts: number): AcpMessage => ({
      id: `runtime-session-50:${ts}`,
      ts,
      eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk,
      role: 'assistant',
      kind: 'text',
      contentBlocks: [{ type: 'text', text: 'streamed thought' }],
      metadata: {
        source: 'assistant_message',
        sessionId: 'runtime-session-50',
      },
      payload: {},
    });

    emitOutput(makeOutput(1772823377700));
    emitOutput(makeOutput(1772823377800));

    await vi.waitFor(() => {
      expect(stampMock).toHaveBeenCalledTimes(1);
    });

    expect(stampMock).toHaveBeenCalledWith({
      runId: 50,
      field: 'firstAssistantOutputAt',
    });

    await unsubscribe();
  });

  it('reports Roomote runtime envelope persistence failures to worker sentry', async () => {
    const { harness, emitEnvelope } = createRuntimeHarness();
    const persistError = new Error('persist failed');
    recordMessageEnvelopeMock.mockRejectedValueOnce(persistError);

    const callbacks = { onMessage: vi.fn().mockResolvedValue(undefined) };

    const unsubscribe = subscribeHarnessCallbacks({
      harness: harness as never,
      taskRun: { id: 49, taskId: 'task-persist-failure' } as never,
      callbacks,
      context: {},
      logger: {
        runId: 49,
        filePath: '/tmp/test.log',
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      },
    });

    emitEnvelope({
      ts: 1772823377600,
      eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
      role: 'assistant',
      protocol: 'roomote_runtime',
      contentBlocks: [{ type: 'text', text: 'streamed thought' }],
      metadata: {
        source: 'assistant_message',
        sessionId: 'runtime-session-49',
      },
      payload: {},
    });

    await vi.waitFor(() => {
      expect(captureWorkerExceptionMock).toHaveBeenCalledWith(
        persistError,
        expect.objectContaining({
          runId: 49,
          taskId: 'task-persist-failure',
          component: 'subscribeHarnessCallbacks',
          stage: 'recordMessageEnvelope',
          eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
          sessionId: 'runtime-session-49',
          consecutivePersistenceFailures: 1,
        }),
      );
    });

    await unsubscribe();
  });

  it('does not persist raw Roomote runtime output events to task_messages', async () => {
    const { harness, emitOutput } = createRuntimeHarness();
    const context = {};

    const unsubscribe = subscribeHarnessCallbacks({
      harness: harness as never,
      taskRun: { id: 49, taskId: 'task-no-raw-output' } as never,
      callbacks: { onMessage: vi.fn().mockResolvedValue(undefined) },
      context,
      logger: {
        runId: 49,
        filePath: '/tmp/test.log',
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      },
    });

    emitOutput({
      id: 'runtime-session-output:12',
      ts: 1772823379000,
      eventType: 'roomote_runtime.tool_call_update',
      role: 'assistant',
      kind: 'tool_result',
      contentBlocks: [],
      metadata: { sessionId: 'runtime-session-output', sequence: 12 },
      payload: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-raw-output',
        status: 'completed',
        content: [{ type: 'text', text: 'done' }],
      },
    });

    expect(mockCancelPendingMissingChatCloseoutFallback).toHaveBeenCalledWith(
      context,
    );
    expect(recordMessageEnvelopeMock).not.toHaveBeenCalled();

    await unsubscribe();
  });

  it('does not cancel a pending closeout fallback for usage-only activity', async () => {
    const { harness, emitOutput } = createRuntimeHarness();
    const context = {};
    const unsubscribe = subscribeHarnessCallbacks({
      harness: harness as never,
      taskRun: { id: 51, taskId: 'task-usage-output' } as never,
      callbacks: {},
      context,
      logger: {
        runId: 51,
        filePath: '/tmp/test.log',
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      },
    });

    emitOutput({
      id: 'runtime-session-usage:1',
      ts: 1772823379100,
      eventType: ACP_LIVE_EVENT_TYPES.UsageUpdate,
      role: 'assistant',
      kind: 'unknown',
      contentBlocks: [],
      metadata: { sessionId: 'runtime-session-usage' },
      payload: {},
    });

    expect(mockCancelPendingMissingChatCloseoutFallback).not.toHaveBeenCalled();

    await unsubscribe();
  });

  it('forwards request_user_input envelopes as callback events', async () => {
    const { harness, emitEnvelope } = createRuntimeHarness();
    const callbacks = { onMessage: vi.fn().mockResolvedValue(undefined) };

    const unsubscribe = subscribeHarnessCallbacks({
      harness: harness as never,
      taskRun: { id: 50, taskId: 'task-rui' } as never,
      callbacks,
      context: {},
      logger: {
        runId: 50,
        filePath: '/tmp/test.log',
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      },
    });

    const envelope: AcpPersistedEnvelope = {
      ts: 1772823380000,
      eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
      role: 'assistant',
      protocol: 'roomote_runtime',
      contentBlocks: [],
      metadata: { sessionId: 'runtime-session-rui' },
      payload: {
        requestId: 'rui:session:turn:call',
        sessionId: 'runtime-session-rui',
        turnId: 'turn-1',
        callId: 'call-1',
        questions: [
          {
            id: 'language',
            header: 'Language',
            question: 'Which language should I use?',
            isOther: true,
            isSecret: false,
            options: [
              {
                label: 'TypeScript',
                description: 'Use the app stack.',
              },
            ],
          },
        ],
      },
    };

    emitEnvelope(envelope);

    await vi.waitFor(() => {
      expect(callbacks.onMessage).toHaveBeenCalledWith(
        { id: 50, taskId: 'task-rui' },
        'runtime-session-rui',
        {
          type: 'request_user_input',
          request: {
            requestId: 'rui:session:turn:call',
            sessionId: 'runtime-session-rui',
            turnId: 'turn-1',
            callId: 'call-1',
            questions: [
              {
                id: 'language',
                header: 'Language',
                question: 'Which language should I use?',
                isOther: true,
                isSecret: false,
                options: [
                  {
                    label: 'TypeScript',
                    description: 'Use the app stack.',
                  },
                ],
              },
            ],
            status: 'pending',
          },
          ts: 1772823380000,
        },
        {},
      );
    });

    await unsubscribe();
  });

  it('forwards request_user_input_response envelopes as callback events', async () => {
    const { harness, emitEnvelope } = createRuntimeHarness();
    const callbacks = { onMessage: vi.fn().mockResolvedValue(undefined) };

    const unsubscribe = subscribeHarnessCallbacks({
      harness: harness as never,
      taskRun: { id: 51, taskId: 'task-rui-response' } as never,
      callbacks,
      context: {},
      logger: {
        runId: 51,
        filePath: '/tmp/test.log',
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      },
    });

    const envelope: AcpPersistedEnvelope = {
      ts: 1772823380100,
      eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse,
      role: 'user',
      protocol: 'roomote_runtime',
      contentBlocks: [],
      metadata: { sessionId: 'runtime-session-rui' },
      payload: {
        requestId: 'rui:session:turn:call',
        sessionId: 'runtime-session-rui',
        turnId: 'turn-1',
        callId: 'call-1',
        answers: {
          language: {
            answers: ['TypeScript'],
          },
        },
        resolution: 'submitted',
      },
    };

    emitEnvelope(envelope);

    await vi.waitFor(() => {
      expect(callbacks.onMessage).toHaveBeenCalledWith(
        { id: 51, taskId: 'task-rui-response' },
        'runtime-session-rui',
        {
          type: 'request_user_input_response',
          response: {
            requestId: 'rui:session:turn:call',
            sessionId: 'runtime-session-rui',
            turnId: 'turn-1',
            callId: 'call-1',
            answers: {
              language: {
                answers: ['TypeScript'],
              },
            },
            resolution: 'submitted',
          },
          ts: 1772823380100,
        },
        {},
      );
    });

    await unsubscribe();
  });
});
