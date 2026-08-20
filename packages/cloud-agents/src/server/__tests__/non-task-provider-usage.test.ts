import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';

import { z } from 'zod';

const {
  createOpencodeClientMock,
  configProvidersMock,
  createServerMock,
  eventSubscribeMock,
  execFileMock,
  execFileSyncMock,
  mockResolveEffectiveModelRuntimeEnv,
  sessionAbortMock,
  spawnMock,
  sessionCreateMock,
  sessionPromptMock,
} = vi.hoisted(() => ({
  createOpencodeClientMock: vi.fn(),
  configProvidersMock: vi.fn(),
  createServerMock: vi.fn(),
  eventSubscribeMock: vi.fn(),
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  mockResolveEffectiveModelRuntimeEnv: vi.fn(),
  sessionAbortMock: vi.fn(),
  spawnMock: vi.fn(),
  sessionCreateMock: vi.fn(),
  sessionPromptMock: vi.fn(),
}));

vi.mock('@opencode-ai/sdk/v2/client', () => ({
  createOpencodeClient: createOpencodeClientMock,
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
  spawn: spawnMock,
}));

vi.mock('node:net', () => ({
  createServer: createServerMock,
}));

vi.mock('@roomote/db/server', () => ({
  resolveEffectiveModelRuntimeEnv: mockResolveEffectiveModelRuntimeEnv,
}));

import {
  createOpenCodeSdkFetch,
  resolveOpenCodeSmallModel,
} from '../non-task-provider-usage';

const DEFAULT_OPENCODE_CLI_VERSION = '1.18.10';

type SpawnedServer = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
};

const spawnedServers: SpawnedServer[] = [];

function createReservedPortServer(port: number) {
  const server = new EventEmitter() as EventEmitter & {
    address: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    listen: ReturnType<typeof vi.fn>;
  };
  server.address = vi.fn(() => ({
    address: '127.0.0.1',
    family: 'IPv4',
    port,
  }));
  server.close = vi.fn((callback?: (error?: Error) => void) => {
    callback?.();
    return server;
  });
  server.listen = vi.fn(
    (_port: number, _hostname: string, callback: () => void) => {
      queueMicrotask(callback);
      return server;
    },
  );

  return server;
}

function createSpawnedServer(): SpawnedServer {
  const proc = new EventEmitter() as SpawnedServer;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    proc.signalCode = signal;
    proc.emit('exit', null, signal);
    return true;
  });
  spawnedServers.push(proc);
  queueMicrotask(() => {
    proc.stdout.emit('data', Buffer.from('opencode server booting\n'));
  });
  return proc;
}

function getOpenCodeCliVersionArg(dockerfile: string): string | undefined {
  return /^ARG OPENCODE_CLI_VERSION=(\S+)$/mu.exec(dockerfile)?.[1];
}

