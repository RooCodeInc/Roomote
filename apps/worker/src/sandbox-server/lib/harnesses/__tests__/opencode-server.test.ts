import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ACP_ENVELOPE_EVENT_TYPES,
  ACP_LIVE_EVENT_TYPES,
  TaskEventName,
  type AcpMessage,
  type AcpPersistedEnvelope,
  type AcpTurnCompletedEvent,
  type TaskEvent,
} from '@roomote/types';

import { SLACK_STOP_HOOK_SCRIPT } from '../../../../run-task/slack-stop-hook-script';
import { resolveOpenCodeModelSelection } from '../../../../run-task/opencode-model';
import { TaskCommandName } from '../../harness';
import type { HarnessInferenceUsageEvent } from '../../harness';
import type { OpenCodeServerClient } from '../opencode-server/client';
import {
  buildOpenCodeSlackStopHookEnv,
  OpenCodeServerHarness,
} from '../opencode-server/harness';
import type {
  OpenCodeGlobalEvent,
  OpenCodeSessionMessage,
} from '../opencode-server/types';

const TEST_OPENCODE_MODEL = 'test-provider/main-model';
const TEST_OPENCODE_MODEL_SELECTION =
  resolveOpenCodeModelSelection(TEST_OPENCODE_MODEL);

class FakeOpenCodeServerClient {
  private eventHandler:
    | ((event: OpenCodeGlobalEvent) => void | Promise<void>)
    | undefined;

