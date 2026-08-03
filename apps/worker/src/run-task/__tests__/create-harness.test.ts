import { PassThrough } from 'node:stream';
import EventEmitter from 'node:events';

const {
  taskRunsStampMilestoneMock,
  getHarnessModelOverrideMock,
  resolveBuiltInMcpServersMock,
  subscribeHarnessCallbacksMock,
  startOpenCodeServerHarnessMock,
} = vi.hoisted(() => ({
  taskRunsStampMilestoneMock: vi.fn().mockResolvedValue(undefined),
  getHarnessModelOverrideMock: vi.fn(),
  resolveBuiltInMcpServersMock: vi.fn(() => []),
  subscribeHarnessCallbacksMock: vi.fn(() => async () => {}),
  startOpenCodeServerHarnessMock: vi.fn(),
}));

vi.mock('@roomote/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/types')>();

  getHarnessModelOverrideMock.mockImplementation(
    actual.getHarnessModelOverride,
  );

  return {
    ...actual,
    getHarnessModelOverride: getHarnessModelOverrideMock,
  };
});

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      stampMilestone: taskRunsStampMilestoneMock,
    },
  },
}));

vi.mock('../../sandbox-server', () => ({
  startOpenCodeServerHarness: startOpenCodeServerHarnessMock,
}));

vi.mock('../../commands/setup/setup-mcps', () => ({
  resolveBuiltInMcpServers: resolveBuiltInMcpServersMock,
}));

vi.mock('../subscribe-harness-callbacks', () => ({
  subscribeHarnessCallbacks: subscribeHarnessCallbacksMock,
}));

import { createHarness } from '../create-harness';

function createPendingSubprocess(stdout = new PassThrough()) {
  return Object.assign(new Promise<never>(() => undefined), {
    stdout,
    kill: vi.fn(),
  });
}

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

function createConnectedHarness() {
  return new (class extends EventEmitter {
    subscribe() {
      return () => {};
    }
    subscribeRuntimeOutput() {
      return () => {};
    }
    subscribeRuntimePersistedEnvelope() {
      return () => {};
    }
    subscribeRuntimeTurnCompleted() {
      return () => {};
    }
    subscribeTaskMessageEnvelope() {
      return () => {};
    }
    subscribeTurnCompleted() {
      return () => {};
    }
    get supportsNativeTurnSteering() {
      return false;
    }
    getPendingUserInputRequests() {
      return [];
    }
    getQueuedMessages() {
      return [];
    }
    getQueuedMessageSnapshots() {
      return [];
    }
    get isConnected() {
      return true;
    }
    sendCommand() {
      return true;
    }
    dispose() {}
  })();
}