describe('resolveOpenCodeSmallModel', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = originalEnv;
    mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({});
    spawnedServers.length = 0;
    let nextServerPort = 4100;
    createServerMock.mockImplementation(() =>
      createReservedPortServer(nextServerPort++),
    );
    spawnMock.mockImplementation(() => createSpawnedServer());
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    createOpencodeClientMock.mockReturnValue({
      config: {
        providers: configProvidersMock,
      },
      event: {
        subscribe: eventSubscribeMock,
      },
      session: {
        abort: sessionAbortMock,
        create: sessionCreateMock,
        prompt: sessionPromptMock,
      },
    });
    sessionAbortMock.mockResolvedValue({ data: true, error: undefined });
    sessionCreateMock.mockResolvedValue({
      data: { id: 'session-1' },
      error: undefined,
    });
    configProvidersMock.mockResolvedValue({
      data: { providers: [], default: {} },
      error: undefined,
    });
  });

  afterEach(() => {
    for (const server of spawnedServers) {
      if (server.exitCode === null && server.signalCode === null) {
        server.exitCode = 0;
        server.emit('exit', 0, null);
      }
    }
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('uses the deployment small model when configured', () => {
    process.env = {
      ...originalEnv,
      R_MODEL: 'openrouter/anthropic/claude-sonnet-4',
      R_SMALL_MODEL: 'openrouter/openai/gpt-4.1-mini',
    };

    expect(resolveOpenCodeSmallModel()).toBe('openrouter/openai/gpt-4.1-mini');
  });

  it('falls back to the deployment task model', () => {
    process.env = {
      ...originalEnv,
      R_MODEL: 'openrouter/anthropic/claude-sonnet-4',
    };
    delete process.env.R_SMALL_MODEL;

    expect(resolveOpenCodeSmallModel()).toBe(
      'openrouter/anthropic/claude-sonnet-4',
    );
  });

  it('reuses a managed OpenCode SDK server for matching structured object calls', async () => {
    process.env = {
      ...originalEnv,
    };
    mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
      R_MODEL: 'openrouter/z-ai/glm-5.2',
      R_SMALL_MODEL: 'openrouter/openai/gpt-5.4',
      OPENROUTER_API_KEY: 'test-key',
    });
    sessionPromptMock.mockResolvedValue({
      data: {
        info: {
          structured: {
            workspaceValue: 'Full Stack',
            reasoning: 'Best fit',
            confidence: 0.92,
            needsExternalLookup: false,
            externalReference: null,
          },
        },
        parts: [],
      },
      error: undefined,
    });

    const { generateTrackedNonTaskObject, NON_TASK_INFERENCE_SURFACES } =
      await import('../non-task-provider-usage.js');
    const schema = z.object({
      workspaceValue: z.string(),
      reasoning: z.string(),
      confidence: z.number(),
      needsExternalLookup: z.boolean(),
      externalReference: z.string().nullable(),
    });

    const result = await generateTrackedNonTaskObject({
      surface: NON_TASK_INFERENCE_SURFACES.routerTaskRouting,
      schema,
      system: 'You route tasks.',
      prompt: 'Choose a workspace.',
    });
    const secondResult = await generateTrackedNonTaskObject({
      surface: NON_TASK_INFERENCE_SURFACES.routerTaskRouting,
      schema,
      system: 'You route tasks.',
      prompt: 'Choose a workspace.',
    });

    expect(result.object.workspaceValue).toBe('Full Stack');
    expect(secondResult.object.workspaceValue).toBe('Full Stack');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'opencode',
      ['serve', '--hostname=127.0.0.1', '--port=4100'],
      expect.any(Object),
    );
    expect(spawnedServers[0]?.kill).not.toHaveBeenCalled();
    expect(createOpencodeClientMock).toHaveBeenCalledTimes(2);
    expect(createOpencodeClientMock).toHaveBeenNthCalledWith(1, {
      baseUrl: 'http://127.0.0.1:4100',
      fetch: expect.any(Function),
    });
    expect(createOpencodeClientMock).toHaveBeenNthCalledWith(2, {
      baseUrl: 'http://127.0.0.1:4100',
      fetch: expect.any(Function),
    });
    expect(sessionPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          providerID: 'openrouter',
          modelID: 'openai/gpt-5.4',
        },
      }),
      expect.any(Object),
    );
  });

  it('runs a held Fast session with native tools and a session-ready binding', async () => {
    process.env = {
      ...originalEnv,
      OPENCODE_SDK_SERVER_URL: 'http://127.0.0.1:4999',
    };
    mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
      R_MODEL: 'openrouter/openai/gpt-5.4',
    });
    sessionPromptMock.mockResolvedValue({
      data: {
        info: {},
        parts: [{ type: 'text', text: 'native tool turn complete' }],
      },
      error: undefined,
    });
    const {
      generateTrackedNonTaskTextInOpenCodeSession,
      NON_TASK_INFERENCE_SURFACES,
    } = await import('../non-task-provider-usage.js');
    const onSessionReady = vi.fn();
    const session: { id?: string } = {};

    await expect(
      generateTrackedNonTaskTextInOpenCodeSession(
        {
          surface: NON_TASK_INFERENCE_SURFACES.fastAgentQuestionAnswering,
          prompt: 'Use the native tools.',
          modelRole: 'primary',
        },
        session,
        {
          directory: '/tmp/roomote-fast-native-test',
          env: {
            ROOMOTE_FAST_TOOL_BRIDGE_URL: 'http://127.0.0.1:4321/tool',
            ROOMOTE_FAST_TOOL_BRIDGE_TOKEN: 'bridge-token',
          },
          tools: {
            '*': false,
            send_chat_reply: true,
          },
          onSessionReady,
        },
      ),
    ).resolves.toBe('native tool turn complete');

    expect(session.id).toBe('session-1');
    expect(onSessionReady).toHaveBeenCalledWith('session-1');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[2]?.env).toMatchObject({
      ROOMOTE_FAST_TOOL_BRIDGE_URL: 'http://127.0.0.1:4321/tool',
      ROOMOTE_FAST_TOOL_BRIDGE_TOKEN: 'bridge-token',
    });
    expect(sessionPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: '/tmp/roomote-fast-native-test',
        sessionID: 'session-1',
        tools: {
          '*': false,
          send_chat_reply: true,
        },
      }),
      expect.any(Object),
    );
  });

  it('keeps an active Fast prompt alive beyond its inactivity timeout', async () => {
    vi.useFakeTimers();
    try {
      mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
        R_MODEL: 'openrouter/openai/gpt-5.4',
      });
      eventSubscribeMock.mockResolvedValue({
        stream: (async function* () {
          for (const text of ['still', 'working', 'now']) {
            await new Promise((resolve) => setTimeout(resolve, 80));
            yield {
              type: 'message.part.updated' as const,
              properties: {
                part: {
                  id: 'part-1',
                  messageID: 'message-1',
                  sessionID: 'session-1',
                  type: 'text' as const,
                  text,
                },
                delta: text,
              },
            };
          }
        })(),
      });
      sessionPromptMock.mockImplementation(
        (_input, options: { signal: AbortSignal }) =>
          new Promise((resolve, reject) => {
            const completion = setTimeout(
              () =>
                resolve({
                  data: {
                    info: {},
                    parts: [{ type: 'text', text: 'completed' }],
                  },
                  error: undefined,
                }),
              300,
            );
            options.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(completion);
                reject(options.signal.reason);
              },
              { once: true },
            );
          }),
      );
      const { generateTrackedNonTaskTextInOpenCodeSession } =
        await import('../non-task-provider-usage.js');

      const result = generateTrackedNonTaskTextInOpenCodeSession(
        {
          surface: 'fast_agent_question_answering',
          prompt: 'Keep working.',
          idleTimeoutMs: 100,
        },
        {},
        {
          directory: '/tmp/roomote-fast-native-test',
          tools: { '*': false, send_chat_reply: true },
        },
      );
      await vi.advanceTimersByTimeAsync(300);

      await expect(result).resolves.toBe('completed');
      expect(sessionAbortMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a Fast prompt after its inactivity timeout', async () => {
    vi.useFakeTimers();
    try {
      mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
        R_MODEL: 'openrouter/openai/gpt-5.4',
      });
      eventSubscribeMock.mockResolvedValue({ stream: [] });
      sessionPromptMock.mockImplementation(
        (_input, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              'abort',
              () => reject(options.signal.reason),
              { once: true },
            );
          }),
      );
      const {
        generateTrackedNonTaskTextInOpenCodeSession,
        NonTaskOpenCodePromptTimeoutError,
      } = await import('../non-task-provider-usage.js');

      const result = generateTrackedNonTaskTextInOpenCodeSession(
        {
          surface: 'fast_agent_question_answering',
          prompt: 'Keep working.',
          idleTimeoutMs: 100,
        },
        {},
        {
          directory: '/tmp/roomote-fast-native-test',
          tools: { '*': false, send_chat_reply: true },
        },
      );
      const rejection = expect(result).rejects.toBeInstanceOf(
        NonTaskOpenCodePromptTimeoutError,
      );
      await vi.advanceTimersByTimeAsync(100);

      await rejection;
      expect(sessionAbortMock).toHaveBeenCalledWith({
        sessionID: 'session-1',
        directory: '/tmp/roomote-fast-native-test',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count activity from another OpenCode session', async () => {
    vi.useFakeTimers();
    try {
      mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
        R_MODEL: 'openrouter/openai/gpt-5.4',
      });
      eventSubscribeMock.mockResolvedValue({
        stream: (async function* () {
          await new Promise((resolve) => setTimeout(resolve, 80));
          yield {
            type: 'message.part.updated' as const,
            properties: {
              part: {
                id: 'part-1',
                messageID: 'message-1',
                sessionID: 'another-session',
                type: 'text' as const,
                text: 'unrelated activity',
              },
              delta: 'unrelated activity',
            },
          };
        })(),
      });
      sessionPromptMock.mockImplementation(
        (_input, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              'abort',
              () => reject(options.signal.reason),
              { once: true },
            );
          }),
      );
      const {
        generateTrackedNonTaskTextInOpenCodeSession,
        NonTaskOpenCodePromptTimeoutError,
      } = await import('../non-task-provider-usage.js');

      const result = generateTrackedNonTaskTextInOpenCodeSession(
        {
          surface: 'fast_agent_question_answering',
          prompt: 'Keep working.',
          idleTimeoutMs: 100,
        },
        {},
        {
          directory: '/tmp/roomote-fast-native-test',
          tools: { '*': false, send_chat_reply: true },
        },
      );
      const rejection = expect(result).rejects.toBeInstanceOf(
        NonTaskOpenCodePromptTimeoutError,
      );
      await vi.advanceTimersByTimeAsync(100);

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps Fast alive through a scheduled provider retry backoff', async () => {
    vi.useFakeTimers();
    try {
      mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
        R_MODEL: 'openrouter/openai/gpt-5.4',
      });
      eventSubscribeMock.mockResolvedValue({
        stream: (async function* () {
          yield {
            type: 'session.status' as const,
            properties: {
              sessionID: 'session-1',
              status: {
                type: 'retry' as const,
                attempt: 1,
                message: 'Provider retry scheduled',
                next: Date.now() + 300,
              },
            },
          };
        })(),
      });
      sessionPromptMock.mockImplementation(
        (_input, options: { signal: AbortSignal }) =>
          new Promise((resolve, reject) => {
            const completion = setTimeout(
              () =>
                resolve({
                  data: {
                    info: {},
                    parts: [{ type: 'text', text: 'recovered' }],
                  },
                  error: undefined,
                }),
              350,
            );
            options.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(completion);
                reject(options.signal.reason);
              },
              { once: true },
            );
          }),
      );
      const { generateTrackedNonTaskTextInOpenCodeSession } =
        await import('../non-task-provider-usage.js');

      const result = generateTrackedNonTaskTextInOpenCodeSession(
        {
          surface: 'fast_agent_question_answering',
          prompt: 'Keep working.',
          idleTimeoutMs: 100,
        },
        {},
        {
          directory: '/tmp/roomote-fast-native-test',
          tools: { '*': false, send_chat_reply: true },
        },
      );
      await vi.advanceTimersByTimeAsync(350);

      await expect(result).resolves.toBe('recovered');
      expect(sessionAbortMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps observing Fast activity while retry reporting is still pending', async () => {
    vi.useFakeTimers();
    try {
      mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
        R_MODEL: 'openrouter/openai/gpt-5.4',
      });
      eventSubscribeMock.mockResolvedValue({
        stream: (async function* () {
          yield {
            type: 'session.status' as const,
            properties: {
              sessionID: 'session-1',
              status: {
                type: 'retry' as const,
                attempt: 1,
                message: 'Provider retry scheduled',
                next: Date.now() + 20,
              },
            },
          };
          await new Promise((resolve) => setTimeout(resolve, 80));
          yield {
            type: 'message.part.updated' as const,
            properties: {
              part: {
                id: 'part-1',
                messageID: 'message-1',
                sessionID: 'session-1',
                type: 'text' as const,
                text: 'working again',
              },
              delta: 'working again',
            },
          };
        })(),
      });
      sessionPromptMock.mockImplementation(
        (_input, options: { signal: AbortSignal }) =>
          new Promise((resolve, reject) => {
            const completion = setTimeout(
              () =>
                resolve({
                  data: {
                    info: {},
                    parts: [{ type: 'text', text: 'completed' }],
                  },
                  error: undefined,
                }),
              160,
            );
            options.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(completion);
                reject(options.signal.reason);
              },
              { once: true },
            );
          }),
      );
      const { generateTrackedNonTaskTextInOpenCodeSession } =
        await import('../non-task-provider-usage.js');

      const result = generateTrackedNonTaskTextInOpenCodeSession(
        {
          surface: 'fast_agent_question_answering',
          prompt: 'Keep working.',
          idleTimeoutMs: 100,
          onProviderRetry: () => new Promise(() => undefined),
        },
        {},
        {
          directory: '/tmp/roomote-fast-native-test',
          tools: { '*': false, send_chat_reply: true },
        },
      );
      await vi.advanceTimersByTimeAsync(160);

      await expect(result).resolves.toBe('completed');
      expect(sessionAbortMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes files into a held Fast OpenCode session prompt', async () => {
    mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
      R_MODEL: 'openrouter/openai/gpt-5.4',
    });
    sessionPromptMock.mockResolvedValue({
      data: {
        info: {},
        parts: [{ type: 'text', text: 'image inspected' }],
      },
      error: undefined,
    });
    const { generateTrackedNonTaskTextInOpenCodeSession } =
      await import('../non-task-provider-usage.js');

    await generateTrackedNonTaskTextInOpenCodeSession(
      {
        surface: 'fast_agent_question_answering',
        prompt: 'Inspect this image.',
        files: [
          {
            mime: 'image/png',
            filename: 'screenshot.png',
            url: 'data:image/png;base64,aGVsbG8=',
          },
        ],
      },
      {},
      {
        directory: '/tmp/roomote-fast-native-test',
        tools: { '*': false, send_chat_reply: true },
      },
    );

    expect(sessionPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: [
          expect.objectContaining({ type: 'text' }),
          {
            type: 'file',
            mime: 'image/png',
            filename: 'screenshot.png',
            url: 'data:image/png;base64,aGVsbG8=',
          },
        ],
      }),
      expect.any(Object),
    );
  });

  it('classifies a missing held OpenCode session for cold bootstrap recovery', async () => {
    mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
      R_MODEL: 'openrouter/openai/gpt-5.4',
    });
    sessionPromptMock.mockResolvedValue({
      data: undefined,
      error: { name: 'NotFoundError', data: { message: 'Session not found' } },
    });
    const {
      generateTrackedNonTaskTextInOpenCodeSession,
      NonTaskOpenCodeSessionNotFoundError,
      NON_TASK_INFERENCE_SURFACES,
    } = await import('../non-task-provider-usage.js');

    await expect(
      generateTrackedNonTaskTextInOpenCodeSession(
        {
          surface: NON_TASK_INFERENCE_SURFACES.fastAgentQuestionAnswering,
          prompt: 'turn delta',
        },
        { id: 'missing-session' },
        {
          directory: '/tmp/roomote-fast-native-test',
          tools: { '*': false, send_chat_reply: true },
        },
      ),
    ).rejects.toBeInstanceOf(NonTaskOpenCodeSessionNotFoundError);
    expect(sessionCreateMock).not.toHaveBeenCalled();
  });

  it('uses the deployment primary model when requested', async () => {
    process.env = {
      ...originalEnv,
    };
    mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
      R_MODEL: 'openrouter/z-ai/glm-5.2',
      R_SMALL_MODEL: 'openrouter/openai/gpt-5.4',
      OPENROUTER_API_KEY: 'test-key',
    });
    sessionPromptMock.mockResolvedValue({
      data: {
        info: {
          structured: { answer: 'ok' },
        },
        parts: [],
      },
      error: undefined,
    });

    const { generateTrackedNonTaskObject, NON_TASK_INFERENCE_SURFACES } =
      await import('../non-task-provider-usage.js');

    await generateTrackedNonTaskObject({
      surface: NON_TASK_INFERENCE_SURFACES.fastAgentQuestionAnswering,
      modelRole: 'primary',
      schema: z.object({ answer: z.string() }),
      prompt: 'Answer.',
    });

    expect(sessionPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          providerID: 'openrouter',
          modelID: 'z-ai/glm-5.2',
        },
      }),
      expect.any(Object),
    );
  });

  it('starts a separate managed OpenCode SDK server when model env changes', async () => {
    process.env = {
      ...originalEnv,
    };
    mockResolveEffectiveModelRuntimeEnv
      .mockResolvedValueOnce({
        R_MODEL: 'openrouter/z-ai/glm-5.2',
        R_SMALL_MODEL: 'openrouter/openai/gpt-5.4',
        OPENROUTER_API_KEY: 'test-key',
      })
      .mockResolvedValueOnce({
        R_MODEL: 'openrouter/z-ai/glm-5.2',
        R_SMALL_MODEL: 'openrouter/z-ai/glm-5.2',
        OPENROUTER_API_KEY: 'test-key',
      });
    sessionPromptMock.mockResolvedValue({
      data: {
        info: {
          structured: {
            answer: 'ok',
          },
        },
        parts: [],
      },
      error: undefined,
    });

    const { generateTrackedNonTaskObject, NON_TASK_INFERENCE_SURFACES } =
      await import('../non-task-provider-usage.js');

    await generateTrackedNonTaskObject({
      surface: NON_TASK_INFERENCE_SURFACES.routerTaskRouting,
      schema: z.object({ answer: z.string() }),
      prompt: 'Answer.',
    });
    await generateTrackedNonTaskObject({
      surface: NON_TASK_INFERENCE_SURFACES.routerTaskRouting,
      schema: z.object({ answer: z.string() }),
      prompt: 'Answer.',
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(createOpencodeClientMock).toHaveBeenNthCalledWith(1, {
      baseUrl: 'http://127.0.0.1:4100',
      fetch: expect.any(Function),
    });
    expect(createOpencodeClientMock).toHaveBeenNthCalledWith(2, {
      baseUrl: 'http://127.0.0.1:4101',
      fetch: expect.any(Function),
    });
  });

  it('uses the configured OpenCode SDK server URL without spawning a managed server', async () => {
    process.env = {
      ...originalEnv,
      OPENCODE_SDK_SERVER_URL: 'http://127.0.0.1:4096',
    };
    mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
      R_MODEL: 'openrouter/z-ai/glm-5.2',
      R_SMALL_MODEL: 'openrouter/openai/gpt-5.4',
    });
    sessionPromptMock.mockResolvedValue({
      data: {
        info: {
          structured: {
            workspaceValue: 'Full Stack',
            reasoning: 'Best fit',
            confidence: 0.92,
            needsExternalLookup: false,
            externalReference: null,
          },
        },
        parts: [],
      },
      error: undefined,
    });

    const { generateTrackedNonTaskObject, NON_TASK_INFERENCE_SURFACES } =
      await import('../non-task-provider-usage.js');
    const schema = z.object({
      workspaceValue: z.string(),
      reasoning: z.string(),
      confidence: z.number(),
      needsExternalLookup: z.boolean(),
      externalReference: z.string().nullable(),
    });

    const result = await generateTrackedNonTaskObject({
      surface: NON_TASK_INFERENCE_SURFACES.routerTaskRouting,
      schema,
      system: 'You route tasks.',
      prompt: 'Choose a workspace.',
    });

    expect(result.object.workspaceValue).toBe('Full Stack');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(createOpencodeClientMock).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:4096',
      fetch: expect.any(Function),
    });
    // Sessions are locked down: an empty scratch directory (never the
    // service's own working directory) and a deny-all permission ruleset.
    expect(sessionCreateMock).toHaveBeenCalledWith(
      {
        directory: expect.stringContaining('roomote-non-task-'),
        title: `Roomote ${NON_TASK_INFERENCE_SURFACES.routerTaskRouting}`,
        // Enumerated denials, never a `*` wildcard: a wildcard also strips
        // the internal structured-output mechanism `format: json_schema`
        // relies on.
        permission: expect.arrayContaining([
          { permission: 'edit', pattern: '*', action: 'deny' },
          { permission: 'bash', pattern: '*', action: 'deny' },
          { permission: 'read', pattern: '*', action: 'deny' },
        ]),
      },
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    const sessionDirectory = sessionCreateMock.mock.calls[0]?.[0]
      ?.directory as string;
    expect(sessionDirectory).not.toBe(process.cwd());
    const sessionPermissions = sessionCreateMock.mock.calls[0]?.[0]
      ?.permission as Array<{ permission: string }>;
    expect(sessionPermissions.every((rule) => rule.permission !== '*')).toBe(
      true,
    );
    // The per-prompt tool filter is the fail-closed layer for tools the
    // enumerated denials cannot name (MCP/plugin tools on external servers):
    // everything off, with OpenCode's internal StructuredOutput tool as the
    // only exception so `format: json_schema` keeps working.
    const promptTools = sessionPromptMock.mock.calls[0]?.[0]?.tools as Record<
      string,
      boolean
    >;
    expect(promptTools).toEqual({ '*': false, StructuredOutput: true });
    expect(
      Object.entries(promptTools).filter(([, enabled]) => enabled),
    ).toEqual([['StructuredOutput', true]]);
    expect(sessionPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: 'session-1',
        directory: sessionDirectory,
        model: {
          providerID: 'openrouter',
          modelID: 'openai/gpt-5.4',
        },
        system: 'You route tasks.',
        format: expect.objectContaining({
          type: 'json_schema',
          retryCount: 2,
          schema: expect.objectContaining({
            type: 'object',
            properties: expect.objectContaining({
              workspaceValue: expect.any(Object),
            }),
          }),
        }),
        parts: [
          {
            type: 'text',
            text: 'Choose a workspace.',
          },
        ],
      }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('rejects when the SDK response omits structured data', async () => {
    process.env = {
      ...originalEnv,
      OPENCODE_SDK_SERVER_URL: 'http://127.0.0.1:4096',
    };
    mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
      R_MODEL: 'openrouter/z-ai/glm-5.2',
    });
    sessionPromptMock.mockResolvedValue({
      data: {
        info: {},
        parts: [
          {
            type: 'text',
            text: '```json\n{"answer":"ok"}\n```',
          },
        ],
      },
      error: undefined,
    });

    const { generateTrackedNonTaskObject, NON_TASK_INFERENCE_SURFACES } =
      await import('../non-task-provider-usage.js');

    await expect(
      generateTrackedNonTaskObject({
        surface: NON_TASK_INFERENCE_SURFACES.routerTaskRouting,
        schema: z.object({ answer: z.string() }),
        prompt: 'Answer.',
      }),
    ).rejects.toThrow('OpenCode structured prompt returned no structured data');
  });

  it('rejects when the SDK structured call fails', async () => {
    process.env = {
      ...originalEnv,
      OPENCODE_SDK_SERVER_URL: 'http://127.0.0.1:4096',
    };
    mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
      R_MODEL: 'openrouter/z-ai/glm-5.2',
    });
    sessionPromptMock.mockResolvedValue({
      data: undefined,
      error: {
        name: 'StructuredOutputError',
        data: {
          message: 'failed to satisfy schema',
          retries: 2,
        },
      },
    });

    const { generateTrackedNonTaskObject, NON_TASK_INFERENCE_SURFACES } =
      await import('../non-task-provider-usage.js');

    await expect(
      generateTrackedNonTaskObject({
        surface: NON_TASK_INFERENCE_SURFACES.routerTaskRouting,
        schema: z.object({ answer: z.string() }),
        prompt: 'Answer.',
      }),
    ).rejects.toThrow(
      // The resolved provider/model id rides in the message so a router
      // fallback log names the model without a database lookup.
      'OpenCode structured prompt failed (model openrouter/z-ai/glm-5.2): StructuredOutputError: failed to satisfy schema',
    );
  });

  it('reports OpenCode provider retries and rejects with the live session error', async () => {
    process.env = {
      ...originalEnv,
      OPENCODE_SDK_SERVER_URL: 'http://127.0.0.1:4096',
    };
    mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
      R_MODEL: 'openai/gpt-5.6-sol',
    });
    const providerError = {
      name: 'APIError',
      data: {
        message: 'Too Many Requests',
        statusCode: 429,
      },
    };
    eventSubscribeMock.mockResolvedValue({
      stream: (async function* () {
        yield {
          type: 'session.status' as const,
          properties: {
            sessionID: 'session-1',
            status: {
              type: 'retry' as const,
              attempt: 1,
              message: 'Too Many Requests',
              next: Date.now() + 5_000,
            },
          },
        };
        yield {
          type: 'session.error' as const,
          properties: {
            sessionID: 'session-1',
            error: providerError,
          },
        };
      })(),
    });
    sessionPromptMock.mockReturnValue(new Promise(() => undefined));
    const onProviderRetry = vi.fn();

    const {
      classifyNonTaskInferenceError,
      generateTrackedNonTaskObject,
      NON_TASK_INFERENCE_SURFACES,
    } = await import('../non-task-provider-usage.js');

    const result = generateTrackedNonTaskObject({
      surface: NON_TASK_INFERENCE_SURFACES.fastAgentQuestionAnswering,
      modelRole: 'primary',
      schema: z.object({ answer: z.string() }),
      prompt: 'Answer.',
      onProviderRetry,
    });
    const error = await result.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: 'NonTaskOpenCodePromptError',
      providerError,
    });
    expect(classifyNonTaskInferenceError(error)).toMatchObject({
      reason: 'rate_limited',
      retryable: true,
    });
    expect(onProviderRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        message: 'Too Many Requests',
      }),
    );
    expect(sessionAbortMock).toHaveBeenCalledWith({
      sessionID: 'session-1',
      directory: expect.stringContaining('roomote-non-task-'),
    });
  });

  it.each(['prompt_result', 'session_event'] as const)(
    'preserves and classifies a gateway block when %s settles first',
    async (settlement) => {
      process.env = {
        ...originalEnv,
        OPENCODE_SDK_SERVER_URL: 'http://127.0.0.1:4096',
      };
      mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
        R_MODEL: 'openai/gpt-5.6-sol',
      });
      const providerError = {
        name: 'APIError',
        data: {
          message:
            'Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource.',
          statusCode: 403,
          responseBody: '<html><title>Forbidden</title></html>',
        },
      };
      eventSubscribeMock.mockResolvedValue({
        stream:
          settlement === 'session_event'
            ? (async function* () {
                yield {
                  type: 'session.error' as const,
                  properties: { sessionID: 'session-1', error: providerError },
                };
              })()
            : [],
      });
      sessionPromptMock.mockImplementation(() =>
        settlement === 'prompt_result'
          ? Promise.resolve({
              data: { info: { error: providerError }, parts: [] },
              error: undefined,
            })
          : new Promise(() => undefined),
      );

      const {
        classifyNonTaskInferenceError,
        generateTrackedNonTaskObject,
        NON_TASK_INFERENCE_SURFACES,
      } = await import('../non-task-provider-usage.js');
      const result = generateTrackedNonTaskObject({
        surface: NON_TASK_INFERENCE_SURFACES.fastAgentQuestionAnswering,
        modelRole: 'primary',
        schema: z.object({ answer: z.string() }),
        prompt: 'Answer.',
        onProviderRetry: vi.fn(),
      });

      const error = await result.catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        name: 'NonTaskOpenCodePromptError',
        providerError,
      });
      expect(classifyNonTaskInferenceError(error)).toEqual({
        message: 'The inference provider gateway blocked the request.',
        reason: 'gateway_blocked',
        retryable: true,
      });
      expect(sessionAbortMock).toHaveBeenCalledWith({
        sessionID: 'session-1',
        directory: expect.stringContaining('roomote-non-task-'),
      });
    },
  );

  it('keeps named terminal OpenCode errors out of outer retry loops', async () => {
    const { classifyNonTaskInferenceError } =
      await import('../non-task-provider-usage.js');

    for (const [providerError, expectedReason] of [
      [
        {
          name: 'ProviderAuthError',
          data: { providerID: 'openai', message: 'No API key found' },
        },
        'invalid_credentials',
      ],
      [
        {
          name: 'ContextOverflowError',
          data: { message: 'Input exceeds the context window' },
        },
        'provider_error',
      ],
      [
        {
          name: 'ContentFilterError',
          data: { message: 'The response was blocked' },
        },
        'provider_error',
      ],
      [
        {
          name: 'MessageOutputLengthError',
          data: {},
        },
        'provider_error',
      ],
    ] as const) {
      expect(classifyNonTaskInferenceError(providerError)).toMatchObject({
        reason: expectedReason,
        retryable: false,
      });
    }
  });

  it('continues observing provider errors when retry reporting fails', async () => {
    process.env = {
      ...originalEnv,
      OPENCODE_SDK_SERVER_URL: 'http://127.0.0.1:4096',
    };
    mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
      R_MODEL: 'openai/gpt-5.6-sol',
    });
    const providerError = {
      name: 'APIError',
      data: { message: 'Unauthorized', statusCode: 401 },
    };
    eventSubscribeMock.mockResolvedValue({
      stream: (async function* () {
        yield {
          type: 'session.status' as const,
          properties: {
            sessionID: 'session-1',
            status: {
              type: 'retry' as const,
              attempt: 1,
              message: 'Retrying',
              next: Date.now() + 1_000,
            },
          },
        };
        yield {
          type: 'session.error' as const,
          properties: { sessionID: 'session-1', error: providerError },
        };
      })(),
    });
    sessionPromptMock.mockReturnValue(new Promise(() => undefined));

    const { generateTrackedNonTaskObject, NON_TASK_INFERENCE_SURFACES } =
      await import('../non-task-provider-usage.js');

    await expect(
      generateTrackedNonTaskObject({
        surface: NON_TASK_INFERENCE_SURFACES.fastAgentQuestionAnswering,
        modelRole: 'primary',
        schema: z.object({ answer: z.string() }),
        prompt: 'Answer.',
        onProviderRetry: vi.fn().mockRejectedValue(new Error('Slack failed')),
      }),
    ).rejects.toMatchObject({
      name: 'NonTaskOpenCodePromptError',
      providerError,
    });
  });

  it('returns the joined text parts from a plain SDK prompt', async () => {
    process.env = {
      ...originalEnv,
      OPENCODE_SDK_SERVER_URL: 'http://127.0.0.1:4096',
    };
    mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
      R_MODEL: 'openrouter/z-ai/glm-5.2',
      R_SMALL_MODEL: 'openrouter/openai/gpt-5.4',
    });
    sessionPromptMock.mockResolvedValue({
      data: {
        info: { error: null },
        parts: [
          { type: 'text', text: 'clean answer' },
          { type: 'tool', tool: 'read', state: { status: 'completed' } },
        ],
      },
      error: undefined,
    });

    const { generateTrackedNonTaskText, NON_TASK_INFERENCE_SURFACES } =
      await import('../non-task-provider-usage.js');

    const result = await generateTrackedNonTaskText({
      surface: NON_TASK_INFERENCE_SURFACES.taskSummaryGeneration,
      system: 'You summarize.',
      prompt: 'Summarize the change.',
    });

    expect(result).toBe('clean answer');
    expect(sessionPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: 'session-1',
        directory: expect.stringContaining('roomote-non-task-'),
        model: {
          providerID: 'openrouter',
          modelID: 'openai/gpt-5.4',
        },
        system: 'You summarize.',
        parts: [
          {
            type: 'text',
            text: 'Summarize the change.',
          },
        ],
      }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    // Plain-text calls never send a structured-output format.
    expect(sessionPromptMock.mock.calls[0]?.[0]).not.toHaveProperty('format');
  });

  it('uses the deployment primary model for text when requested', async () => {
    process.env = {
      ...originalEnv,
      OPENCODE_SDK_SERVER_URL: 'http://127.0.0.1:4096',
    };
    mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
      R_MODEL: 'openrouter/z-ai/glm-5.2',
      R_SMALL_MODEL: 'openrouter/openai/gpt-5.4',
    });
    sessionPromptMock.mockResolvedValue({
      data: {
        info: { error: null },
        parts: [{ type: 'text', text: 'primary answer' }],
      },
      error: undefined,
    });

    const { generateTrackedNonTaskText, NON_TASK_INFERENCE_SURFACES } =
      await import('../non-task-provider-usage.js');

    const result = await generateTrackedNonTaskText({
      surface: NON_TASK_INFERENCE_SURFACES.fastAgentQuestionAnswering,
      modelRole: 'primary',
      prompt: 'Answer.',
    });

    expect(result).toBe('primary answer');
    expect(sessionPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          providerID: 'openrouter',
          modelID: 'z-ai/glm-5.2',
        },
      }),
      expect.any(Object),
    );
  });

  it('addresses Mantle GPT helper models by their runtime provider id', async () => {
    process.env = {
      ...originalEnv,
      OPENCODE_SDK_SERVER_URL: 'http://127.0.0.1:4096',
    };
    mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
      R_MODEL: 'openrouter/z-ai/glm-5.2',
      // The dashboard saves Mantle GPT helper models under `bedrock-mantle/`;
      // the runtime provider that actually serves them (and that the helper
      // server's config registers) is `bedrock-mantle-openai`.
      R_SMALL_MODEL: 'bedrock-mantle/openai.gpt-5.6-luna',
    });
    sessionPromptMock.mockResolvedValue({
      data: {
        info: { error: null },
        parts: [{ type: 'text', text: 'routed' }],
      },
      error: undefined,
    });

    const { generateTrackedNonTaskText, NON_TASK_INFERENCE_SURFACES } =
      await import('../non-task-provider-usage.js');

    await generateTrackedNonTaskText({
      surface: NON_TASK_INFERENCE_SURFACES.routerTaskRouting,
      prompt: 'Choose a workspace.',
    });

    expect(sessionPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          providerID: 'bedrock-mantle-openai',
          modelID: 'openai.gpt-5.6-luna',
        },
      }),
      expect.any(Object),
    );
  });

  it('registers an explicit Bedrock model on the helper server it leases', async () => {
    process.env = {
      ...originalEnv,
    };
    // The deployment's role models do not include the explicit model — its
    // provider registration must come from the explicit model itself.
    mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
      R_MODEL: 'openrouter/z-ai/glm-5.2',
      AWS_REGION: 'us-east-1',
    });
    sessionPromptMock.mockResolvedValue({
      data: {
        info: { error: null },
        parts: [{ type: 'text', text: 'ok' }],
      },
      error: undefined,
    });

    const { generateTrackedNonTaskText, NON_TASK_INFERENCE_SURFACES } =
      await import('../non-task-provider-usage.js');

    await generateTrackedNonTaskText({
      surface: NON_TASK_INFERENCE_SURFACES.routerTaskRouting,
      model: 'bedrock-mantle/openai.gpt-5.6-luna',
      prompt: 'Choose a workspace.',
    });

    const spawnEnv = spawnMock.mock.calls[0]?.[2]?.env as
      | NodeJS.ProcessEnv
      | undefined;
    const spawnedConfig = JSON.parse(
      spawnEnv?.OPENCODE_CONFIG_CONTENT ?? '{}',
    ) as {
      provider?: Record<string, unknown>;
    };

    expect(spawnedConfig.provider).toMatchObject({
      'bedrock-mantle-openai': {
        models: {
          'openai.gpt-5.6-luna': { name: 'openai.gpt-5.6-luna' },
        },
      },
    });
    expect(sessionPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          providerID: 'bedrock-mantle-openai',
          modelID: 'openai.gpt-5.6-luna',
        },
      }),
      expect.any(Object),
    );
  });

  it('uses an audio-capable configured model for native file prompts', async () => {
    process.env = {
      ...originalEnv,
      OPENCODE_SDK_SERVER_URL: 'http://127.0.0.1:4096',
    };
    mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
      R_MODEL: 'openrouter/openai/gpt-5.6-terra',
      R_SMALL_MODEL: 'openrouter/google/gemini-3.6-flash',
    });
    configProvidersMock.mockResolvedValue({
      data: {
        providers: [
          {
            id: 'openrouter',
            models: {
              'openai/gpt-5.6-terra': {
                capabilities: {
                  input: { audio: false },
                  output: { text: true },
                },
              },
              'google/gemini-3.6-flash': {
                capabilities: {
                  input: { audio: true },
                  output: { text: true },
                },
              },
            },
          },
        ],
        default: {},
      },
      error: undefined,
    });
    sessionPromptMock.mockResolvedValue({
      data: {
        info: { error: null },
        parts: [{ type: 'text', text: 'Deploy the fix.' }],
      },
      error: undefined,
    });

    const { generateTrackedNonTaskText, NON_TASK_INFERENCE_SURFACES } =
      await import('../non-task-provider-usage.js');
    const result = await generateTrackedNonTaskText({
      surface: NON_TASK_INFERENCE_SURFACES.chatAudioTranscription,
      prompt: 'Transcribe the audio.',
      requiredInputModality: 'audio',
      files: [
        {
          mime: 'audio/mp4',
          filename: 'clip.m4a',
          url: 'data:audio/mp4;base64,YXVkaW8=',
        },
      ],
    });

    expect(result).toBe('Deploy the fix.');
    expect(configProvidersMock).toHaveBeenCalledWith({
      directory: expect.stringContaining('roomote-non-task-'),
    });
    expect(sessionPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          providerID: 'openrouter',
          modelID: 'google/gemini-3.6-flash',
        },
        parts: [
          { type: 'text', text: 'Transcribe the audio.' },
          {
            type: 'file',
            mime: 'audio/mp4',
            filename: 'clip.m4a',
            url: 'data:audio/mp4;base64,YXVkaW8=',
          },
        ],
      }),
      expect.anything(),
    );
  });

  it('prefers the configured vision model for video prompts', async () => {
    process.env = {
      ...originalEnv,
      OPENCODE_SDK_SERVER_URL: 'http://127.0.0.1:4096',
    };
    mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
      R_MODEL: 'openrouter/openai/gpt-5.6-terra',
      R_SMALL_MODEL: 'openrouter/google/gemini-3.6-flash',
      R_VISION_MODEL: 'openrouter/google/gemini-3.6-pro',
    });
    configProvidersMock.mockResolvedValue({
      data: {
        providers: [
          {
            id: 'openrouter',
            models: {
              'openai/gpt-5.6-terra': {
                capabilities: {
                  input: { video: false },
                  output: { text: true },
                },
              },
              'google/gemini-3.6-flash': {
                capabilities: {
                  input: { video: true },
                  output: { text: true },
                },
              },
              'google/gemini-3.6-pro': {
                capabilities: {
                  input: { video: true },
                  output: { text: true },
                },
              },
            },
          },
        ],
        default: {},
      },
      error: undefined,
    });
    sessionPromptMock.mockResolvedValue({
      data: {
        info: { error: null },
        parts: [{ type: 'text', text: 'The save request fails.' }],
      },
      error: undefined,
    });

    const { generateTrackedNonTaskText, NON_TASK_INFERENCE_SURFACES } =
      await import('../non-task-provider-usage.js');
    await generateTrackedNonTaskText({
      surface: NON_TASK_INFERENCE_SURFACES.chatVideoDescription,
      prompt: 'Describe the video.',
      requiredInputModality: 'video',
      files: [
        {
          mime: 'video/mp4',
          url: 'data:video/mp4;base64,dmlkZW8=',
        },
      ],
    });

    expect(sessionPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          providerID: 'openrouter',
          modelID: 'google/gemini-3.6-pro',
        },
      }),
      expect.anything(),
    );
  });

  it('rejects native file prompts when configured models lack the modality', async () => {
    process.env = {
      ...originalEnv,
      OPENCODE_SDK_SERVER_URL: 'http://127.0.0.1:4096',
    };
    mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
      R_MODEL: 'openrouter/openai/gpt-5.6-terra',
    });
    configProvidersMock.mockResolvedValue({
      data: {
        providers: [
          {
            id: 'openrouter',
            models: {
              'openai/gpt-5.6-terra': {
                capabilities: {
                  input: { audio: false },
                  output: { text: true },
                },
              },
            },
          },
        ],
        default: {},
      },
      error: undefined,
    });

    const {
      generateTrackedNonTaskText,
      NonTaskInputModalityUnsupportedError,
      NON_TASK_INFERENCE_SURFACES,
    } = await import('../non-task-provider-usage.js');

    await expect(
      generateTrackedNonTaskText({
        surface: NON_TASK_INFERENCE_SURFACES.chatAudioTranscription,
        prompt: 'Transcribe the audio.',
        requiredInputModality: 'audio',
      }),
    ).rejects.toBeInstanceOf(NonTaskInputModalityUnsupportedError);
    expect(sessionPromptMock).not.toHaveBeenCalled();
  });

  it('rejects when the plain SDK prompt reports a message error', async () => {
    process.env = {
      ...originalEnv,
      OPENCODE_SDK_SERVER_URL: 'http://127.0.0.1:4096',
    };
    mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
      R_MODEL: 'openrouter/z-ai/glm-5.2',
    });
    sessionPromptMock.mockResolvedValue({
      data: {
        info: {
          error: {
            name: 'ProviderError',
            data: { message: 'model unavailable' },
          },
        },
        parts: [],
      },
      error: undefined,
    });

    const { generateTrackedNonTaskText, NON_TASK_INFERENCE_SURFACES } =
      await import('../non-task-provider-usage.js');

    await expect(
      generateTrackedNonTaskText({
        surface: NON_TASK_INFERENCE_SURFACES.taskSummaryGeneration,
        prompt: 'Summarize the change.',
      }),
    ).rejects.toThrow(
      'OpenCode text prompt failed: ProviderError: model unavailable',
    );
  });

  it('uses explicit models while still carrying resolved provider env when available', async () => {
    process.env = {
      ...originalEnv,
      OPENCODE_SDK_SERVER_URL: 'http://127.0.0.1:4096',
    };
    mockResolveEffectiveModelRuntimeEnv.mockResolvedValue({
      R_MODEL: 'openrouter/openai/gpt-5.4',
      OPENROUTER_API_KEY: 'test-key',
    });
    sessionPromptMock.mockResolvedValue({
      data: {
        info: {
          structured: {
            answer: 'ok',
          },
        },
        parts: [],
      },
      error: undefined,
    });

    const { generateTrackedNonTaskObject, NON_TASK_INFERENCE_SURFACES } =
      await import('../non-task-provider-usage.js');
    const result = await generateTrackedNonTaskObject({
      surface: NON_TASK_INFERENCE_SURFACES.routerTaskRouting,
      model: 'openrouter/z-ai/glm-5.2',
      schema: z.object({ answer: z.string() }),
      prompt: 'Answer.',
    });

    expect(result.object.answer).toBe('ok');
    expect(mockResolveEffectiveModelRuntimeEnv).toHaveBeenCalled();
    expect(sessionPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          providerID: 'openrouter',
          modelID: 'z-ai/glm-5.2',
        },
      }),
      expect.any(Object),
    );
  });
  it('validates candidate credentials with a managed non-task OpenCode server', async () => {
    process.env = {
      ...originalEnv,
      OPENCODE_SDK_SERVER_URL: 'http://127.0.0.1:4999',
    };
    sessionPromptMock.mockResolvedValue({
      data: {
        info: { structured: { ok: true } },
        parts: [],
      },
      error: undefined,
    });

    const { validateNonTaskInference } =
      await import('../non-task-provider-usage.js');
    const result = await validateNonTaskInference({
      model: 'anthropic/claude-sonnet-5',
      runtimeEnv: { ANTHROPIC_API_KEY: 'candidate-key' },
    });

    expect(result).toMatchObject({
      success: true,
      model: 'anthropic/claude-sonnet-5',
    });
    // Validation must not use the configured server, whose process may have
    // entirely different credentials from the candidate being checked.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[2]?.env).toMatchObject({
      ANTHROPIC_API_KEY: 'candidate-key',
      R_MODEL: 'anthropic/claude-sonnet-5',
    });
    expect(sessionPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        format: expect.objectContaining({ retryCount: 0 }),
        model: {
          providerID: 'anthropic',
          modelID: 'claude-sonnet-5',
        },
        tools: { '*': false, StructuredOutput: true },
      }),
      expect.any(Object),
    );
  });

  it.each([
    {
      providerError: '401 invalid API key sk-secret-that-must-not-leak',
      reason: 'invalid_credentials',
      retryable: false,
    },
    {
      providerError: '402 payment required: insufficient credits',
      reason: 'insufficient_credits',
      retryable: false,
    },
    {
      providerError: '429 too many requests',
      reason: 'rate_limited',
      retryable: true,
    },
  ])(
    'sanitizes a $reason provider validation failure',
    async ({ providerError, reason, retryable }) => {
      process.env = { ...originalEnv };
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      sessionPromptMock.mockResolvedValue({
        data: undefined,
        error: { data: { message: providerError } },
      });

      try {
        const { validateNonTaskInference } =
          await import('../non-task-provider-usage.js');
        const result = await validateNonTaskInference({
          model: 'openrouter/openai/gpt-5.6-terra',
          // The provider error above echoes this submitted key back, the
          // way real 401 responses can.
          runtimeEnv: { OPENROUTER_API_KEY: 'sk-secret-that-must-not-leak' },
        });

        expect(result).toMatchObject({ success: false, reason, retryable });
        expect(result.success || result.message).not.toContain('sk-secret');
        expect(result.success || result.message).not.toContain(providerError);
        // The server-side log keeps provider detail but must redact the
        // candidate credential the provider echoed.
        expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('sk-secret');
      } finally {
        warnSpy.mockRestore();
      }
    },
  );

  // Real provider rejections arrive as structured `{name, data: {message,
  // statusCode, responseBody}}` assistant errors whose wording varies too
  // much for keyword matching — Anthropic says "API key is invalid.",
  // Bedrock Mantle says "Invalid bearer token". The status code decides.
  it.each([
    {
      providerMessage: 'API key is invalid.',
      statusCode: 401,
      reason: 'invalid_credentials',
      retryable: false,
    },
    {
      providerMessage: 'Invalid bearer token',
      statusCode: 403,
      reason: 'invalid_credentials',
      retryable: false,
    },
    {
      providerMessage: 'upgrade your plan',
      statusCode: 402,
      reason: 'insufficient_credits',
      retryable: false,
    },
    {
      providerMessage: 'slow down',
      statusCode: 429,
      reason: 'rate_limited',
      retryable: true,
    },
    {
      providerMessage: 'request expired',
      statusCode: 408,
      reason: 'timeout',
      retryable: true,
    },
    // Other structured 4xx responses are client errors that resending the
    // same request cannot recover, so retry loops must not absorb them.
    {
      providerMessage: 'prompt is too long',
      statusCode: 400,
      reason: 'provider_error',
      retryable: false,
    },
    {
      providerMessage: 'unprocessable entity',
      statusCode: 422,
      reason: 'provider_error',
      retryable: false,
    },
    // Server-side failures stay retryable.
    {
      providerMessage: 'overloaded',
      statusCode: 529,
      reason: 'provider_error',
      retryable: true,
    },
  ])(
    'classifies a structured status-$statusCode provider error as $reason',
    async ({ providerMessage, statusCode, reason, retryable }) => {
      process.env = { ...originalEnv };
      sessionPromptMock.mockResolvedValue({
        data: {
          info: {
            error: {
              name: 'APIError',
              data: {
                message: providerMessage,
                statusCode,
                responseBody: `{"type":"error","error":{"message":"${providerMessage}"}}`,
              },
            },
          },
          parts: [],
        },
        error: undefined,
      });

      const { validateNonTaskInference } =
        await import('../non-task-provider-usage.js');
      const result = await validateNonTaskInference({
        model: 'anthropic/claude-sonnet-5',
        runtimeEnv: { ANTHROPIC_API_KEY: 'candidate-key' },
      });

      expect(result).toMatchObject({ success: false, reason, retryable });
      expect(result.success || result.message).not.toContain(providerMessage);
    },
  );
});