  health = vi.fn(async () => ({ healthy: true as const, version: 'test' }));
  createSession = vi.fn(
    async (_options?: { title?: string; signal?: AbortSignal }) => ({
      id: 'ses_1',
      title: 'test',
    }),
  );
  promptAsync = vi.fn(async (_options: unknown) => undefined);
  messages = vi.fn(async () => [] as OpenCodeSessionMessage[]);
  message = vi.fn<() => Promise<OpenCodeSessionMessage>>();
  abort = vi.fn(async () => true);
  get sessionCreateTimeoutMsValue(): number {
    return 90_000;
  }
  streamEvents = vi.fn(
    async (options: {
      signal: AbortSignal;
      onEvent: (event: OpenCodeGlobalEvent) => void | Promise<void>;
    }) => {
      this.eventHandler = options.onEvent;

      await new Promise<void>((resolve) => {
        if (options.signal.aborted) {
          resolve();
          return;
        }

        options.signal.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
    },
  );

  async emit(event: OpenCodeGlobalEvent): Promise<void> {
    if (!this.eventHandler) {
      throw new Error('OpenCode event stream is not subscribed.');
    }

    await this.eventHandler(event);
  }
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createHarness(
  client = new FakeOpenCodeServerClient(),
  options: {
    commandEnv?: Record<string, string>;
    beforeQueuedPrompt?: (input: { userId?: string }) => Promise<void | {
      shouldReconnect: boolean;
      shouldBlockPrompt?: boolean;
      reason?: string;
    }>;
    executeToolProgressInitialDelayMs?: number;
    executeToolProgressIntervalMs?: number;
    queuedPromptRetryDelayMs?: number;
    stopHookReminderStallTimeoutMs?: number;
    providerRateLimitMaxRetries?: number;
    providerRateLimitBaseDelayMs?: number;
    providerRateLimitMaxDelayMs?: number;
    mcpServerNames?: string[];
    model?: string;
  } = {},
) {
  const harness = new OpenCodeServerHarness({
    client: client as unknown as OpenCodeServerClient,
    workspacePath: '/tmp/workspace',
    logger: createLogger(),
    commandEnv: options.commandEnv,
    model: options.model ?? TEST_OPENCODE_MODEL,
    eventStreamReadyTimeoutMs: 100,
    executeToolProgressInitialDelayMs:
      options.executeToolProgressInitialDelayMs,
    executeToolProgressIntervalMs: options.executeToolProgressIntervalMs,
    queuedPromptRetryDelayMs: options.queuedPromptRetryDelayMs,
    stopHookReminderStallTimeoutMs: options.stopHookReminderStallTimeoutMs,
    providerRateLimitMaxRetries: options.providerRateLimitMaxRetries,
    providerRateLimitBaseDelayMs: options.providerRateLimitBaseDelayMs,
    providerRateLimitMaxDelayMs: options.providerRateLimitMaxDelayMs,
    mcpServerNames: options.mcpServerNames,
    beforeQueuedPrompt: options.beforeQueuedPrompt,
  });

  return { client, harness };
}

describe('buildOpenCodeSlackStopHookEnv', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('keeps command env while excluding broad launcher env', () => {
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/worker';
    process.env.ROOMOTE_SECRET_LAUNCHER_TOKEN = 'do-not-leak';
    process.env.DATABASE_URL = 'postgres://do-not-leak';

    const env = buildOpenCodeSlackStopHookEnv({
      PATH: '/sandbox/bin',
      ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: '/tmp/state.json',
      ROOMOTE_OPENCODE_SLACK_STOP_HOOK_SCRIPT: '/tmp/stop-hook.cjs',
    });

    expect(env).toMatchObject({
      PATH: '/sandbox/bin',
      HOME: '/home/worker',
      ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: '/tmp/state.json',
      ROOMOTE_OPENCODE_SLACK_STOP_HOOK_SCRIPT: '/tmp/stop-hook.cjs',
    });
    expect(env.ROOMOTE_SECRET_LAUNCHER_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });
});

async function connectHarness(
  harness: OpenCodeServerHarness,
  client: FakeOpenCodeServerClient,
): Promise<void> {
  const connectPromise = harness.connect();

  await vi.waitFor(() => {
    expect(client.streamEvents).toHaveBeenCalledTimes(1);
  });
  await client.emit({ type: 'server.connected' });
  await connectPromise;
}

function createFinalAssistantMessage(): OpenCodeSessionMessage {
  return {
    info: {
      id: 'msg_1',
      sessionID: 'ses_1',
      role: 'assistant',
      providerID: 'openrouter',
      modelID: 'openai/gpt-5.4',
      mode: 'build',
      time: {
        created: 0,
        completed: 1,
      },
      cost: 0.000123,
      tokens: {
        input: 5,
        output: 2,
        reasoning: 1,
        cache: {
          read: 3,
          write: 4,
        },
      },
    },
    parts: [
      {
        id: 'part_1',
        sessionID: 'ses_1',
        messageID: 'msg_1',
        type: 'text',
        text: 'OK',
      },
    ],
  };
}

describe('OpenCodeServerHarness', () => {
  it('waits for the server.connected event before marking the harness connected', async () => {
    const { client, harness } = createHarness();
    const connectedEvents: string[] = [];
    harness.on('connected', () => connectedEvents.push('connected'));

    try {
      const connectPromise = harness.connect();

      await vi.waitFor(() => {
        expect(client.streamEvents).toHaveBeenCalledTimes(1);
      });
      expect(harness.isConnected).toBe(false);
      expect(connectedEvents).toEqual([]);

      await client.emit({ type: 'server.connected' });
      await connectPromise;

      expect(harness.isConnected).toBe(true);
      expect(connectedEvents).toEqual(['connected']);
    } finally {
      harness.dispose();
    }
  });

  it('runs a prompt through OpenCode events and completes the turn after idle', async () => {
    const { client, harness } = createHarness();
    const runtimeOutputEvents: AcpMessage[] = [];
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];
    const turnCompletedEvents: AcpTurnCompletedEvent[] = [];
    const inferenceUsageEvents: HarnessInferenceUsageEvent[] = [];
    const taskEvents: TaskEvent[] = [];

    harness.subscribeRuntimeOutput((event) => runtimeOutputEvents.push(event));
    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );
    harness.subscribeRuntimeTurnCompleted((event) =>
      turnCompletedEvents.push(event),
    );
    harness.subscribeRuntimeInferenceUsage((event) =>
      inferenceUsageEvents.push(event),
    );
    harness.subscribe((event) => taskEvents.push(event));

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'Say exactly OK.',
            visibleInTranscript: true,
            source: 'web',
            userId: 'user-1',
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      expect(client.promptAsync.mock.calls[0]?.[0]).toMatchObject({
        sessionId: 'ses_1',
        request: {
          model: {
            providerID: TEST_OPENCODE_MODEL_SELECTION.providerID,
            modelID: TEST_OPENCODE_MODEL_SELECTION.modelID,
          },
          agent: 'build',
          parts: [{ type: 'text', text: 'Say exactly OK.' }],
        },
      });
      expect(taskEvents[0]).toEqual({
        eventName: TaskEventName.TaskStarted,
        payload: ['ses_1'],
      });
      expect(
        persistedEnvelopes.some(
          (envelope) =>
            envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt &&
            envelope.payload.text === 'Say exactly OK.',
        ),
      ).toBe(true);

      client.message.mockResolvedValueOnce(createFinalAssistantMessage());

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'text',
            text: 'O',
          },
          delta: 'O',
        },
      });
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'text',
            text: 'OK',
          },
          delta: 'K',
        },
      });
      await client.emit({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_1',
            sessionID: 'ses_1',
            role: 'assistant',
            time: {
              completed: 1,
            },
          },
        },
      });
      await client.emit({
        type: 'session.idle',
        properties: {
          sessionID: 'ses_1',
        },
      });

      await vi.waitFor(() => {
        expect(turnCompletedEvents).toHaveLength(1);
      });

      expect(
        runtimeOutputEvents
          .filter(
            (event) =>
              event.eventType ===
              ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk,
          )
          .map((event) => event.text),
      ).toEqual(['O', 'K']);
      expect(
        runtimeOutputEvents.some(
          (event) =>
            event.eventType === ACP_LIVE_EVENT_TYPES.UsageUpdate &&
            event.payload.used === 15,
        ),
      ).toBe(true);
      expect(
        runtimeOutputEvents.some(
          (event) =>
            event.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        ),
      ).toBe(false);
      expect(
        persistedEnvelopes.some(
          (envelope) =>
            envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage &&
            envelope.payload.text === 'OK',
        ),
      ).toBe(true);
      expect(turnCompletedEvents[0]).toMatchObject({
        sessionId: 'ses_1',
        text: 'OK',
      });

      const taskCompletedEvent = taskEvents.find(
        (event) => event.eventName === TaskEventName.TaskCompleted,
      );
      expect(taskCompletedEvent?.payload[1]).toMatchObject({
        totalTokensIn: 5,
        totalTokensOut: 2,
        totalCacheReads: 3,
        totalCacheWrites: 4,
        contextTokens: 8,
      });
      expect(inferenceUsageEvents).toEqual([
        {
          sessionId: 'ses_1',
          messageId: 'msg_1',
          providerId: 'openrouter',
          modelId: 'openai/gpt-5.4',
          agent: 'build',
          inputTokens: 5,
          outputTokens: 2,
          reasoningTokens: 1,
          cacheReadTokens: 3,
          cacheWriteTokens: 4,
          totalTokens: 15,
          contextTokens: 8,
          costMicroUsd: 123,
          costSource: 'opencode_message',
          messageCreatedAt: new Date(0),
          messageCompletedAt: new Date(1),
        },
      ]);
    } finally {
      harness.dispose();
    }
  });

  it('records inference usage for completed child-session (subagent) assistant messages', async () => {
    const { client, harness } = createHarness();
    const inferenceUsageEvents: HarnessInferenceUsageEvent[] = [];

    harness.subscribeRuntimeInferenceUsage((event) =>
      inferenceUsageEvents.push(event),
    );

    try {
      await connectHarness(harness, client);

      harness.sendCommand({
        commandName: TaskCommandName.StartNewTask,
        data: {
          text: 'Spawn a subagent.',
          visibleInTranscript: true,
          source: 'web',
          userId: 'user-1',
        },
      });

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      const childAssistantInfo = {
        id: 'msg_child_1',
        sessionID: 'ses_child_1',
        role: 'assistant',
        providerID: 'openrouter',
        modelID: 'openai/gpt-5.4-mini',
        mode: 'explore',
        time: {
          created: 10,
          completed: 20,
        },
        cost: 0.000456,
        tokens: {
          input: 7,
          output: 3,
          reasoning: 0,
          cache: {
            read: 2,
            write: 1,
          },
        },
      };

      // Incomplete child assistant messages are ignored.
      await client.emit({
        type: 'message.updated',
        properties: {
          info: {
            ...childAssistantInfo,
            time: { created: 10 },
          },
        },
      });
      expect(inferenceUsageEvents).toEqual([]);

      await client.emit({
        type: 'message.updated',
        properties: { info: childAssistantInfo },
      });
      // Replayed completion events do not double-count the same message.
      await client.emit({
        type: 'message.updated',
        properties: { info: childAssistantInfo },
      });

      expect(inferenceUsageEvents).toEqual([
        {
          sessionId: 'ses_child_1',
          messageId: 'msg_child_1',
          providerId: 'openrouter',
          modelId: 'openai/gpt-5.4-mini',
          agent: 'explore',
          inputTokens: 7,
          outputTokens: 3,
          reasoningTokens: 0,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          totalTokens: 13,
          contextTokens: 9,
          costMicroUsd: 456,
          costSource: 'opencode_message',
          messageCreatedAt: new Date(10),
          messageCompletedAt: new Date(20),
        },
      ]);
      // Child-session usage never reaches the main-session transcript fetch.
      expect(client.message).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it('persists a consolidated AssistantThought from reasoning parts', async () => {
    const { client, harness } = createHarness();
    const runtimeOutputEvents: AcpMessage[] = [];
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];
    const turnCompletedEvents: AcpTurnCompletedEvent[] = [];

    harness.subscribeRuntimeOutput((event) => runtimeOutputEvents.push(event));
    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );
    harness.subscribeRuntimeTurnCompleted((event) =>
      turnCompletedEvents.push(event),
    );

    try {
      await connectHarness(harness, client);

      harness.sendCommand({
        commandName: TaskCommandName.StartNewTask,
        data: {
          text: 'Think, then answer.',
          visibleInTranscript: true,
          source: 'web',
          userId: 'user-1',
        },
      });

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      // Streamed reasoning chunk (live only).
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'rpart_1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'reasoning',
            text: 'Because reasons.',
          },
          delta: 'Because reasons.',
        },
      });

      // Completed message carries the reasoning part plus the answer.
      client.message.mockResolvedValueOnce({
        info: {
          id: 'msg_1',
          sessionID: 'ses_1',
          role: 'assistant',
          time: { completed: 1 },
          tokens: { input: 5, output: 2, reasoning: 1, cache: { read: 3 } },
        },
        parts: [
          {
            id: 'rpart_1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'reasoning',
            text: 'Because reasons.',
          },
          {
            id: 'part_1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'text',
            text: 'OK',
          },
        ],
      });

      await client.emit({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_1',
            sessionID: 'ses_1',
            role: 'assistant',
            time: { completed: 1 },
          },
        },
      });
      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      });

      await vi.waitFor(() => {
        expect(turnCompletedEvents).toHaveLength(1);
      });

      // Live streaming chunk was emitted.
      expect(
        runtimeOutputEvents.some(
          (event) =>
            event.eventType ===
              ACP_ENVELOPE_EVENT_TYPES.AssistantThoughtChunk &&
            event.text === 'Because reasons.',
        ),
      ).toBe(true);

      // The consolidated thought is not re-emitted live after the reasoning
      // already streamed; a live re-emit would duplicate the "Thought" block.
      expect(
        runtimeOutputEvents.some(
          (event) =>
            event.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantThought,
        ),
      ).toBe(false);

      // Consolidated thought is persisted with the full reasoning text...
      const thought = persistedEnvelopes.find(
        (envelope) =>
          envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantThought,
      );
      expect(thought?.payload.text).toBe('Because reasons.');

      // ...and it lands before the answer message in the transcript.
      const thoughtIndex = persistedEnvelopes.findIndex(
        (envelope) =>
          envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantThought,
      );
      const messageIndex = persistedEnvelopes.findIndex(
        (envelope) =>
          envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
      );
      expect(thoughtIndex).toBeGreaterThanOrEqual(0);
      expect(messageIndex).toBeGreaterThanOrEqual(0);
      expect(thoughtIndex).toBeLessThan(messageIndex);
    } finally {
      harness.dispose();
    }
  });

  it('emits the consolidated AssistantThought live when reasoning never streamed', async () => {
    const { client, harness } = createHarness();
    const runtimeOutputEvents: AcpMessage[] = [];
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];
    const turnCompletedEvents: AcpTurnCompletedEvent[] = [];

    harness.subscribeRuntimeOutput((event) => runtimeOutputEvents.push(event));
    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );
    harness.subscribeRuntimeTurnCompleted((event) =>
      turnCompletedEvents.push(event),
    );

    try {
      await connectHarness(harness, client);

      harness.sendCommand({
        commandName: TaskCommandName.StartNewTask,
        data: {
          text: 'Think, then answer.',
          visibleInTranscript: true,
          source: 'web',
          userId: 'user-1',
        },
      });

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      // Completed message carries reasoning that was never streamed as
      // `message.part.updated` events (e.g. it only arrived on completion).
      client.message.mockResolvedValueOnce({
        info: {
          id: 'msg_1',
          sessionID: 'ses_1',
          role: 'assistant',
          time: { completed: 1 },
          tokens: { input: 5, output: 2, reasoning: 1, cache: { read: 3 } },
        },
        parts: [
          {
            id: 'rpart_1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'reasoning',
            text: 'Because reasons.',
          },
          {
            id: 'part_1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'text',
            text: 'OK',
          },
        ],
      });

      await client.emit({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_1',
            sessionID: 'ses_1',
            role: 'assistant',
            time: { completed: 1 },
          },
        },
      });
      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      });

      await vi.waitFor(() => {
        expect(turnCompletedEvents).toHaveLength(1);
      });

      // Without streamed reasoning chunks, the consolidated thought must be
      // emitted live so the transcript still shows the reasoning block.
      expect(
        runtimeOutputEvents.some(
          (event) =>
            event.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantThought &&
            event.text === 'Because reasons.',
        ),
      ).toBe(true);

      const thought = persistedEnvelopes.find(
        (envelope) =>
          envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantThought,
      );
      expect(thought?.payload.text).toBe('Because reasons.');
    } finally {
      harness.dispose();
    }
  });

  it('submits OpenCode model overrides with native provider and model IDs', async () => {
    const { client, harness } = createHarness(undefined, {
      model: 'provider-id/model-id',
    });

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'Try GLM.',
            visibleInTranscript: true,
            source: 'web',
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      expect(client.promptAsync.mock.calls[0]?.[0]).toMatchObject({
        sessionId: 'ses_1',
        request: {
          model: {
            providerID: 'provider-id',
            modelID: 'model-id',
          },
          agent: 'build',
          parts: [{ type: 'text', text: 'Try GLM.' }],
        },
      });
    } finally {
      harness.dispose();
    }
  });

  it('materializes image prompts and adds a visual delegation reminder when the visual subagent is configured', async () => {
    const imageDataUrl = 'data:image/png;base64,ZmFrZS1pbWFnZS1ieXRlcw==';
    const { client, harness } = createHarness(undefined, {
      commandEnv: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          agent: {
            visual: {
              mode: 'subagent',
              hidden: true,
            },
          },
        }),
      },
    });

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'What does this screenshot show?',
            images: [imageDataUrl],
            visibleInTranscript: true,
            source: 'web',
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      const promptCall = client.promptAsync.mock.calls[0]?.[0] as
        | { request?: { agent?: string; parts?: Record<string, unknown>[] } }
        | undefined;

      expect(promptCall?.request?.agent).toBe('build');
      expect(promptCall?.request?.parts).toEqual([
        {
          type: 'text',
          text: expect.stringContaining('What does this screenshot show?'),
        },
      ]);
      const promptText = promptCall?.request?.parts?.[0]?.text;
      expect(promptText).toEqual(
        expect.stringContaining('Do not say you cannot view images.'),
      );
      expect(promptText).toEqual(expect.stringContaining('agent "visual"'));
      expect(promptText).toEqual(
        expect.stringContaining('Pass these exact OpenCode file references'),
      );

      const imagePath = /^- @(.+\/image-1\.png)$/mu.exec(
        typeof promptText === 'string' ? promptText : '',
      )?.[1];

      expect(imagePath).toBeDefined();
      expect(fs.readFileSync(imagePath!)).toEqual(
        Buffer.from('fake-image-bytes'),
      );

      client.message.mockResolvedValueOnce(createFinalAssistantMessage());
      await client.emit({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_1',
            sessionID: 'ses_1',
            role: 'assistant',
            time: {
              completed: 1,
            },
          },
        },
      });
      await client.emit({
        type: 'session.idle',
        properties: {
          sessionID: 'ses_1',
        },
      });

      expect(fs.existsSync(imagePath!)).toBe(true);
      harness.dispose();

      await vi.waitFor(() => {
        expect(fs.existsSync(imagePath!)).toBe(false);
      });
    } finally {
      harness.dispose();
    }
  });

  it('falls back without a visual reminder for non-inline image strings', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-opencode-visual-path-'),
    );
    const localImagePath = path.join(tempDir, 'local-image.png');
    fs.writeFileSync(localImagePath, Buffer.from('local-image-bytes'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { client, harness } = createHarness(undefined, {
      commandEnv: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          agent: {
            visual: {
              mode: 'subagent',
              hidden: true,
            },
          },
        }),
      },
    });

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'What do these images show?',
            images: ['https://example.test/screenshot.png', localImagePath],
            visibleInTranscript: true,
            source: 'web',
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(client.promptAsync.mock.calls[0]?.[0]).toMatchObject({
        request: {
          agent: 'build',
          parts: [
            {
              type: 'file',
              mime: 'image/png',
              filename: 'screenshot.png',
              url: 'https://example.test/screenshot.png',
            },
            {
              type: 'file',
              mime: 'image/png',
              filename: 'local-image.png',
              url: localImagePath,
            },
            {
              type: 'text',
              text: 'What do these images show?',
            },
          ],
        },
      });
    } finally {
      fetchSpy.mockRestore();
      harness.dispose();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('leaves image prompts unchanged when the visual subagent is not configured', async () => {
    const imageDataUrl = 'data:image/png;base64,ZmFrZS1pbWFnZS1ieXRlcw==';
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'What does this screenshot show?',
            images: [imageDataUrl],
            visibleInTranscript: true,
            source: 'web',
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      expect(client.promptAsync.mock.calls[0]?.[0]).toMatchObject({
        request: {
          agent: 'build',
          parts: [
            {
              type: 'file',
              mime: 'image/png',
              filename: 'image.png',
              url: imageDataUrl,
            },
            {
              type: 'text',
              text: 'What does this screenshot show?',
            },
          ],
        },
      });
    } finally {
      harness.dispose();
    }
  });

  it('switches to the architect agent after the primary session loads the plan skill', async () => {
    const { client, harness } = createHarness(new FakeOpenCodeServerClient());

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'Plan the rollout.',
            visibleInTranscript: true,
            source: 'web',
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      expect(client.promptAsync.mock.calls[0]?.[0]).toMatchObject({
        request: { agent: 'build' },
      });

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'skill_part_child_enabled',
            sessionID: 'ses_child',
            messageID: 'msg_child_enabled',
            type: 'tool',
            callID: 'skill_call_child_enabled',
            tool: 'skill',
            state: {
              status: 'completed',
              input: { name: 'plan-repo-implementation' },
              title: 'Load skill',
            },
          },
        },
      });

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'skill_part_1_enabled',
            sessionID: 'ses_1',
            messageID: 'msg_1_enabled',
            type: 'tool',
            callID: 'skill_call_1_enabled',
            tool: 'skill',
            state: {
              status: 'completed',
              input: { name: 'plan-repo-implementation' },
              title: 'Load skill',
            },
          },
        },
      });

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.SendMessage,
          data: {
            text: 'Sounds good, keep planning.',
            autoSteerWhenQueued: true,
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });

      expect(client.promptAsync.mock.calls[1]?.[0]).toMatchObject({
        request: { agent: 'architect' },
      });
      // Architect-agent prompts omit the request-level model so the
      // agent-level planning model from the generated config can apply.
      const architectPromptRequest = (
        client.promptAsync.mock.calls[1]?.[0] as {
          request: Record<string, unknown>;
        }
      ).request;
      expect(architectPromptRequest).not.toHaveProperty('model');

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'skill_part_2_enabled',
            sessionID: 'ses_1',
            messageID: 'msg_2_enabled',
            type: 'tool',
            callID: 'skill_call_2_enabled',
            tool: 'skill',
            state: {
              status: 'completed',
              input: { name: 'implement-changes' },
              title: 'Load skill',
            },
          },
        },
      });

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.SendMessage,
          data: {
            text: 'Now build it.',
            autoSteerWhenQueued: true,
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(3);
      });

      expect(client.promptAsync.mock.calls[2]?.[0]).toMatchObject({
        request: { agent: 'build' },
      });
    } finally {
      harness.dispose();
    }
  });

  it('auto-submits one hidden continuation on the build agent after an in-flight plan turn loads implement-changes', async () => {
    const { client, harness } = createHarness(new FakeOpenCodeServerClient());
    const runtimeOutputEvents: AcpMessage[] = [];

    harness.subscribeRuntimeOutput((event) => runtimeOutputEvents.push(event));

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'Plan the rollout.',
            visibleInTranscript: true,
            source: 'web',
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'skill_part_plan',
            sessionID: 'ses_1',
            messageID: 'msg_plan',
            type: 'tool',
            callID: 'skill_call_plan',
            tool: 'skill',
            state: {
              status: 'completed',
              input: { name: 'plan-repo-implementation' },
              title: 'Load skill',
            },
          },
        },
      });

      // The exit flip happens mid-turn; repeated completed skill-load events
      // must queue at most one continuation.
      for (const partId of ['skill_part_impl_1', 'skill_part_impl_2']) {
        await client.emit({
          type: 'message.part.updated',
          properties: {
            part: {
              id: partId,
              sessionID: 'ses_1',
              messageID: 'msg_impl',
              type: 'tool',
              callID: `call_${partId}`,
              tool: 'skill',
              state: {
                status: 'completed',
                input: { name: 'implement-changes' },
                title: 'Load skill',
              },
            },
          },
        });
      }

      client.message.mockResolvedValueOnce(createFinalAssistantMessage());
      await client.emit({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_1',
            sessionID: 'ses_1',
            role: 'assistant',
            time: { completed: 1 },
          },
        },
      });
      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      });

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });

      expect(client.promptAsync.mock.calls[1]?.[0]).toMatchObject({
        request: {
          agent: 'build',
          // The continuation runs on the writable agent, so the request-level
          // model applies again.
          model: {
            providerID: TEST_OPENCODE_MODEL_SELECTION.providerID,
            modelID: TEST_OPENCODE_MODEL_SELECTION.modelID,
          },
          parts: [
            {
              type: 'text',
              text: 'The read-only planning restriction has been lifted. Continue immediately with the implementation the user requested; earlier edit denials no longer apply.',
            },
          ],
        },
      });

      // The internal continuation must not surface as a user-visible queued
      // message (web UI / Slack), but it still counts as deliverable so the
      // task stays alive until the continuation turn drains.
      const queuedMessagesUpdates = runtimeOutputEvents.filter(
        (event) =>
          event.eventType === ACP_ENVELOPE_EVENT_TYPES.QueuedMessagesUpdate,
      );

      expect(queuedMessagesUpdates).not.toEqual([]);
      for (const update of queuedMessagesUpdates) {
        const queuedMessages = Array.isArray(update.payload?.queuedMessages)
          ? update.payload!.queuedMessages
          : [];

        expect(queuedMessages).not.toContainEqual(
          expect.objectContaining({
            text: expect.stringContaining(
              'read-only planning restriction has been lifted',
            ),
          }),
        );
      }

      expect(
        harness
          .getQueuedMessages()
          .some((message) =>
            message.text.includes(
              'read-only planning restriction has been lifted',
            ),
          ),
      ).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it('does not emit submitted user prompt parts as assistant chunks', async () => {
    const { client, harness } = createHarness();
    const runtimeOutputEvents: AcpMessage[] = [];

    harness.subscribeRuntimeOutput((event) => runtimeOutputEvents.push(event));

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'Hi there',
            visibleInTranscript: true,
            source: 'web',
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      const promptRequest = client.promptAsync.mock.calls[0]?.[0] as
        | { request?: { messageID?: string } }
        | undefined;
      const userMessageId = promptRequest?.request?.messageID;

      expect(userMessageId).toMatch(/^msg_[a-f0-9]{12}0{14}$/);
      expect(userMessageId).not.toContain('roomote');

      const sameTickAssistantId = `${userMessageId!.slice(0, 16)}${'0'.repeat(13)}1`;
      expect(userMessageId! < sameTickAssistantId).toBe(true);

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'user_part_1',
            sessionID: 'ses_1',
            messageID: userMessageId,
            type: 'text',
            text: 'Hi there',
          },
        },
      });
      await client.emit({
        type: 'message.part.updated',
        properties: {
          info: {
            id: 'opencode_user_msg_1',
            sessionID: 'ses_1',
            role: 'user',
          },
          part: {
            id: 'user_part_2',
            sessionID: 'ses_1',
            messageID: 'opencode_user_msg_1',
            type: 'text',
            text: 'Hi there',
          },
        },
      });
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'assistant_part_1',
            sessionID: 'ses_1',
            messageID: 'assistant_msg_1',
            type: 'text',
            text: 'Hey. What do you need help with?',
          },
          delta: 'Hey. What do you need help with?',
        },
      });

      expect(
        runtimeOutputEvents
          .filter(
            (event) =>
              event.eventType ===
              ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk,
          )
          .map((event) => event.text),
      ).toEqual(['Hey. What do you need help with?']);
    } finally {
      harness.dispose();
    }
  });

  it('injects the Slack closeout reminder instead of completing when the OpenCode stop guard blocks', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-opencode-stop-guard-'),
    );
    const stateFilePath = path.join(tempDir, 'slack-state.json');
    const stopHookPath = path.join(tempDir, 'stop-hook.cjs');

    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: '111.222',
        currentTurnStartedAtMs: Date.now() - 1_000,
      }),
      'utf8',
    );
    fs.writeFileSync(stopHookPath, SLACK_STOP_HOOK_SCRIPT, 'utf8');

    const { client, harness } = createHarness(new FakeOpenCodeServerClient(), {
      commandEnv: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
        ROOMOTE_OPENCODE_SLACK_STOP_HOOK_SCRIPT: stopHookPath,
      },
    });
    const taskEvents: TaskEvent[] = [];

    harness.subscribe((event) => taskEvents.push(event));

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'Do work.',
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      client.message.mockResolvedValueOnce(createFinalAssistantMessage());

      await client.emit({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_1',
            sessionID: 'ses_1',
            role: 'assistant',
            time: {
              completed: 1,
            },
          },
        },
      });
      await client.emit({
        type: 'session.idle',
        properties: {
          sessionID: 'ses_1',
        },
      });

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });

      expect(client.promptAsync.mock.calls[1]?.[0]).toMatchObject({
        sessionId: 'ses_1',
        request: {
          parts: [
            {
              type: 'text',
              text: expect.stringContaining(
                'Before finalizing, post a terminal Slack-visible reply',
              ),
            },
          ],
        },
      });
      expect(
        taskEvents.some(
          (event) => event.eventName === TaskEventName.TaskCompleted,
        ),
      ).toBe(false);
    } finally {
      harness.dispose();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('completes the turn after exhausting Slack closeout reminders instead of aborting', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-opencode-stop-guard-give-up-'),
    );
    const stateFilePath = path.join(tempDir, 'slack-state.json');
    const stopHookPath = path.join(tempDir, 'stop-hook.cjs');

    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: '111.222',
        currentTurnStartedAtMs: Date.now() - 1_000,
      }),
      'utf8',
    );
    fs.writeFileSync(stopHookPath, SLACK_STOP_HOOK_SCRIPT, 'utf8');

    const { client, harness } = createHarness(new FakeOpenCodeServerClient(), {
      commandEnv: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
        ROOMOTE_OPENCODE_SLACK_STOP_HOOK_SCRIPT: stopHookPath,
      },
    });
    const taskEvents: TaskEvent[] = [];

    harness.subscribe((event) => taskEvents.push(event));

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'Do work.',
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      // The first three blocked turn-ends inject closeout reminders.
      await client.emit({
        type: 'session.idle',
        properties: {
          sessionID: 'ses_1',
        },
      });
      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });

      await client.emit({
        type: 'session.idle',
        properties: {
          sessionID: 'ses_1',
        },
      });
      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(3);
      });

      await client.emit({
        type: 'session.idle',
        properties: {
          sessionID: 'ses_1',
        },
      });
      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(4);
      });

      // The next blocked turn-end gives up and completes the turn instead of
      // aborting the task or injecting more reminders.
      await client.emit({
        type: 'session.idle',
        properties: {
          sessionID: 'ses_1',
        },
      });

      await vi.waitFor(() => {
        expect(
          taskEvents.some(
            (event) => event.eventName === TaskEventName.TaskCompleted,
          ),
        ).toBe(true);
      });
      expect(
        taskEvents.some(
          (event) => event.eventName === TaskEventName.TaskAborted,
        ),
      ).toBe(false);
      expect(client.promptAsync).toHaveBeenCalledTimes(4);
    } finally {
      harness.dispose();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('force-completes the turn when a stop-hook reminder wedges with no follow-up turn', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-opencode-stop-guard-wedge-'),
    );
    const stateFilePath = path.join(tempDir, 'slack-state.json');
    const stopHookPath = path.join(tempDir, 'stop-hook.cjs');

    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: '111.222',
        currentTurnStartedAtMs: Date.now() - 1_000,
      }),
      'utf8',
    );
    fs.writeFileSync(stopHookPath, SLACK_STOP_HOOK_SCRIPT, 'utf8');

    const { client, harness } = createHarness(new FakeOpenCodeServerClient(), {
      commandEnv: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
        ROOMOTE_OPENCODE_SLACK_STOP_HOOK_SCRIPT: stopHookPath,
      },
      stopHookReminderStallTimeoutMs: 50,
    });
    const taskEvents: TaskEvent[] = [];

    harness.subscribe((event) => taskEvents.push(event));

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: { text: 'Do work.', visibleInTranscript: true },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      // The blocked turn-end injects a closeout reminder and then awaits a
      // fresh turn to re-evaluate.
      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      });
      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });

      // The session then wedges: no further events ever arrive. The fail-safe
      // fires and force-completes the turn so the task reaches a terminal
      // state instead of hanging "running" forever.
      await vi.waitFor(() => {
        expect(
          taskEvents.some(
            (event) => event.eventName === TaskEventName.TaskCompleted,
          ),
        ).toBe(true);
      });
      expect(
        taskEvents.some(
          (event) => event.eventName === TaskEventName.TaskAborted,
        ),
      ).toBe(false);
      // No extra reminder was injected — the fail-safe completed the turn.
      expect(client.promptAsync).toHaveBeenCalledTimes(2);
    } finally {
      harness.dispose();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('disarms the stop-hook reminder fail-safe on teardown', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-opencode-stop-guard-teardown-'),
    );
    const stateFilePath = path.join(tempDir, 'slack-state.json');
    const stopHookPath = path.join(tempDir, 'stop-hook.cjs');

    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: '111.222',
        currentTurnStartedAtMs: Date.now() - 1_000,
      }),
      'utf8',
    );
    fs.writeFileSync(stopHookPath, SLACK_STOP_HOOK_SCRIPT, 'utf8');

    const { client, harness } = createHarness(new FakeOpenCodeServerClient(), {
      commandEnv: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
        ROOMOTE_OPENCODE_SLACK_STOP_HOOK_SCRIPT: stopHookPath,
      },
      stopHookReminderStallTimeoutMs: 50,
    });
    const taskEvents: TaskEvent[] = [];

    harness.subscribe((event) => taskEvents.push(event));

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: { text: 'Do work.', visibleInTranscript: true },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      // Blocked turn-end injects a reminder and arms the fail-safe.
      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      });
      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });

      // Teardown must disarm the pending fail-safe. Dispose, then wait well
      // past the stall window and confirm it never force-completed a disposed
      // harness.
      harness.dispose();
      await new Promise((resolve) => setTimeout(resolve, 120));

      expect(
        taskEvents.some(
          (event) => event.eventName === TaskEventName.TaskCompleted,
        ),
      ).toBe(false);
    } finally {
      harness.dispose();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('injects queued auto-steer into the active turn without aborting it', async () => {
    const { client, harness } = createHarness();
    const taskEvents: TaskEvent[] = [];

    harness.subscribe((event) => taskEvents.push(event));

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'Start work.',
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.SendMessage,
          data: {
            text: 'Use this newer instruction instead.',
            autoSteerWhenQueued: true,
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });

      // Native mid-turn steering: the prompt is injected into the running
      // turn via prompt_async; the active work is NOT aborted.
      expect(client.abort).toHaveBeenCalledTimes(0);
      expect(client.promptAsync.mock.calls[1]?.[0]).toMatchObject({
        sessionId: 'ses_1',
        request: {
          parts: [
            {
              type: 'text',
              text: 'Use this newer instruction instead.',
            },
          ],
        },
      });
      expect(harness.getQueuedMessages()).toEqual([]);
      expect(
        taskEvents.some(
          (event) => event.eventName === TaskEventName.TaskAborted,
        ),
      ).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it('advertises native turn steering so steers use the suppressed interrupt path', () => {
    const { harness } = createHarness();

    try {
      // steerTask only routes an active turn through the suppressed
      // interrupt-and-replay path when the harness reports native turn
      // steering. Returning false here makes it fall back to a terminal
      // cancel, which surfaces the abort error and emits TaskAborted.
      expect(harness.supportsNativeTurnSteering).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it('falls back to queued replay and suppresses the MessageAbortedError when injection fails', async () => {
    const { client, harness } = createHarness();
    const taskEvents: TaskEvent[] = [];
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];

    harness.subscribe((event) => taskEvents.push(event));
    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );

    try {
      await connectHarness(harness, client);

      harness.sendCommand({
        commandName: TaskCommandName.StartNewTask,
        data: { text: 'Start work.', visibleInTranscript: true },
      });
      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });
      await client.emit({
        type: 'session.status',
        properties: { sessionID: 'ses_1', status: { type: 'busy' } },
      });

      // Force the native injection to fail so the steer falls back to the
      // queued abort-and-replay path.
      client.promptAsync.mockRejectedValueOnce(new Error('injection refused'));

      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: {
          text: 'Steer to this instead.',
          autoSteerWhenQueued: true,
          visibleInTranscript: true,
        },
      });
      await vi.waitFor(() => {
        expect(client.abort).toHaveBeenCalledTimes(1);
        expect(client.promptAsync).toHaveBeenCalledTimes(3);
      });

      // OpenCode reports the aborted turn as a MessageAbortedError. The
      // interrupt armed suppression, so this must NOT become a terminal abort
      // or a user-visible "OpenCode session error" transcript message.
      await client.emit({
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
        },
      });

      expect(
        taskEvents.some(
          (event) => event.eventName === TaskEventName.TaskAborted,
        ),
      ).toBe(false);
      expect(
        persistedEnvelopes.some((envelope) =>
          envelope.contentBlocks?.some(
            (block) =>
              block.type === 'text' &&
              typeof block.text === 'string' &&
              block.text.includes('OpenCode session error'),
          ),
        ),
      ).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it('immediately aborts and clears queued prompts for explicit non-retryable provider errors', async () => {
    const { client, harness } = createHarness();
    const taskEvents: TaskEvent[] = [];

    harness.subscribe((event) => taskEvents.push(event));

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'Start work.',
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.SendMessage,
          data: {
            text: 'Queued follow-up.',
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);
      expect(harness.getQueuedMessages()).toHaveLength(1);

      await client.emit({
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: {
            name: 'APIError',
            data: {
              message: 'The selected model is not available in your region.',
              statusCode: 403,
              isRetryable: false,
            },
          },
        },
      });

      expect(
        taskEvents.some(
          (event) => event.eventName === TaskEventName.TaskAborted,
        ),
      ).toBe(true);
      expect(harness.getQueuedMessages()).toEqual([]);
      expect(client.promptAsync).toHaveBeenCalledTimes(1);
    } finally {
      harness.dispose();
    }
  });

  it('retries a cyber policy refusal with safer framing without aborting the task', async () => {
    const { client, harness } = createHarness();
    const taskEvents: TaskEvent[] = [];
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];

    harness.subscribe((event) => taskEvents.push(event));
    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'Review the change.',
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.SendMessage,
          data: {
            text: 'Queued follow-up.',
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      await client.emit({
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: {
            name: 'UnknownError',
            data: {
              message: JSON.stringify({
                type: 'error',
                error: {
                  type: 'invalid_request',
                  code: 'cyber_policy',
                  message:
                    'This content was flagged for possible cybersecurity risk.',
                },
              }),
            },
          },
        },
      });

      // OpenCode reports the error before the failed runner reaches idle. The
      // retry must remain queued until that boundary or it can be appended to
      // the dying run without starting a fresh model loop.
      expect(client.promptAsync).toHaveBeenCalledTimes(1);

      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      });

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });

      const retryPrompt = client.promptAsync.mock.calls[1]?.[0] as
        | {
            request?: {
              parts?: Array<{ type?: string; text?: string }>;
            };
          }
        | undefined;
      const retryPromptText = (retryPrompt?.request?.parts ?? [])
        .map((part) => part.text)
        .filter((text): text is string => typeof text === 'string')
        .join('\n');

      expect(retryPromptText).toContain('Continue the legitimate task');
      expect(retryPromptText).toContain('Do not attempt to bypass the policy');
      expect(
        taskEvents.some(
          (event) => event.eventName === TaskEventName.TaskAborted,
        ),
      ).toBe(false);
      expect(
        persistedEnvelopes.some(
          (envelope) =>
            envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage &&
            String(envelope.payload.text ?? '').includes(
              'Provider safety refusal; automatically retrying the turn',
            ),
        ),
      ).toBe(true);
      expect(
        harness.getQueuedMessages().map((message) => message.text),
      ).toEqual(['Queued follow-up.']);
    } finally {
      harness.dispose();
    }
  });

  it('retries an unknown provider error once before aborting', async () => {
    const { client, harness } = createHarness();
    const taskEvents: TaskEvent[] = [];

    harness.subscribe((event) => taskEvents.push(event));

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'Start work.',
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      const providerError = {
        name: 'UnknownError',
        data: { message: 'Upstream connection closed unexpectedly.' },
      };

      await client.emit({
        type: 'session.error',
        properties: { sessionID: 'ses_1', error: providerError },
      });

      expect(client.promptAsync).toHaveBeenCalledTimes(1);

      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      });

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });
      expect(
        taskEvents.some(
          (event) => event.eventName === TaskEventName.TaskAborted,
        ),
      ).toBe(false);

      await client.emit({
        type: 'session.error',
        properties: { sessionID: 'ses_1', error: providerError },
      });

      expect(
        taskEvents.some(
          (event) => event.eventName === TaskEventName.TaskAborted,
        ),
      ).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it('automatically retries OpenRouter-style rate_limit_exceeded session errors', async () => {
    vi.useFakeTimers();
    const { client, harness } = createHarness(undefined, {
      providerRateLimitBaseDelayMs: 1_000,
      providerRateLimitMaxRetries: 3,
    });
    const taskEvents: TaskEvent[] = [];
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];

    harness.subscribe((event) => taskEvents.push(event));
    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'Start work.',
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.SendMessage,
          data: {
            text: 'Queued follow-up.',
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);
      expect(harness.getQueuedMessages()).toHaveLength(1);

      await client.emit({
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: {
            name: 'UnknownError',
            data: {
              message: JSON.stringify({
                code: 429,
                message: 'Provider returned error',
                metadata: { error_type: 'rate_limit_exceeded' },
              }),
            },
          },
        },
      });

      expect(
        taskEvents.some(
          (event) => event.eventName === TaskEventName.TaskAborted,
        ),
      ).toBe(false);
      expect(
        persistedEnvelopes.some(
          (envelope) =>
            envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage &&
            String(envelope.payload.text ?? '').includes(
              'automatically retrying',
            ),
        ),
      ).toBe(true);
      // Invisible continue prompt stays out of the user-visible queue, while
      // preserving the existing follow-up for after the retry.
      expect(
        harness.getQueuedMessages().map((message) => message.text),
      ).toEqual(['Queued follow-up.']);

      await vi.advanceTimersByTimeAsync(1_000);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });
      const secondPrompt = client.promptAsync.mock.calls[1]?.[0] as
        | {
            request?: {
              parts?: Array<{ type?: string; text?: string }>;
            };
          }
        | undefined;
      const secondPromptText = (secondPrompt?.request?.parts ?? [])
        .map((part) => part.text)
        .filter((text): text is string => typeof text === 'string')
        .join('\n');
      expect(secondPromptText).toContain('temporary provider rate limit');
      expect(
        taskEvents.some(
          (event) => event.eventName === TaskEventName.TaskAborted,
        ),
      ).toBe(false);
    } finally {
      harness.dispose();
      vi.useRealTimers();
    }
  });

  it('does not drain a rate-limit continue prompt early when session.idle arrives during backoff', async () => {
    vi.useFakeTimers();
    const { client, harness } = createHarness(undefined, {
      providerRateLimitBaseDelayMs: 5_000,
      providerRateLimitMaxRetries: 3,
    });

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'Start work.',
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      await client.emit({
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: {
            name: 'UnknownError',
            data: {
              message: JSON.stringify({
                code: 429,
                message: 'Provider returned error',
                metadata: { error_type: 'rate_limit_exceeded' },
              }),
            },
          },
        },
      });

      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(client.promptAsync).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });
    } finally {
      harness.dispose();
      vi.useRealTimers();
    }
  });

  it('keeps the rate-limit continue ahead of steers queued during backoff', async () => {
    vi.useFakeTimers();
    const { client, harness } = createHarness(undefined, {
      providerRateLimitBaseDelayMs: 1_000,
      providerRateLimitMaxRetries: 3,
    });

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'Start work.',
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      await client.emit({
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: {
            name: 'UnknownError',
            data: {
              message: JSON.stringify({
                code: 429,
                message: 'Provider returned error',
                metadata: { error_type: 'rate_limit_exceeded' },
              }),
            },
          },
        },
      });

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.SendMessage,
          data: {
            text: 'Steer during backoff.',
            visibleInTranscript: true,
            autoSteerWhenQueued: true,
          },
        }),
      ).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });

      const secondPrompt = client.promptAsync.mock.calls[1]?.[0] as
        | {
            request?: {
              parts?: Array<{ type?: string; text?: string }>;
            };
          }
        | undefined;
      const secondPromptText = (secondPrompt?.request?.parts ?? [])
        .map((part) => part.text)
        .filter((text): text is string => typeof text === 'string')
        .join('\n');
      expect(secondPromptText).toContain('temporary provider rate limit');
      expect(secondPromptText).not.toContain('Steer during backoff.');
      expect(
        harness.getQueuedMessages().map((message) => message.text),
      ).toEqual(['Steer during backoff.']);
    } finally {
      harness.dispose();
      vi.useRealTimers();
    }
  });

  it('cancels rate-limit backoff so a later resume is not blocked by the timer', async () => {
    vi.useFakeTimers();
    const { client, harness } = createHarness(undefined, {
      providerRateLimitBaseDelayMs: 10_000,
      providerRateLimitMaxRetries: 3,
    });
    const taskEvents: TaskEvent[] = [];

    harness.subscribe((event) => taskEvents.push(event));

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'Start work.',
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      await client.emit({
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: {
            name: 'UnknownError',
            data: {
              message: JSON.stringify({
                code: 429,
                message: 'Provider returned error',
                metadata: { error_type: 'rate_limit_exceeded' },
              }),
            },
          },
        },
      });

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.CancelTask,
          data: {
            cancelledBy: { name: 'Tester', source: 'web' },
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(
          taskEvents.some(
            (event) => event.eventName === TaskEventName.TaskAborted,
          ),
        ).toBe(true);
      });

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.SendMessage,
          data: {
            text: 'Resume after cancel.',
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });
      const secondPrompt = client.promptAsync.mock.calls[1]?.[0] as
        | {
            request?: {
              parts?: Array<{ type?: string; text?: string }>;
            };
          }
        | undefined;
      const secondPromptText = (secondPrompt?.request?.parts ?? [])
        .map((part) => part.text)
        .filter((text): text is string => typeof text === 'string')
        .join('\n');
      expect(secondPromptText).toContain('Resume after cancel.');

      // Expired backoff after cancel must not submit a stale continue.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.promptAsync).toHaveBeenCalledTimes(2);
    } finally {
      harness.dispose();
      vi.useRealTimers();
    }
  });

  it('aborts after exhausting provider rate-limit retries', async () => {
    vi.useFakeTimers();
    const { client, harness } = createHarness(undefined, {
      providerRateLimitBaseDelayMs: 100,
      providerRateLimitMaxRetries: 2,
    });
    const taskEvents: TaskEvent[] = [];

    harness.subscribe((event) => taskEvents.push(event));

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'Start work.',
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      const rateLimitError = {
        name: 'UnknownError',
        data: {
          message: JSON.stringify({
            code: 429,
            message: 'Provider returned error',
            metadata: { error_type: 'rate_limit_exceeded' },
          }),
        },
      };

      await client.emit({
        type: 'session.error',
        properties: { sessionID: 'ses_1', error: rateLimitError },
      });
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });

      await client.emit({
        type: 'session.error',
        properties: { sessionID: 'ses_1', error: rateLimitError },
      });
      await vi.advanceTimersByTimeAsync(200);
      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(3);
      });

      await client.emit({
        type: 'session.error',
        properties: { sessionID: 'ses_1', error: rateLimitError },
      });

      expect(
        taskEvents.some(
          (event) => event.eventName === TaskEventName.TaskAborted,
        ),
      ).toBe(true);
      expect(harness.getQueuedMessages()).toEqual([]);
    } finally {
      harness.dispose();
      vi.useRealTimers();
    }
  });

  it('surfaces a readable provider message instead of the raw session error JSON', async () => {
    const { client, harness } = createHarness();
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];

    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'Start work.',
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      await client.emit({
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: {
            name: 'APIError',
            data: {
              message:
                '[xAI] The model grok-4.5 is not available in your region.',
              statusCode: 403,
              isRetryable: false,
              responseHeaders: { 'cf-ray': 'a184f336b9add2b6-FRA' },
              responseBody: '{"error":{"message":"Provider returned error"}}',
            },
          },
        },
      });

      const errorMessage = persistedEnvelopes.find(
        (envelope) =>
          envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage &&
          String(envelope.payload.text ?? '').includes(
            'The provider returned an error',
          ),
      );

      expect(String(errorMessage?.payload.text)).toBe(
        'The provider returned an error: [xAI] The model grok-4.5 is not available in your region.',
      );
      expect(String(errorMessage?.payload.text)).not.toContain(
        'responseHeaders',
      );
      expect(String(errorMessage?.payload.text)).not.toContain('cf-ray');
    } finally {
      harness.dispose();
    }
  });

  it('records OpenCode question tool requests and delivers answers as a follow-up prompt', async () => {
    const beforeQueuedPrompt = vi.fn(async () => undefined);
    const { client, harness } = createHarness(undefined, {
      beforeQueuedPrompt,
    });
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];
    const taskEvents: TaskEvent[] = [];

    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );
    harness.subscribe((event) => taskEvents.push(event));

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'Ask for input.',
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'question_part_1',
            sessionID: 'ses_1',
            messageID: 'msg_question',
            type: 'tool',
            callID: 'question_call_1',
            tool: 'question',
            state: {
              status: 'running',
              input: {
                questions: [
                  {
                    id: 'color',
                    header: 'Color',
                    question: 'Which color should I use?',
                    options: [{ label: 'Blue', description: 'Use blue.' }],
                  },
                ],
              },
              title: 'Ask user',
            },
          },
        },
      });

      const pendingRequest = harness.getPendingUserInputRequests()[0];
      expect(pendingRequest).toMatchObject({
        requestId: 'rui:ses_1:msg_question:question_call_1',
        sessionId: 'ses_1',
        turnId: 'msg_question',
        callId: 'question_call_1',
        questions: [
          {
            id: 'color',
            header: 'Color',
            question: 'Which color should I use?',
            // OpenCode's question schema allows custom answers by default,
            // so option-only questions must still accept free-form replies.
            isOther: true,
          },
        ],
      });
      expect(
        persistedEnvelopes.some(
          (envelope) =>
            envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
        ),
      ).toBe(true);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.AnswerUserInputRequest,
          data: {
            requestId: pendingRequest!.requestId,
            answers: {
              color: { answers: ['Blue'] },
            },
            userId: 'answer-user-1',
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.abort).toHaveBeenCalledTimes(1);
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });

      await client.emit({
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: {
            name: 'MessageAbortedError',
            data: { message: 'Aborted' },
          },
        },
      });

      expect(harness.getPendingUserInputRequests()).toEqual([]);
      const responseEnvelope = persistedEnvelopes.find(
        (envelope) =>
          envelope.eventType ===
            ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse &&
          envelope.payload.requestId === pendingRequest!.requestId,
      );
      expect(responseEnvelope?.payload).toMatchObject({
        requestId: pendingRequest!.requestId,
        resolution: 'submitted',
      });
      expect(beforeQueuedPrompt).toHaveBeenCalledWith({
        userId: 'answer-user-1',
      });
      expect(client.promptAsync.mock.calls[1]?.[0]).toMatchObject({
        sessionId: 'ses_1',
        request: {
          parts: [
            {
              type: 'text',
              text: expect.stringContaining('Blue'),
            },
          ],
        },
      });
      expect(
        taskEvents.some(
          (event) => event.eventName === TaskEventName.TaskAborted,
        ),
      ).toBe(false);
      expect(
        persistedEnvelopes.some(
          (envelope) =>
            envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage &&
            String(envelope.payload.text ?? '').includes(
              'OpenCode session error',
            ),
        ),
      ).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it('abandons the pending question when a steer aborts and replays the turn', async () => {
    const { client, harness } = createHarness();
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];

    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'Ask for input.',
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'question_part_1',
            sessionID: 'ses_1',
            messageID: 'msg_question',
            type: 'tool',
            callID: 'question_call_1',
            tool: 'question',
            state: {
              status: 'running',
              input: {
                questions: [
                  {
                    id: 'color',
                    header: 'Color',
                    question: 'Which color should I use?',
                    options: [{ label: 'Blue', description: 'Use blue.' }],
                  },
                ],
              },
              title: 'Ask user',
            },
          },
        },
      });

      expect(harness.getPendingUserInputRequests()).toHaveLength(1);

      // A steer sent while the question blocks the turn cannot inject
      // natively, so it enqueues and triggers abort-and-replay. That
      // abandons the question — the pending map must be cleared so
      // downstream phase/UI state does not stay blocked on it.
      expect(
        harness.sendCommand({
          commandName: TaskCommandName.SendMessage,
          data: {
            text: 'Actually, change direction.',
            autoSteerWhenQueued: true,
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      // Wait for the steer to fully abort and replay (its drained prompt is
      // the second promptAsync call) so the baseline below excludes it.
      await vi.waitFor(() => {
        expect(harness.getPendingUserInputRequests()).toEqual([]);
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });

      // A cancelled response is emitted for the abandoned question so
      // consumers that clear pending state only on a response (Slack,
      // Linear, the web store) cannot later accept a stale answer.
      const cancelledResponse = persistedEnvelopes.find(
        (envelope) =>
          envelope.eventType ===
            ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse &&
          envelope.payload.requestId ===
            'rui:ses_1:msg_question:question_call_1',
      );
      expect(cancelledResponse?.payload).toMatchObject({
        resolution: 'cancelled',
      });

      // A late answer to the abandoned question (e.g. a web POST opened
      // before the steer) must be rejected, not fabricated into the
      // replayed turn: no submitted response, no extra prompt submission.
      const promptCallsBeforeStaleAnswer = client.promptAsync.mock.calls.length;

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.AnswerUserInputRequest,
          data: {
            requestId: 'rui:ses_1:msg_question:question_call_1',
            answers: { color: { answers: ['Blue'] } },
            userId: 'stale-user',
          },
        }),
      ).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(client.promptAsync.mock.calls.length).toBe(
        promptCallsBeforeStaleAnswer,
      );
      expect(
        persistedEnvelopes.some(
          (envelope) =>
            envelope.eventType ===
              ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse &&
            envelope.payload.requestId ===
              'rui:ses_1:msg_question:question_call_1' &&
            envelope.payload.resolution === 'submitted',
        ),
      ).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it('honors an explicit custom-answer opt-out on OpenCode question input', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'Ask for input.',
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'question_part_1',
            sessionID: 'ses_1',
            messageID: 'msg_question',
            type: 'tool',
            callID: 'question_call_1',
            tool: 'question',
            state: {
              status: 'running',
              input: {
                questions: [
                  {
                    id: 'color',
                    header: 'Color',
                    question: 'Which color should I use?',
                    options: [{ label: 'Blue', description: 'Use blue.' }],
                    custom: false,
                  },
                  {
                    id: 'shape',
                    header: 'Shape',
                    question: 'Which shape should I use?',
                    options: [{ label: 'Circle', description: 'Use circle.' }],
                    isOther: false,
                  },
                ],
              },
              title: 'Ask user',
            },
          },
        },
      });

      expect(harness.getPendingUserInputRequests()[0]).toMatchObject({
        questions: [
          { id: 'color', isOther: false },
          { id: 'shape', isOther: false },
        ],
      });
    } finally {
      harness.dispose();
    }
  });

  it('updates OpenCode question requests when structured choices arrive after the initial tool event', async () => {
    const { client, harness } = createHarness();
    const runtimeOutputEvents: AcpMessage[] = [];
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];

    harness.subscribeRuntimeOutput((event) => runtimeOutputEvents.push(event));
    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );

    try {
      await connectHarness(harness, client);

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'question_part_1',
            sessionID: 'ses_1',
            messageID: 'msg_question',
            type: 'tool',
            callID: 'question_call_1',
            tool: 'question',
            state: {
              status: 'running',
            },
          },
        },
      });

      expect(harness.getPendingUserInputRequests()[0]).toMatchObject({
        requestId: 'rui:ses_1:msg_question:question_call_1',
        questions: [
          {
            id: 'response',
            question: 'Provide the requested input.',
            options: [],
          },
        ],
      });

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'question_part_1',
            sessionID: 'ses_1',
            messageID: 'msg_question',
            type: 'tool',
            callID: 'question_call_1',
            tool: 'question',
            state: {
              status: 'running',
              input: {
                questions: [
                  {
                    header: 'Smoke test',
                    question: 'Continue tool-call smoke test?',
                    options: [
                      {
                        label: 'Continue',
                        description: 'Proceed with the tool-call sequence.',
                      },
                      {
                        label: 'Cancel',
                        description: 'Stop the smoke test.',
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      });

      const updatedRequest = harness.getPendingUserInputRequests()[0];
      expect(updatedRequest).toMatchObject({
        requestId: 'rui:ses_1:msg_question:question_call_1',
        questions: [
          {
            id: 'question-1',
            header: 'Smoke test',
            question: 'Continue tool-call smoke test?',
            options: [
              {
                label: 'Continue',
                description: 'Proceed with the tool-call sequence.',
              },
              {
                label: 'Cancel',
                description: 'Stop the smoke test.',
              },
            ],
          },
        ],
      });

      const requestEnvelopes = persistedEnvelopes.filter(
        (envelope) =>
          envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
      );

      expect(requestEnvelopes).toHaveLength(2);
      expect(
        requestEnvelopes.map((envelope) => envelope.payload.requestId),
      ).toEqual([
        'rui:ses_1:msg_question:question_call_1',
        'rui:ses_1:msg_question:question_call_1',
      ]);
      expect(requestEnvelopes.at(-1)?.payload).toMatchObject({
        questions: [
          {
            question: 'Continue tool-call smoke test?',
            options: [{ label: 'Continue' }, { label: 'Cancel' }],
          },
        ],
      });
      expect(
        persistedEnvelopes.some(
          (envelope) =>
            envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolCall ||
            envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolResult,
        ),
      ).toBe(false);
      expect(
        runtimeOutputEvents.some(
          (event) =>
            event.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate,
        ),
      ).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it('records cancelled OpenCode question responses when answers are empty', async () => {
    const { client, harness } = createHarness();
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];

    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );

    try {
      await connectHarness(harness, client);

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.StartNewTask,
          data: {
            text: 'Ask for input.',
            visibleInTranscript: true,
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'question_part_1',
            sessionID: 'ses_1',
            messageID: 'msg_question',
            type: 'tool',
            callID: 'question_call_1',
            tool: 'question',
            state: {
              status: 'running',
              input: {
                questions: [
                  {
                    id: 'color',
                    header: 'Color',
                    question: 'Which color should I use?',
                  },
                ],
              },
              title: 'Ask user',
            },
          },
        },
      });

      const pendingRequest = harness.getPendingUserInputRequests()[0];
      expect(pendingRequest).toBeDefined();

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.AnswerUserInputRequest,
          data: {
            requestId: pendingRequest!.requestId,
            answers: {
              color: { answers: [] },
            },
          },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.abort).toHaveBeenCalledTimes(1);
      });

      const responseEnvelope = persistedEnvelopes.find(
        (envelope) =>
          envelope.eventType ===
            ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse &&
          envelope.payload.requestId === pendingRequest!.requestId,
      );
      expect(responseEnvelope?.payload).toMatchObject({
        requestId: pendingRequest!.requestId,
        resolution: 'cancelled',
      });
    } finally {
      harness.dispose();
    }
  });

  it('persists OpenCode tool starts and terminal results once', async () => {
    const { client, harness } = createHarness();
    const runtimeOutputEvents: AcpMessage[] = [];
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];

    harness.subscribeRuntimeOutput((event) => runtimeOutputEvents.push(event));
    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );

    try {
      await connectHarness(harness, client);

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool_part_1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'tool',
            callID: 'call_1',
            tool: 'bash',
            state: {
              status: 'pending',
              title: 'bash',
            },
          },
        },
      });
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool_part_1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'tool',
            callID: 'call_1',
            tool: 'bash',
            state: {
              status: 'running',
              input: { command: 'printf OK' },
              title: 'Run shell command',
              metadata: { cwd: '/tmp/workspace' },
            },
          },
        },
      });
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool_part_1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'tool',
            callID: 'call_1',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'printf OK' },
              output: 'OK\n',
              title: 'Run shell command',
              metadata: { exitCode: 0 },
            },
          },
        },
      });
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool_part_1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'tool',
            callID: 'call_1',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'printf OK' },
              output: 'OK\n',
              title: 'Run shell command',
              metadata: { exitCode: 0 },
            },
          },
        },
      });

      const toolCalls = persistedEnvelopes.filter(
        (envelope) => envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolCall,
      );
      const toolResults = persistedEnvelopes.filter(
        (envelope) =>
          envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolResult,
      );

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]?.payload).toMatchObject({
        sessionId: 'ses_1',
        turnId: 'msg_1',
        toolCallId: 'call_1',
        kind: 'execute',
        title: 'Run shell command',
        status: 'in_progress',
        isExecute: true,
        command: 'printf OK',
        rawInput: { command: 'printf OK' },
      });
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]?.payload).toMatchObject({
        sessionId: 'ses_1',
        turnId: 'msg_1',
        toolCallId: 'call_1',
        kind: 'execute',
        title: 'Run shell command',
        status: 'completed',
        isExecute: true,
        command: 'printf OK',
        exitCode: 0,
        output: 'OK\n',
      });
      expect(
        runtimeOutputEvents.some(
          (event) =>
            event.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate &&
            event.payload.status === 'completed' &&
            event.payload.output === 'OK\n',
        ),
      ).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it('emits live progress updates for running long-running OpenCode execute tools', async () => {
    const { client, harness } = createHarness(undefined, {
      executeToolProgressInitialDelayMs: 25,
      executeToolProgressIntervalMs: 50,
    });
    const runtimeOutputEvents: AcpMessage[] = [];
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];

    harness.subscribeRuntimeOutput((event) => runtimeOutputEvents.push(event));
    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool_part_progress',
            sessionID: 'ses_1',
            messageID: 'msg_progress',
            type: 'tool',
            callID: 'call_progress',
            tool: 'bash',
            state: {
              status: 'pending',
              input: { command: 'pnpm test' },
              title: 'Run tests',
            },
          },
        },
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(
        runtimeOutputEvents.some(
          (event) =>
            event.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate &&
            event.payload.progressKind === 'execute_tool_heartbeat',
        ),
      ).toBe(false);

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool_part_progress',
            sessionID: 'ses_1',
            messageID: 'msg_progress',
            type: 'tool',
            callID: 'call_progress',
            tool: 'bash',
            state: {
              status: 'running',
              input: { command: 'pnpm test' },
              title: 'Run tests',
            },
          },
        },
      });

      await vi.advanceTimersByTimeAsync(24);
      expect(
        runtimeOutputEvents.some(
          (event) =>
            event.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate &&
            event.payload.progressKind === 'execute_tool_heartbeat',
        ),
      ).toBe(false);

      await vi.advanceTimersByTimeAsync(1);

      const progressUpdates = runtimeOutputEvents.filter(
        (event) =>
          event.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate &&
          event.payload.progressKind === 'execute_tool_heartbeat',
      );
      expect(progressUpdates).toHaveLength(1);
      expect(progressUpdates[0]?.payload).toMatchObject({
        sessionId: 'ses_1',
        turnId: 'msg_progress',
        toolCallId: 'call_progress',
        name: 'bash',
        status: 'in_progress',
        running: true,
        command: 'pnpm test',
      });
      expect(progressUpdates[0]?.payload.output).toContain(
        'Command still running',
      );
      expect(progressUpdates[0]?.payload.output).toContain(
        'Command: pnpm test',
      );
      expect(
        persistedEnvelopes.some(
          (envelope) =>
            envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolResult,
        ),
      ).toBe(false);

      await vi.advanceTimersByTimeAsync(50);
      expect(
        runtimeOutputEvents.filter(
          (event) =>
            event.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate &&
            event.payload.progressKind === 'execute_tool_heartbeat',
        ),
      ).toHaveLength(2);

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool_part_progress',
            sessionID: 'ses_1',
            messageID: 'msg_progress',
            type: 'tool',
            callID: 'call_progress',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'pnpm test' },
              output: 'Tests done\n',
              title: 'Run tests',
              metadata: { exitCode: 0 },
            },
          },
        },
      });

      const heartbeatCountAfterCompletion = runtimeOutputEvents.filter(
        (event) =>
          event.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate &&
          event.payload.progressKind === 'execute_tool_heartbeat',
      ).length;

      await vi.advanceTimersByTimeAsync(150);

      expect(
        runtimeOutputEvents.filter(
          (event) =>
            event.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate &&
            event.payload.progressKind === 'execute_tool_heartbeat',
        ),
      ).toHaveLength(heartbeatCountAfterCompletion);
      expect(
        runtimeOutputEvents.some(
          (event) =>
            event.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate &&
            event.payload.status === 'completed' &&
            event.payload.output === 'Tests done\n',
        ),
      ).toBe(true);
    } finally {
      harness.dispose();
      vi.useRealTimers();
    }
  });

  it('emits OpenCode todowrite parts as plan updates', async () => {
    const { client, harness } = createHarness();
    const runtimeOutputEvents: AcpMessage[] = [];
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];

    harness.subscribeRuntimeOutput((event) => runtimeOutputEvents.push(event));
    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );

    const todos = [
      {
        id: 't1',
        status: 'in_progress',
        content: 'Discover repo guidance files for the Roomote repo',
        priority: 'medium',
      },
      {
        id: 't2',
        status: 'pending',
        content: 'Read a few representative project files',
        priority: 'medium',
      },
    ];

    try {
      await connectHarness(harness, client);

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool_part_todos',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'tool',
            callID: 'call_todos_1',
            tool: 'todowrite',
            state: {
              status: 'running',
              title: 'todowrite',
            },
          },
        },
      });
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool_part_todos',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'tool',
            callID: 'call_todos_1',
            tool: 'todowrite',
            state: {
              status: 'running',
              input: { todos },
              title: 'todowrite',
            },
          },
        },
      });
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool_part_todos',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'tool',
            callID: 'call_todos_1',
            tool: 'todowrite',
            state: {
              status: 'completed',
              input: { todos },
              output: todos,
              title: 'todowrite',
            },
          },
        },
      });

      const planEnvelopes = persistedEnvelopes.filter(
        (envelope) => envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.Plan,
      );

      expect(planEnvelopes).toHaveLength(1);
      expect(planEnvelopes[0]).toMatchObject({
        role: 'assistant',
        metadata: {
          source: 'plan',
          sessionId: 'ses_1',
          turnId: 'msg_1',
        },
        payload: {
          entries: todos,
        },
      });
      expect(planEnvelopes[0]?.contentBlocks).toEqual([
        {
          type: 'text',
          text: '- [in_progress] Discover repo guidance files for the Roomote repo\n- [pending] Read a few representative project files',
        },
      ]);
      expect(
        persistedEnvelopes.some(
          (envelope) =>
            envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolCall ||
            envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolResult,
        ),
      ).toBe(false);
      expect(
        runtimeOutputEvents.some(
          (event) =>
            event.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate,
        ),
      ).toBe(false);
      expect(
        runtimeOutputEvents.some(
          (event) => event.eventType === ACP_ENVELOPE_EVENT_TYPES.Plan,
        ),
      ).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it('normalizes OpenCode read, search, and MCP tool categories', async () => {
    const { client, harness } = createHarness(undefined, {
      mcpServerNames: ['roomote'],
    });
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];

    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );

    const cases = [
      {
        callId: 'call_read',
        partId: 'tool_part_read',
        tool: 'read',
        title: 'src/app.ts',
        input: { filePath: 'src/app.ts' },
        output: '<file>export const value = 1;</file>',
        expected: {
          kind: 'read',
          title: 'src/app.ts',
          isRead: true,
          isExecute: false,
          isMcp: false,
        },
      },
      {
        callId: 'call_search',
        partId: 'tool_part_search',
        tool: 'grep',
        title: 'grep',
        input: { pattern: 'AcpToolMessage', path: 'apps/web/src' },
        output: 'apps/web/src/example.ts:1:AcpToolMessage',
        expected: {
          kind: 'search',
          title: 'grep',
          isRead: false,
          isExecute: false,
          isMcp: false,
        },
      },
      {
        callId: 'call_mcp',
        partId: 'tool_part_mcp',
        tool: 'mcp:roomote/get_task',
        title: 'roomote/get_task',
        input: { taskId: 'task_1' },
        output: { ok: true },
        expected: {
          kind: 'mcp',
          title: 'roomote/get_task',
          isRead: false,
          isExecute: false,
          isMcp: true,
          mcpServerName: 'roomote',
          mcpToolName: 'get_task',
          serverName: 'roomote',
          toolName: 'get_task',
        },
      },
      {
        callId: 'call_flattened_mcp',
        partId: 'tool_part_flattened_mcp',
        tool: 'roomote_send_chat_reply',
        title: 'roomote_send_chat_reply',
        input: { message: 'hello from Slack' },
        output: { ok: true },
        expected: {
          kind: 'mcp',
          title: 'roomote_send_chat_reply',
          isRead: false,
          isExecute: false,
          isMcp: true,
          mcpServerName: 'roomote',
          mcpToolName: 'send_chat_reply',
          serverName: 'roomote',
          toolName: 'send_chat_reply',
        },
      },
    ];

    try {
      await connectHarness(harness, client);

      for (const testCase of cases) {
        await client.emit({
          type: 'message.part.updated',
          properties: {
            part: {
              id: testCase.partId,
              sessionID: 'ses_1',
              messageID: 'msg_1',
              type: 'tool',
              callID: testCase.callId,
              tool: testCase.tool,
              state: {
                status: 'completed',
                input: testCase.input,
                output: testCase.output,
                title: testCase.title,
              },
            },
          },
        });
      }

      const toolResults = persistedEnvelopes.filter(
        (envelope) =>
          envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolResult,
      );

      expect(toolResults).toHaveLength(cases.length);

      for (const testCase of cases) {
        const result = toolResults.find(
          (envelope) => envelope.payload.toolCallId === testCase.callId,
        );

        expect(result?.payload).toMatchObject({
          sessionId: 'ses_1',
          turnId: 'msg_1',
          toolCallId: testCase.callId,
          rawInput: testCase.input,
          status: 'completed',
          ...testCase.expected,
        });
      }
    } finally {
      harness.dispose();
    }
  });

  it('persists OpenCode subtask parts as subagent tool calls', async () => {
    const { client, harness } = createHarness();
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];

    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );

    try {
      await connectHarness(harness, client);

      const subtaskPart = {
        id: 'subtask_part_1',
        sessionID: 'ses_1',
        messageID: 'msg_1',
        type: 'subtask',
        prompt: 'Inspect the failing tests.',
        description: 'Test investigation',
        agent: 'explorer',
        model: {
          providerID: 'openrouter',
          modelID: 'gpt-test',
        },
      };

      await client.emit({
        type: 'message.part.updated',
        properties: { part: subtaskPart },
      });
      await client.emit({
        type: 'message.part.updated',
        properties: { part: subtaskPart },
      });

      const toolCalls = persistedEnvelopes.filter(
        (envelope) => envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolCall,
      );
      const toolResults = persistedEnvelopes.filter(
        (envelope) =>
          envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolResult,
      );

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]?.payload).toMatchObject({
        sessionId: 'ses_1',
        turnId: 'msg_1',
        toolCallId: 'subtask_part_1',
        kind: 'subagent',
        title: 'Test investigation',
        status: 'in_progress',
        isSubagentSpawn: true,
        agentType: 'explorer',
        model: 'openrouter/gpt-test',
        prompt: 'Inspect the failing tests.',
      });
      expect(toolResults).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  it('retries a blocked queued prompt instead of waiting for the next message', async () => {
    const beforeQueuedPrompt = vi.fn<
      () => Promise<void | {
        shouldReconnect: boolean;
        shouldBlockPrompt?: boolean;
        reason?: string;
      }>
    >();
    beforeQueuedPrompt
      .mockResolvedValueOnce({
        shouldReconnect: false,
        shouldBlockPrompt: true,
      })
      .mockResolvedValue(undefined);
    const { client, harness } = createHarness(undefined, {
      beforeQueuedPrompt,
      queuedPromptRetryDelayMs: 20,
    });

    try {
      await connectHarness(harness, client);

      harness.sendCommand({
        commandName: TaskCommandName.StartNewTask,
        data: { text: 'First.', visibleInTranscript: true },
      });
      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      // Queue a follow-up while the first turn is in flight.
      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: { text: 'Second.', visibleInTranscript: true },
      });

      // Complete the first turn so the queue drains exactly once.
      client.message.mockResolvedValueOnce(createFinalAssistantMessage());
      await client.emit({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_1',
            sessionID: 'ses_1',
            role: 'assistant',
            time: { completed: 1 },
          },
        },
      });
      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      });

      // The first drain is blocked; the prompt is held, not delivered.
      await vi.waitFor(() => {
        expect(beforeQueuedPrompt).toHaveBeenCalledTimes(1);
      });
      expect(client.promptAsync).toHaveBeenCalledTimes(1);

      // The scheduled retry drains the queue with no new user message.
      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });
      expect(beforeQueuedPrompt).toHaveBeenCalledTimes(2);
      expect(client.promptAsync.mock.calls[1]?.[0]).toMatchObject({
        sessionId: 'ses_1',
        request: {
          parts: [{ type: 'text', text: expect.stringContaining('Second.') }],
        },
      });
    } finally {
      harness.dispose();
    }
  });

  it('drops a skipped queued prompt and keeps draining the rest of the queue', async () => {
    // Actor-mismatch skip: the prompt's sender is not the run's acting user,
    // so its content must never be delivered — not retried (that would stall
    // the queue) and not restored. Later queued prompts still drain.
    const beforeQueuedPrompt = vi.fn<
      () => Promise<void | {
        shouldReconnect: boolean;
        shouldBlockPrompt?: boolean;
        shouldSkipPrompt?: boolean;
        reason?: string;
      }>
    >();
    beforeQueuedPrompt
      .mockResolvedValueOnce({
        shouldReconnect: false,
        shouldSkipPrompt: true,
        reason: 'sender is not the server-side acting user',
      })
      .mockResolvedValue(undefined);
    const { client, harness } = createHarness(undefined, {
      beforeQueuedPrompt,
      queuedPromptRetryDelayMs: 20,
    });

    try {
      await connectHarness(harness, client);

      harness.sendCommand({
        commandName: TaskCommandName.StartNewTask,
        data: { text: 'First.', visibleInTranscript: true },
      });
      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      // Queue two follow-ups while the first turn is in flight: the first
      // will be skipped (mismatched sender), the second must still deliver.
      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: { text: 'Mismatched second.', visibleInTranscript: true },
      });
      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: { text: 'Matching third.', visibleInTranscript: true },
      });

      // Complete the first turn so the queue drains.
      client.message.mockResolvedValueOnce(createFinalAssistantMessage());
      await client.emit({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_1',
            sessionID: 'ses_1',
            role: 'assistant',
            time: { completed: 1 },
          },
        },
      });
      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      });

      // The skipped prompt is dropped; the scheduled retry drains the next
      // queued prompt without a new user message.
      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });
      expect(beforeQueuedPrompt).toHaveBeenCalledTimes(2);
      expect(client.promptAsync.mock.calls[1]?.[0]).toMatchObject({
        sessionId: 'ses_1',
        request: {
          parts: [
            { type: 'text', text: expect.stringContaining('Matching third.') },
          ],
        },
      });

      // The mismatched content never reached the model under any identity.
      for (const call of client.promptAsync.mock.calls) {
        const parts = (
          call[0] as {
            request: { parts: Array<{ type: string; text?: string }> };
          }
        ).request.parts;

        for (const part of parts) {
          expect(part.text ?? '').not.toContain('Mismatched second.');
        }
      }
    } finally {
      harness.dispose();
    }
  });

  it('validates and reuses a prior session on resume before its first prompt', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);

      harness.sendCommand({
        commandName: TaskCommandName.ResumeTask,
        data: 'ses_prior',
      });
      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: { text: 'Continue.', visibleInTranscript: true },
      });
      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      // The prior session is validated server-side, then reused — no new
      // session is created behind the user's back.
      expect(client.messages).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'ses_prior', limit: 1 }),
      );
      expect(client.createSession).not.toHaveBeenCalled();
      expect(client.promptAsync.mock.calls[0]?.[0]).toMatchObject({
        sessionId: 'ses_prior',
      });
    } finally {
      harness.dispose();
    }
  });

  it('drops an invalid prior session on resume so a fresh one is created', async () => {
    const { client, harness } = createHarness();
    client.messages.mockRejectedValueOnce(new Error('session not found'));

    try {
      await connectHarness(harness, client);

      harness.sendCommand({
        commandName: TaskCommandName.ResumeTask,
        data: 'ses_stale',
      });
      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: { text: 'Continue.', visibleInTranscript: true },
      });
      await vi.waitFor(() => {
        expect(client.createSession).toHaveBeenCalledTimes(1);
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      // The stale id was validated, found gone, and dropped — the next prompt
      // creates a fresh session rather than reusing an id the server no longer
      // knows.
      expect(client.messages).toHaveBeenCalledTimes(1);
      expect(client.promptAsync.mock.calls[0]?.[0]).toMatchObject({
        sessionId: 'ses_1',
      });
    } finally {
      harness.dispose();
    }
  });

  it('fails the initial task and records a diagnostic when session create fails', async () => {
    const client = new FakeOpenCodeServerClient();
    client.createSession.mockRejectedValueOnce(
      new Error(
        'OpenCode session creation did not respond within 90s. The OpenCode server is up, but the first session request never finished.',
      ),
    );
    const onDiagnostic = vi.fn();
    const harness = new OpenCodeServerHarness({
      client: client as unknown as OpenCodeServerClient,
      workspacePath: '/sandbox/repos',
      logger: createLogger(),
      model: TEST_OPENCODE_MODEL,
      eventStreamReadyTimeoutMs: 100,
      mcpServerNames: ['roomote'],
      commandEnv: { HOME: '/sandbox/repos/.roomote-runtime-home' },
      onDiagnostic,
    });
    const taskEvents: TaskEvent[] = [];
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];
    const commandErrors: unknown[] = [];

    harness.subscribe((event) => taskEvents.push(event));
    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );
    harness.subscribeCommandError?.((error) => commandErrors.push(error));

    try {
      await connectHarness(harness, client);

      harness.sendCommand({
        commandName: TaskCommandName.StartNewTask,
        data: { text: 'Start work.', visibleInTranscript: true },
      });

      await vi.waitFor(() => {
        expect(commandErrors.length).toBeGreaterThan(0);
      });

      expect(
        taskEvents.some(
          (event) =>
            event.eventName === TaskEventName.TaskStarted &&
            event.payload?.[0] === 'opencode-session-create-failed',
        ),
      ).toBe(true);
      expect(
        taskEvents.some(
          (event) => event.eventName === TaskEventName.TaskAborted,
        ),
      ).toBe(false);
      expect(
        taskEvents.some(
          (event) =>
            event.eventName === TaskEventName.Message &&
            (event.payload?.[0] as { message?: { say?: string } })?.message
              ?.say === 'error',
        ),
      ).toBe(true);
      expect(client.promptAsync).not.toHaveBeenCalled();
      expect(onDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'opencode_session_create_failed',
          details: expect.objectContaining({
            workspacePath: '/sandbox/repos',
            homeDir: '/sandbox/repos/.roomote-runtime-home',
            mcpServerNames: ['roomote'],
          }),
        }),
      );
      expect(
        persistedEnvelopes.some(
          (envelope) =>
            envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage &&
            String(envelope.payload.text ?? '').includes(
              'session creation did not respond',
            ),
        ),
      ).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it('aborts a late-created session when cancel races ahead of ensureSession', async () => {
    let resolveCreate:
      | ((value: { id: string; title: string }) => void)
      | undefined;
    const client = new FakeOpenCodeServerClient();
    client.createSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const harness = new OpenCodeServerHarness({
      client: client as unknown as OpenCodeServerClient,
      workspacePath: '/sandbox/repos',
      logger: createLogger(),
      model: TEST_OPENCODE_MODEL,
      eventStreamReadyTimeoutMs: 100,
    });
    const taskEvents: TaskEvent[] = [];
    harness.subscribe((event) => taskEvents.push(event));

    try {
      await connectHarness(harness, client);

      harness.sendCommand({
        commandName: TaskCommandName.StartNewTask,
        data: { text: 'Start work.', visibleInTranscript: true },
      });

      await vi.waitFor(() => {
        expect(client.createSession).toHaveBeenCalledTimes(1);
      });

      // Cancel while createSession is still pending — no session id yet.
      harness.sendCommand({
        commandName: TaskCommandName.CancelTask,
        data: { cancelledBy: { name: 'Matt', source: 'web' } },
      });

      resolveCreate?.({ id: 'ses_late', title: 'late' });

      await vi.waitFor(() => {
        expect(client.abort).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 'ses_late' }),
        );
      });

      expect(client.promptAsync).not.toHaveBeenCalled();
      expect(
        taskEvents.some(
          (event) =>
            event.eventName === TaskEventName.TaskStarted &&
            event.payload?.[0] === 'ses_late',
        ),
      ).toBe(true);
      expect(
        taskEvents.some(
          (event) =>
            event.eventName === TaskEventName.TaskAborted &&
            event.payload?.[0] === 'ses_late',
        ),
      ).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it('creates a fresh session for a follow-up after cancel aborts initial session creation', async () => {
    const client = new FakeOpenCodeServerClient();
    client.createSession
      .mockImplementationOnce(
        (options?: { title?: string; signal?: AbortSignal }) =>
          new Promise<{ id: string; title: string }>((_, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce({ id: 'ses_followup', title: 'follow-up' });
    const harness = new OpenCodeServerHarness({
      client: client as unknown as OpenCodeServerClient,
      workspacePath: '/sandbox/repos',
      logger: createLogger(),
      model: TEST_OPENCODE_MODEL,
      eventStreamReadyTimeoutMs: 100,
    });

    try {
      await connectHarness(harness, client);

      harness.sendCommand({
        commandName: TaskCommandName.StartNewTask,
        data: { text: 'Start work.', visibleInTranscript: true },
      });
      await vi.waitFor(() => {
        expect(client.createSession).toHaveBeenCalledTimes(1);
      });

      harness.sendCommand({ commandName: TaskCommandName.CancelTask });
      await vi.waitFor(() => {
        expect(client.promptAsync).not.toHaveBeenCalled();
      });

      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: { text: 'Resume work.', visibleInTranscript: true },
      });

      await vi.waitFor(() => {
        expect(client.createSession).toHaveBeenCalledTimes(2);
        expect(client.promptAsync).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 'ses_followup' }),
        );
      });
    } finally {
      harness.dispose();
    }
  });
});