describe('createHarness', () => {
  beforeEach(() => {
    taskRunsStampMilestoneMock.mockReset();
    taskRunsStampMilestoneMock.mockResolvedValue(undefined);
    getHarnessModelOverrideMock.mockClear();
    resolveBuiltInMcpServersMock.mockReset();
    resolveBuiltInMcpServersMock.mockReturnValue([]);
    subscribeHarnessCallbacksMock.mockClear();
    startOpenCodeServerHarnessMock.mockReset();
  });

  it('strips source-control tokens from the long-lived harness env while keeping BASH_ENV', async () => {
    const subprocess = createPendingSubprocess();

    startOpenCodeServerHarnessMock.mockResolvedValue({
      harness: createConnectedHarness(),
      subprocess,
    });

    await createHarness({
      harnessType: 'opencode-server',
      workspacePath: '/tmp/workspace',
      runtimeEnv: {
        GH_TOKEN: 'ghs_stale',
        GITLAB_TOKEN: 'glpat_stale',
        GITEA_TOKEN: 'gitea_stale',
        ADO_TOKEN: 'ado_stale',
        BASH_ENV: '/home/testuser/.roomote/env.sh',
        OPENAI_API_KEY: 'sk-test-openai',
      },
      harnessSessionId: 'session-1',
      cancelSignal: new AbortController().signal,
      integrations: {} as never,
      mcpTaskEnv: {},
      taskRun: { id: 1, taskId: 'task-1' } as never,
      callbacks: {} as never,
      context: {} as never,
      logger: createLogger(),
    });

    expect(startOpenCodeServerHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEnv: {
          BASH_ENV: '/home/testuser/.roomote/env.sh',
          OPENAI_API_KEY: 'sk-test-openai',
        },
      }),
    );
  });

  it('passes the reconnectable session id through to the OpenCode harness', async () => {
    const subprocess = createPendingSubprocess();

    startOpenCodeServerHarnessMock.mockResolvedValue({
      harness: createConnectedHarness(),
      subprocess,
    });

    await createHarness({
      harnessType: 'opencode-server',
      workspacePath: '/tmp/workspace',
      runtimeEnv: {
        OPENAI_API_KEY: 'sk-test-openai',
      },
      harnessSessionId: 'thread-resume-123',
      cancelSignal: new AbortController().signal,
      integrations: {} as never,
      mcpTaskEnv: {},
      taskRun: { id: 1, taskId: 'task-1' } as never,
      callbacks: {} as never,
      context: {} as never,
      logger: createLogger(),
    });

    expect(startOpenCodeServerHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialSessionId: 'thread-resume-123',
      }),
    );
  });

  it('passes an OpenCode model override to the OpenCode harness', async () => {
    const subprocess = createPendingSubprocess();

    startOpenCodeServerHarnessMock.mockResolvedValue({
      harness: createConnectedHarness(),
      subprocess,
    });

    await createHarness({
      harnessType: 'opencode-server',
      workspacePath: '/tmp/workspace',
      runtimeEnv: {
        OPENAI_API_KEY: 'sk-test-openai',
      },
      harnessSessionId: undefined,
      cancelSignal: new AbortController().signal,
      integrations: {} as never,
      mcpTaskEnv: {},
      taskRun: {
        id: 4,
        taskId: 'task-4',
        payload: {
          harnessModelOverrides: {
            'opencode-server': 'provider-id/model-id',
          },
          reasoningEffort: 'high',
        },
      } as never,
      callbacks: {} as never,
      context: {} as never,
      logger: createLogger(),
    });

    expect(startOpenCodeServerHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOverride: 'provider-id/model-id',
        reasoningEffortOverride: 'high',
      }),
    );
    expect(getHarnessModelOverrideMock).toHaveBeenCalledTimes(1);
  });

  it('starts opencode-server with its model override and generated prompt inputs', async () => {
    const subprocess = createPendingSubprocess();

    startOpenCodeServerHarnessMock.mockResolvedValue({
      harness: createConnectedHarness(),
      subprocess,
    });

    await createHarness({
      harnessType: 'opencode-server',
      workspacePath: '/tmp/workspace',
      runtimeEnv: {
        GH_TOKEN: 'ghs_stale',
        OPENAI_API_KEY: 'sk-test-openai',
      },
      harnessSessionId: 'ses_resume',
      cancelSignal: new AbortController().signal,
      integrations: {} as never,
      mcpTaskEnv: {},
      taskRun: {
        id: 6,
        taskId: 'task-6',
        payload: {
          harnessModelOverrides: {
            'opencode-server': 'provider-id/model-id',
          },
        },
      } as never,
      developerInstructionsContent: 'developer instructions',
      callbacks: {} as never,
      context: {} as never,
      logger: createLogger(),
    });

    expect(startOpenCodeServerHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: '/tmp/workspace',
        runtimeEnv: {
          OPENAI_API_KEY: 'sk-test-openai',
        },
        initialSessionId: 'ses_resume',
        modelOverride: 'provider-id/model-id',
        developerInstructionsContent: 'developer instructions',
      }),
    );
    expect(getHarnessModelOverrideMock).toHaveBeenCalledWith(
      {
        'opencode-server': 'provider-id/model-id',
      },
      'opencode-server',
    );
  });

  it('passes the queued actor-scope hook through to the OpenCode harness', async () => {
    const subprocess = createPendingSubprocess();
    const beforeQueuedPrompt = vi.fn();

    startOpenCodeServerHarnessMock.mockResolvedValue({
      harness: createConnectedHarness(),
      subprocess,
    });

    await createHarness({
      harnessType: 'opencode-server',
      workspacePath: '/tmp/workspace',
      runtimeEnv: {
        OPENAI_API_KEY: 'sk-test-openai',
      },
      harnessSessionId: undefined,
      cancelSignal: new AbortController().signal,
      integrations: {} as never,
      mcpTaskEnv: {},
      taskRun: { id: 5, taskId: 'task-5' } as never,
      callbacks: {} as never,
      context: {} as never,
      logger: createLogger(),
      prepareQueuedPromptActorScope: beforeQueuedPrompt,
    });

    const startOptions = startOpenCodeServerHarnessMock.mock.calls[0]?.[0] as
      | {
          beforeQueuedPrompt?: (input: { userId?: string }) => Promise<unknown>;
        }
      | undefined;

    expect(startOptions?.beforeQueuedPrompt).toBeTypeOf('function');
    await expect(
      startOptions?.beforeQueuedPrompt?.({ userId: 'user-2' }),
    ).resolves.toBeUndefined();
    expect(beforeQueuedPrompt).toHaveBeenCalledWith('user-2');
  });

  it('stamps harnessStartedAt once the harness subprocess is alive', async () => {
    const subprocess = createPendingSubprocess();

    startOpenCodeServerHarnessMock.mockResolvedValue({
      harness: createConnectedHarness(),
      subprocess,
    });

    await createHarness({
      harnessType: 'opencode-server',
      workspacePath: '/tmp/workspace',
      runtimeEnv: {
        OPENAI_API_KEY: 'sk-test-openai',
      },
      harnessSessionId: 'session-1',
      cancelSignal: new AbortController().signal,
      integrations: {} as never,
      mcpTaskEnv: {},
      taskRun: { id: 77, taskId: 'task-77' } as never,
      callbacks: {} as never,
      context: {} as never,
      logger: createLogger(),
    });

    expect(taskRunsStampMilestoneMock).toHaveBeenCalledWith({
      runId: 77,
      field: 'harnessStartedAt',
    });
  });

  it('starts OpenCode with the resolved MCP map and remounts with refreshed MCPs on reconnect', async () => {
    const initialHarness = createConnectedHarness();
    const reconnectedHarness = createConnectedHarness();
    const initialSubprocess = createPendingSubprocess(new PassThrough());
    const reconnectedSubprocess = createPendingSubprocess(new PassThrough());
    const integrations = {
      userMcpServers: {
        roomote: {
          url: 'https://actor-a.example/mcp',
        },
      },
    };

    startOpenCodeServerHarnessMock
      .mockResolvedValueOnce({
        harness: initialHarness,
        subprocess: initialSubprocess,
      })
      .mockResolvedValueOnce({
        harness: reconnectedHarness,
        subprocess: reconnectedSubprocess,
      });
    resolveBuiltInMcpServersMock.mockImplementation(((...args: unknown[]) => {
      const currentIntegrations = args[1] as typeof integrations;
      return currentIntegrations.userMcpServers ?? ({} as never);
    }) as never);

    const result = await createHarness({
      harnessType: 'opencode-server',
      workspacePath: '/tmp/workspace',
      runtimeEnv: {
        GH_TOKEN: 'ghs_stale',
        BASH_ENV: '/home/testuser/.roomote/env.sh',
        OPENAI_API_KEY: 'sk-test-openai',
      },
      harnessSessionId: undefined,
      cancelSignal: new AbortController().signal,
      integrations: integrations as never,
      mcpTaskEnv: {},
      taskRun: { id: 1, taskId: 'task-1' } as never,
      callbacks: {} as never,
      context: {} as never,
      logger: createLogger(),
    });

    expect(startOpenCodeServerHarnessMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspacePath: '/tmp/workspace',
        runtimeEnv: {
          BASH_ENV: '/home/testuser/.roomote/env.sh',
          OPENAI_API_KEY: 'sk-test-openai',
        },
        cancelSignal: expect.any(AbortSignal),
        logger: expect.any(Object),
        mcpServers: {
          roomote: {
            url: 'https://actor-a.example/mcp',
          },
        },
        initialSessionId: undefined,
      }),
    );
    expect(getHarnessModelOverrideMock).not.toHaveBeenCalled();
    expect(result.harness.requestReconnect).toBeTypeOf('function');
    expect(taskRunsStampMilestoneMock).toHaveBeenCalledWith({
      runId: 1,
      field: 'harnessStartedAt',
    });
    expect(subscribeHarnessCallbacksMock).toHaveBeenCalledWith(
      expect.objectContaining({
        harness: result.harness,
        taskRun: { id: 1, taskId: 'task-1' },
      }),
    );
    expect(result.getSubprocess()).toBe(initialSubprocess);

    integrations.userMcpServers = {
      roomote: {
        url: 'https://actor-b.example/mcp',
      },
    };
    result.harness.setCommandEnv?.({
      BASH_ENV: '/home/testuser/.roomote/env.sh',
      OPENAI_API_KEY: 'sk-fresh-openai',
    });

    await result.harness.requestReconnect?.({
      reason: 'actor-scoped MCP refresh for actor-b',
    });

    expect(startOpenCodeServerHarnessMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspacePath: '/tmp/workspace',
        runtimeEnv: {
          BASH_ENV: '/home/testuser/.roomote/env.sh',
          OPENAI_API_KEY: 'sk-fresh-openai',
        },
        cancelSignal: expect.any(AbortSignal),
        logger: expect.any(Object),
        mcpServers: {
          roomote: {
            url: 'https://actor-b.example/mcp',
          },
        },
        initialSessionId: undefined,
      }),
    );
    expect(result.getSubprocess()).toBe(reconnectedSubprocess);
  });
});