describe('createOpenCodeSdkFetch', () => {
  it('normalizes Request objects before calling the underlying fetch', async () => {
    const response = new Response('{}', { status: 200 });
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const sdkFetch = createOpenCodeSdkFetch(
      fetchImpl as unknown as typeof fetch,
    );
    const request = new Request(
      'http://127.0.0.1:4096/session/session-1/message',
      {
        body: '{"ok":true}',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );

    await expect(sdkFetch(request)).resolves.toBe(response);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:4096/session/session-1/message',
      expect.objectContaining({
        body: request.body,
        duplex: 'half',
        headers: request.headers,
        method: 'POST',
      }),
    );
  });
});

describe('non-task OpenCode image packaging', () => {
  it('pins the same OpenCode version in the worker and control-plane inference images', () => {
    const appDockerfile = fs.readFileSync(
      new URL('../../../../../.docker/app/Dockerfile', import.meta.url),
      'utf8',
    );
    const workerDockerfile = fs.readFileSync(
      new URL('../../../../../apps/worker/Dockerfile', import.meta.url),
      'utf8',
    );

    expect(getOpenCodeCliVersionArg(workerDockerfile)).toBe(
      DEFAULT_OPENCODE_CLI_VERSION,
    );
    expect(workerDockerfile).toContain('"opencode-ai@${OPENCODE_CLI_VERSION}"');

    // Non-task inference (routing, summaries, automation planning) starts a
    // managed OpenCode SDK server in-process, so control-plane services that
    // execute those workflows carry the CLI too — at the same pinned version
    // the SDK expects — but only via the shared inference base stage.
    expect(getOpenCodeCliVersionArg(appDockerfile)).toBe(
      DEFAULT_OPENCODE_CLI_VERSION,
    );

    const inferenceBaseStage = appDockerfile
      .split(/^FROM /mu)
      .find((stage) =>
        stage.startsWith('runtime-base AS runtime-inference-base'),
      );

    expect(inferenceBaseStage).toContain(
      '"opencode-ai@${OPENCODE_CLI_VERSION}"',
    );
    expect(appDockerfile.match(/opencode-ai@/gu)).toHaveLength(1);
  });
});