describe('OpenCodeServerHarness cancel marker', () => {
  function createPartialAssistantMessage(text: string): OpenCodeSessionMessage {
    return {
      info: {
        id: 'msg_1',
        sessionID: 'ses_1',
        role: 'assistant',
        providerID: 'openrouter',
        modelID: 'openai/gpt-5.4',
        mode: 'build',
        time: {
          created: 0,
        },
        cost: 0,
        tokens: {
          input: 5,
          output: 2,
          reasoning: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
      },
      parts: [
        {
          id: 'part_1',
          sessionID: 'ses_1',
          messageID: 'msg_1',
          type: 'text',
          text,
        },
      ],
    };
  }

  async function startTurnWithPartialText(
    harness: OpenCodeServerHarness,
    client: FakeOpenCodeServerClient,
  ): Promise<void> {
    await connectHarness(harness, client);

    harness.sendCommand({
      commandName: TaskCommandName.StartNewTask,
      data: { text: 'Start work.', visibleInTranscript: true },
    });
    await vi.waitFor(() => {
      expect(client.promptAsync).toHaveBeenCalledTimes(1);
    });

    await client.emit({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part_1',
          sessionID: 'ses_1',
          messageID: 'msg_1',
          type: 'text',
          text: 'Partial answer',
        },
        delta: 'Partial answer',
      },
    });
  }

  it('emits a task_cancelled marker after the flushed partial output on an attributed cancel', async () => {
    const { client, harness } = createHarness();
    const runtimeOutputEvents: AcpMessage[] = [];
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];
    const taskEvents: TaskEvent[] = [];

    harness.subscribeRuntimeOutput((event) => runtimeOutputEvents.push(event));
    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );
    harness.subscribe((event) => taskEvents.push(event));

    try {
      await startTurnWithPartialText(harness, client);

      client.messages.mockResolvedValueOnce([
        createPartialAssistantMessage('Partial answer'),
      ]);

      harness.sendCommand({
        commandName: TaskCommandName.CancelTask,
        data: { cancelledBy: { name: 'Daniel', source: 'web' } },
      });

      await vi.waitFor(() => {
        expect(
          taskEvents.some(
            (event) => event.eventName === TaskEventName.TaskAborted,
          ),
        ).toBe(true);
      });

      const assistantIndex = persistedEnvelopes.findIndex(
        (envelope) =>
          envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage &&
          envelope.payload.text === 'Partial answer',
      );
      const markerIndex = persistedEnvelopes.findIndex(
        (envelope) =>
          envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.TaskCancelled,
      );

      // The partial output the user saw is flushed first, then the marker —
      // the marker is the last transcript entry of the cancelled turn.
      expect(assistantIndex).toBeGreaterThanOrEqual(0);
      expect(markerIndex).toBeGreaterThan(assistantIndex);
      expect(persistedEnvelopes[markerIndex]).toMatchObject({
        role: 'system',
        payload: {
          sessionId: 'ses_1',
          cancelledByName: 'Daniel',
          source: 'web',
        },
      });
      expect(
        runtimeOutputEvents.some(
          (event) => event.eventType === ACP_ENVELOPE_EVENT_TYPES.TaskCancelled,
        ),
      ).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it('drops trailing assistant output after a cancel until the next prompt', async () => {
    const { client, harness } = createHarness();
    const runtimeOutputEvents: AcpMessage[] = [];
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];
    const taskEvents: TaskEvent[] = [];

    harness.subscribeRuntimeOutput((event) => runtimeOutputEvents.push(event));
    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );
    harness.subscribe((event) => taskEvents.push(event));

    try {
      await startTurnWithPartialText(harness, client);

      client.messages.mockResolvedValueOnce([
        createPartialAssistantMessage('Partial answer'),
      ]);

      harness.sendCommand({
        commandName: TaskCommandName.CancelTask,
        data: { cancelledBy: { name: 'Daniel', source: 'web' } },
      });

      await vi.waitFor(() => {
        expect(
          taskEvents.some(
            (event) => event.eventName === TaskEventName.TaskAborted,
          ),
        ).toBe(true);
      });

      const chunkCountAtCancel = runtimeOutputEvents.filter(
        (event) =>
          event.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk,
      ).length;
      const messageFetchCountAtCancel = client.message.mock.calls.length;

      // Trailing stream content and the post-abort finalize must not land
      // after the marker.
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'text',
            text: 'Partial answer plus a trailing paragraph',
          },
          delta: ' plus a trailing paragraph',
        },
      });
      await client.emit({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_1',
            sessionID: 'ses_1',
            role: 'assistant',
            time: { completed: 1 },
          },
        },
      });

      expect(
        runtimeOutputEvents.filter(
          (event) =>
            event.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk,
        ),
      ).toHaveLength(chunkCountAtCancel);
      expect(client.message.mock.calls).toHaveLength(messageFetchCountAtCancel);
      expect(
        persistedEnvelopes.filter(
          (envelope) =>
            envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        ),
      ).toHaveLength(1);

      // The next prompt lifts the suppression: a fresh turn streams normally.
      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: { text: 'Continue.', visibleInTranscript: true },
      });
      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_2',
            sessionID: 'ses_1',
            messageID: 'msg_2',
            type: 'text',
            text: 'Fresh turn',
          },
          delta: 'Fresh turn',
        },
      });

      expect(
        runtimeOutputEvents.filter(
          (event) =>
            event.eventType === ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk,
        ).length,
      ).toBeGreaterThan(chunkCountAtCancel);
    } finally {
      harness.dispose();
    }
  });

  it('does not emit a marker for a cancel without attribution', async () => {
    const { client, harness } = createHarness();
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];
    const taskEvents: TaskEvent[] = [];

    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );
    harness.subscribe((event) => taskEvents.push(event));

    try {
      await startTurnWithPartialText(harness, client);

      client.messages.mockResolvedValueOnce([
        createPartialAssistantMessage('Partial answer'),
      ]);

      harness.sendCommand({ commandName: TaskCommandName.CancelTask });

      await vi.waitFor(() => {
        expect(
          taskEvents.some(
            (event) => event.eventName === TaskEventName.TaskAborted,
          ),
        ).toBe(true);
      });

      expect(
        persistedEnvelopes.some(
          (envelope) =>
            envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.TaskCancelled,
        ),
      ).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it('cancels pending questions with explicit responses on an attributed cancel', async () => {
    const { client, harness } = createHarness();
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];
    const taskEvents: TaskEvent[] = [];

    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );
    harness.subscribe((event) => taskEvents.push(event));

    try {
      await connectHarness(harness, client);

      harness.sendCommand({
        commandName: TaskCommandName.StartNewTask,
        data: { text: 'Start work.', visibleInTranscript: true },
      });
      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_q',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'tool',
            callID: 'call_q',
            tool: 'question',
            state: {
              status: 'running',
              input: {
                questions: [
                  {
                    id: 'q1',
                    header: 'Approach',
                    question: 'Which approach?',
                    options: [{ label: 'A', description: 'Approach A.' }],
                  },
                ],
              },
              title: 'Ask user',
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(harness.getPendingUserInputRequests()).toHaveLength(1);
      });

      client.messages.mockResolvedValueOnce([]);

      harness.sendCommand({
        commandName: TaskCommandName.CancelTask,
        data: { cancelledBy: { name: 'Daniel', source: 'web' } },
      });

      await vi.waitFor(() => {
        expect(
          taskEvents.some(
            (event) => event.eventName === TaskEventName.TaskAborted,
          ),
        ).toBe(true);
      });

      const cancelledResponse = persistedEnvelopes.find(
        (envelope) =>
          envelope.eventType ===
          ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse,
      );
      const marker = persistedEnvelopes.find(
        (envelope) =>
          envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.TaskCancelled,
      );

      expect(cancelledResponse?.payload).toMatchObject({
        resolution: 'cancelled',
      });
      expect(marker).toBeDefined();
      expect(harness.getPendingUserInputRequests()).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });
});
