const mocks = vi.hoisted(() => ({
  appendVisibleMessages: vi.fn(),
  getActiveTasks: vi.fn(),
  getSession: vi.fn(),
  getEnvironments: vi.fn(),
  getTaskModelOptions: vi.fn(),
  generateText: vi.fn(),
  classifyInferenceError: vi.fn(),
  invalidateSession: vi.fn(),
  runSession: vi.fn(),
  listIntegrations: vi.fn(),
  callIntegration: vi.fn(),
  sendTaskMessage: vi.fn(),
  cancelTask: vi.fn(),
  inspectTasks: vi.fn(),
  getChatMessageContext: vi.fn(),
  getChatChannelMessages: vi.fn(),
  getUserIdentity: vi.fn(),
  bindExecutor: vi.fn(),
  nativeExecutor: undefined as
    | ((call: {
        name: string;
        args: Record<string, unknown>;
      }) => Promise<unknown>)
    | undefined,
}));

const nativeToolNames = vi.hoisted(
  () =>
    ({
      cancelTask: 'cancel_task',
      getChatChannelMessages: 'get_chat_channel_messages',
      getChatMessageContext: 'get_chat_message_context',
      ignoreEvent: 'ignore_event',
      integrationCall: 'integration_call',
      launchTask: 'launch_task',
      manageTasks: 'manage_tasks',
      retryTaskStart: 'retry_task_start',
      sendChatReaction: 'send_chat_reaction',
      sendChatReply: 'send_chat_reply',
      sendTaskMessage: 'send_task_message',
    }) as const,
);

const fastAgentSessionPermissions = vi.hoisted(() => [
  { permission: 'task', pattern: '*', action: 'allow' },
]);

vi.mock('../fast-agent-session', () => ({
  appendFastAgentVisibleMessages: mocks.appendVisibleMessages,
  getActiveFastAgentTasks: mocks.getActiveTasks,
  getOrCreateFastAgentSession: mocks.getSession,
}));

vi.mock('../../router', () => ({
  getAvailableEnvironments: mocks.getEnvironments,
}));

vi.mock('@roomote/db/server', () => ({
  getDeploymentTaskModelOptions: mocks.getTaskModelOptions,
}));

vi.mock('../../non-task-provider-usage', () => ({
  FAST_AGENT_SESSION_PERMISSIONS: fastAgentSessionPermissions,
  NON_TASK_INFERENCE_SURFACES: {
    fastAgentQuestionAnswering: 'fast_agent',
  },
  classifyNonTaskInferenceError: mocks.classifyInferenceError,
  generateTrackedNonTaskTextInOpenCodeSession: mocks.generateText,
  NonTaskOpenCodePromptTimeoutError: class extends Error {
    constructor(timeoutMs: number) {
      super(`Timed out waiting for OpenCode output after ${timeoutMs}ms.`);
      this.name = 'NonTaskOpenCodePromptTimeoutError';
    }
  },
  isNonTaskOpenCodePromptTimeoutError: (error: unknown) =>
    error instanceof Error &&
    error.name === 'NonTaskOpenCodePromptTimeoutError',
  isNonTaskOpenCodeSessionNotFoundError: (error: unknown) =>
    error instanceof Error &&
    error.name === 'NonTaskOpenCodeSessionNotFoundError',
}));

vi.mock('../fast-agent-opencode-session', () => ({
  fastAgentOpenCodeSessionManager: {
    invalidate: mocks.invalidateSession,
    run: mocks.runSession,
  },
}));

vi.mock('../fast-agent-native-tool-bridge', () => ({
  FAST_AGENT_NATIVE_TOOL_NAMES: nativeToolNames,
  FAST_AGENT_NATIVE_TOOL_FILTER: {
    '*': false,
    send_chat_reply: true,
    task: true,
  },
  getFastAgentNativeToolRuntime: vi.fn(async () => ({
    directory: '/tmp/fast-native-tools',
    env: {
      ROOMOTE_FAST_TOOL_BRIDGE_URL: 'http://127.0.0.1:4321/tool',
      ROOMOTE_FAST_TOOL_BRIDGE_TOKEN: 'test-token',
    },
  })),
  bindFastAgentNativeToolExecutor: mocks.bindExecutor,
}));

vi.mock('../fast-agent-integration-broker', () => ({
  listFastAgentIntegrations: mocks.listIntegrations,
  callFastAgentIntegration: mocks.callIntegration,
}));

vi.mock('../fast-agent-tasks', () => ({
  sendFastAgentTaskMessage: mocks.sendTaskMessage,
  cancelFastAgentTask: mocks.cancelTask,
  inspectFastAgentTasks: mocks.inspectTasks,
}));

vi.mock('../fast-agent-user-identity', () => ({
  getFastAgentUserIdentity: mocks.getUserIdentity,
}));

import { answerFastAgentQuestion } from '../fast-agent-service';
import type {
  FastAgentTurnAdapter,
  LaunchFastAgentTask,
} from '../fast-agent-conversation';

const baseParams = {
  question: 'What does this service do?',
  userId: 'user-1',
  apiBaseUrl: 'https://api.example.com',
  conversation: {
    surface: 'slack' as const,
    workspaceId: 'team-1',
    conversationId: '100.1',
    replyTarget: { channelId: 'channel-1', threadId: '100.1' },
  },
  currentMessageId: '100.2',
  senderDisplayName: 'Matt',
  senderExternalId: 'U123',
};

function callbacks(
  overrides: Partial<FastAgentTurnAdapter> = {},
): FastAgentTurnAdapter {
  return {
    launchTask: vi.fn<LaunchFastAgentTask>(),
    getChatMessageContext: mocks.getChatMessageContext,
    getChatChannelMessages: mocks.getChatChannelMessages,
    postReply: vi.fn().mockResolvedValue(undefined),
    postReaction: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function invokeTool(name: string, args: Record<string, unknown>) {
  if (!mocks.nativeExecutor) throw new Error('Native executor is not bound.');
  return mocks.nativeExecutor({ name, args });
}

describe('answerFastAgentQuestion native OpenCode tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nativeExecutor = undefined;
    mocks.runSession.mockImplementation(
      ({
        prompt,
        execute,
      }: {
        prompt: string;
        execute: (
          session: { id?: string },
          selectedPrompt: string,
        ) => Promise<unknown>;
      }) => execute({ id: 'opencode-session-1' }, prompt),
    );
    mocks.bindExecutor.mockImplementation((_sessionID, executor) => {
      mocks.nativeExecutor = executor;
      return () => {
        mocks.nativeExecutor = undefined;
      };
    });
    mocks.getSession.mockResolvedValue({
      id: 'conversation-1',
      compatibilityMessages: [],
    });
    mocks.getActiveTasks.mockResolvedValue([]);
    mocks.getEnvironments.mockResolvedValue([
      {
        id: 'env-1',
        name: 'App',
        repositoryNames: ['acme/app'],
      },
    ]);
    mocks.getTaskModelOptions.mockResolvedValue({
      models: [
        { id: 'openai/gpt-5.6', displayName: 'GPT-5.6' },
        { id: 'anthropic/claude-sonnet-5', displayName: 'Claude Sonnet 5' },
      ],
      defaultModelId: 'openai/gpt-5.6',
    });
    mocks.listIntegrations.mockResolvedValue([]);
    mocks.callIntegration.mockResolvedValue({ matches: ['fast-agent.ts'] });
    mocks.sendTaskMessage.mockResolvedValue({ success: true });
    mocks.cancelTask.mockResolvedValue({ success: true });
    mocks.inspectTasks.mockResolvedValue({
      id: 'task-1',
      taskRunStatus: 'running',
    });
    mocks.getChatMessageContext.mockResolvedValue({
      requestedMessageId: '100.1',
      messages: [{ id: '100.1', text: 'Context' }],
    });
    mocks.getChatChannelMessages.mockResolvedValue({
      messages: [{ id: '100.1', text: 'History' }],
    });
    mocks.getUserIdentity.mockResolvedValue({
      displayName: 'Matt Rubens',
      githubLogin: 'mrubens',
    });
    mocks.classifyInferenceError.mockImplementation((error: unknown) => {
      const detail = error instanceof Error ? error.message.toLowerCase() : '';

      if (detail.includes('429') || detail.includes('rate limit')) {
        return {
          message: 'The inference provider is rate limiting requests.',
          reason: 'rate_limited',
          retryable: true,
        };
      }
      if (detail.includes('gateway or proxy')) {
        return {
          message: 'The inference provider gateway blocked the request.',
          reason: 'gateway_blocked',
          retryable: true,
        };
      }
      if (detail.includes('fetch failed') || detail.includes('network error')) {
        return {
          message: 'Roomote could not reach the inference provider endpoint.',
          reason: 'endpoint_unreachable',
          retryable: true,
        };
      }
      if (detail.includes('timed out') || detail.includes('timeout')) {
        return {
          message: 'The inference provider did not respond in time.',
          reason: 'timeout',
          retryable: true,
        };
      }
      if (detail.includes('content filter')) {
        return {
          message:
            'The inference provider blocked the response with its content filter.',
          reason: 'content_filter',
          retryable: false,
        };
      }

      return {
        message: 'The inference provider rejected the request.',
        reason: 'provider_error',
        retryable: false,
      };
    });
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        options.onModelResolved?.('openrouter/openai/gpt-5.4');
        await options.onSessionReady('opencode-session-1');
        options.onPromptStarted?.();
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'closeout',
          message: 'It coordinates incoming requests.',
        });
        return '';
      },
    );
  });

  it('posts an immediate answer through a native chat tool', async () => {
    const adapter = callbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      adapter,
    });

    expect(result).toBe('It coordinates incoming requests.');
    expect(adapter.postReply).toHaveBeenCalledWith({
      purpose: 'closeout',
      message: 'It coordinates incoming requests.',
    });
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRole: 'orchestration',
        prompt: expect.stringContaining('What does this service do?'),
        timeoutMs: null,
      }),
      { id: 'opencode-session-1' },
      expect.objectContaining({
        directory: '/tmp/fast-native-tools',
        permission: fastAgentSessionPermissions,
        promptOnlySubagents: true,
        tools: expect.objectContaining({
          send_chat_reply: true,
          task: true,
        }),
      }),
    );
    expect(mocks.appendVisibleMessages).toHaveBeenCalledWith({
      sessionId: 'conversation-1',
      messages: [
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'assistant' }),
      ],
    });
  });

  it('reads message context and history through the conversation adapter', async () => {
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        await invokeTool(nativeToolNames.getChatMessageContext, {
          messageId: '100.1',
        });
        await invokeTool(nativeToolNames.getChatChannelMessages, {
          oldest: '99.1',
          latest: '101.1',
        });
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'closeout',
          message: 'I found the context.',
        });
        return '';
      },
    );
    const adapter = callbacks();

    await answerFastAgentQuestion({ ...baseParams, adapter });

    expect(adapter.getChatMessageContext).toHaveBeenCalledWith({
      messageId: '100.1',
    });
    expect(adapter.getChatChannelMessages).toHaveBeenCalledWith({
      oldest: '99.1',
      latest: '101.1',
    });
  });

  it('defaults unbounded Slack history reads to the previous 24 hours', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T12:00:00.000Z'));
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        await invokeTool(nativeToolNames.getChatChannelMessages, {});
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'closeout',
          message: 'I found the context.',
        });
        return '';
      },
    );
    const adapter = callbacks();

    try {
      await answerFastAgentQuestion({ ...baseParams, adapter });
    } finally {
      vi.useRealTimers();
    }

    expect(adapter.getChatChannelMessages).toHaveBeenCalledWith({
      oldest: '2026-08-23T12:00:00.000Z',
    });
  });

  it('bounds Slack history relative to an explicit latest timestamp', async () => {
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        await invokeTool(nativeToolNames.getChatChannelMessages, {
          latest: '1710000000.000000',
        });
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'closeout',
          message: 'I found the context.',
        });
        return '';
      },
    );
    const adapter = callbacks();

    await answerFastAgentQuestion({ ...baseParams, adapter });

    expect(adapter.getChatChannelMessages).toHaveBeenCalledWith({
      latest: '1710000000.000000',
      oldest: '2024-03-08T16:00:00.000Z',
    });
  });

  it('bounds Slack history relative to an explicit ISO latest date', async () => {
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        await invokeTool(nativeToolNames.getChatChannelMessages, {
          latest: '2026-08-24T12:00:00.000Z',
        });
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'closeout',
          message: 'I found the context.',
        });
        return '';
      },
    );
    const adapter = callbacks();

    await answerFastAgentQuestion({ ...baseParams, adapter });

    expect(adapter.getChatChannelMessages).toHaveBeenCalledWith({
      latest: '2026-08-24T12:00:00.000Z',
      oldest: '2026-08-23T12:00:00.000Z',
    });
  });

  it('binds only integration and task inspection tools for subagent sessions', async () => {
    const adapter = callbacks();
    mocks.listIntegrations.mockResolvedValue([
      {
        id: 'github',
        name: 'GitHub',
        description: 'Repository access',
        tools: [{ name: 'search_code' }],
      },
    ]);

    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        await options.onSubagentSessionReady('opencode-subagent-1');
        await options.onSubagentSessionReady('opencode-subagent-1');

        const parentExecutor = mocks.bindExecutor.mock.calls.find(
          ([sessionID]) => sessionID === 'opencode-session-1',
        )?.[1];
        const subagentExecutor = mocks.bindExecutor.mock.calls.find(
          ([sessionID]) => sessionID === 'opencode-subagent-1',
        )?.[1];
        if (!parentExecutor || !subagentExecutor) {
          throw new Error('Expected parent and subagent executors to bind.');
        }

        await parentExecutor({
          name: nativeToolNames.sendChatReply,
          args: { purpose: 'ack', message: 'I’ll inspect that.' },
        });
        for (const agent of ['advisor', 'judge']) {
          await expect(
            subagentExecutor({
              agent,
              name: nativeToolNames.manageTasks,
              args: { action: 'get_summary', taskId: 'task-1' },
            }),
          ).resolves.toEqual({
            id: 'task-1',
            taskRunStatus: 'running',
          });
          await expect(
            subagentExecutor({
              agent,
              name: nativeToolNames.integrationCall,
              args: {
                integrationId: 'github',
                toolName: 'search_code',
                arguments: { query: `Fast Agent ${agent}` },
              },
            }),
          ).resolves.toEqual({
            success: true,
            result: { matches: ['fast-agent.ts'] },
          });
          await expect(
            subagentExecutor({
              agent,
              name: nativeToolNames.sendChatReply,
              args: { purpose: 'closeout', message: 'leak' },
            }),
          ).resolves.toEqual({
            success: false,
            error: 'That tool is reserved for the Fast parent agent.',
          });
        }
        await expect(
          subagentExecutor({
            agent: 'general',
            name: nativeToolNames.manageTasks,
            args: { action: 'get_summary', taskId: 'task-1' },
          }),
        ).resolves.toEqual({
          success: false,
          error: 'That tool is reserved for the Fast parent agent.',
        });
        await parentExecutor({
          name: nativeToolNames.sendChatReply,
          args: {
            purpose: 'closeout',
            message: 'Subagent review completed.',
          },
        });
        return '';
      },
    );

    await expect(
      answerFastAgentQuestion({ ...baseParams, adapter }),
    ).resolves.toBe('Subagent review completed.');
    expect(mocks.inspectTasks).toHaveBeenCalledTimes(2);
    expect(mocks.inspectTasks).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      { action: 'get_summary', taskId: 'task-1' },
    );
    expect(mocks.callIntegration).toHaveBeenCalledTimes(2);
    expect(mocks.callIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      expect.arrayContaining([expect.objectContaining({ id: 'github' })]),
      {
        integrationId: 'github',
        toolName: 'search_code',
        args: expect.objectContaining({
          query: expect.stringMatching(/^Fast Agent/),
        }),
      },
    );
    expect(adapter.postReply).toHaveBeenCalledTimes(2);
    expect(mocks.bindExecutor).toHaveBeenCalledTimes(2);
  });

  it('rebuilds an invalidated OpenCode session from canonical compatibility history', async () => {
    const { FastAgentOpenCodeSessionManager } = await vi.importActual<
      typeof import('../fast-agent-opencode-session')
    >('../fast-agent-opencode-session');
    const manager = new FastAgentOpenCodeSessionManager();
    const prompts: string[] = [];
    mocks.runSession.mockImplementation((input) => manager.run(input));
    mocks.getSession
      .mockResolvedValueOnce({
        id: 'conversation-1',
        compatibilityMessages: [],
      })
      .mockResolvedValue({
        id: 'conversation-1',
        compatibilityMessages: [
          { role: 'user', content: 'Earlier question' },
          { role: 'assistant', content: 'Earlier answer' },
        ],
      });
    mocks.generateText.mockImplementation(async (params, session, options) => {
      prompts.push(params.prompt);
      session.id ??= `opencode-session-${prompts.length}`;
      await options.onSessionReady(session.id);
      await invokeTool(nativeToolNames.sendChatReply, {
        purpose: 'closeout',
        message: 'It coordinates incoming requests.',
      });
      return '';
    });

    await answerFastAgentQuestion({ ...baseParams, adapter: callbacks() });
    manager.invalidate('conversation-1');
    await answerFastAgentQuestion({ ...baseParams, adapter: callbacks() });

    expect(prompts[0]).not.toContain('Earlier answer');
    expect(prompts[1]).toContain('Earlier answer');
  });

  it('logs successful turns with model, duration, and native tool diagnostics', async () => {
    const consoleInfo = vi
      .spyOn(console, 'info')
      .mockImplementation(() => undefined);

    try {
      await answerFastAgentQuestion({ ...baseParams, adapter: callbacks() });

      expect(consoleInfo).toHaveBeenCalledWith(
        expect.stringContaining(
          '[Fast Agent] Turn finished. surface="slack" workspaceId="team-1" conversationId="100.1" messageId="100.2" canonicalConversationId="conversation-1" turnSource="human" modelRole="orchestration"',
        ),
      );
      expect(consoleInfo).toHaveBeenCalledWith(
        expect.stringContaining('resolvedModel="openrouter/openai/gpt-5.4"'),
      );
      expect(consoleInfo).toHaveBeenCalledWith(
        expect.stringContaining('outcome="success"'),
      );
      expect(consoleInfo).toHaveBeenCalledWith(
        expect.stringContaining('serviceDurationMs='),
      );
      expect(consoleInfo).toHaveBeenCalledWith(
        expect.stringContaining(
          'nativeToolCallCount=1 completedNativeToolCallCount=1',
        ),
      );
      expect(consoleInfo).toHaveBeenCalledWith(
        expect.stringContaining('nativeToolStats={"send_chat_reply":'),
      );
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it('records same-conversation serialization separately from inference', async () => {
    vi.useFakeTimers();
    const consoleInfo = vi
      .spyOn(console, 'info')
      .mockImplementation(() => undefined);
    mocks.runSession.mockImplementationOnce(
      async ({
        prompt,
        execute,
      }: {
        prompt: string;
        execute: (
          session: { id?: string },
          selectedPrompt: string,
        ) => Promise<unknown>;
      }) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return execute({ id: 'opencode-session-1' }, prompt);
      },
    );

    try {
      const resultPromise = answerFastAgentQuestion({
        ...baseParams,
        adapter: callbacks(),
      });
      await vi.advanceTimersByTimeAsync(50);
      await resultPromise;

      expect(consoleInfo).toHaveBeenCalledWith(
        expect.stringContaining('conversationQueueDurationMs=50'),
      );
      expect(consoleInfo).toHaveBeenCalledWith(
        expect.stringContaining('inferenceSetupDurationMs=0'),
      );
      expect(consoleInfo).toHaveBeenCalledWith(
        expect.stringContaining('inferenceDurationMs=0'),
      );
    } finally {
      consoleInfo.mockRestore();
      vi.useRealTimers();
    }
  });

  it('stops a cancelled turn without posting a stale error closeout', async () => {
    const controller = new AbortController();
    const lockLost = new Error('Fast conversation lock ownership was lost.');
    mocks.generateText.mockImplementationOnce(
      async (_params, _session, options) => {
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.signal.aborted).toBe(false);
        await options.onSessionReady('opencode-session-1');
        controller.abort(lockLost);
        expect(options.signal.aborted).toBe(true);
        expect(options.signal.reason).toBe(lockLost);
        await expect(
          invokeTool(nativeToolNames.sendChatReply, {
            purpose: 'closeout',
            message: 'This reply must not be posted.',
          }),
        ).resolves.toMatchObject({ success: false });
        throw lockLost;
      },
    );
    const adapter = callbacks();

    await expect(
      answerFastAgentQuestion({
        ...baseParams,
        adapter,
        signal: controller.signal,
      }),
    ).rejects.toBe(lockLost);

    expect(mocks.generateText).toHaveBeenCalledOnce();
    expect(adapter.postReply).not.toHaveBeenCalled();
    expect(mocks.invalidateSession).toHaveBeenCalledWith('conversation-1');
  });

  it('passes image data URLs to the Fast model as image-capable file input', async () => {
    await answerFastAgentQuestion({
      ...baseParams,
      images: ['data:image/png;base64,aGVsbG8=', 'not-an-image'],
      adapter: callbacks(),
    });

    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [
          {
            mime: 'image/png',
            url: 'data:image/png;base64,aGVsbG8=',
          },
        ],
        requiredInputModality: 'image',
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('posts final assistant text only as a defensive fallback', async () => {
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        return 'Fallback final text';
      },
    );
    const adapter = callbacks();

    await expect(
      answerFastAgentQuestion({ ...baseParams, adapter }),
    ).resolves.toBe('Fallback final text');
    expect(adapter.postReply).toHaveBeenCalledWith({
      purpose: 'closeout',
      message: 'Fallback final text',
    });
  });

  it('passes native integration arguments and results without text encoding', async () => {
    mocks.listIntegrations.mockResolvedValue([
      {
        id: 'github',
        name: 'GitHub',
        description: 'Read GitHub',
        tools: [
          {
            name: 'search_code',
            description: 'Search code',
            inputSchema: { type: 'object' },
          },
        ],
      },
    ]);
    const toolResults: unknown[] = [];
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        toolResults.push(
          await invokeTool(nativeToolNames.integrationCall, {
            integrationId: 'github',
            toolName: 'search_code',
            arguments: { query: 'fast agent', nested: { exact: true } },
          }),
        );
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'ack',
          message: 'I’ll check.',
        });
        toolResults.push(
          await invokeTool(nativeToolNames.integrationCall, {
            integrationId: 'github',
            toolName: 'search_code',
            arguments: { query: 'fast agent', nested: { exact: true } },
          }),
        );
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'closeout',
          message: 'I found it.',
        });
        return '';
      },
    );
    const adapter = callbacks();

    await answerFastAgentQuestion({ ...baseParams, adapter });

    expect(toolResults[0]).toEqual({
      success: false,
      error: expect.stringContaining('acknowledgement'),
    });
    expect(toolResults[1]).toEqual({
      success: true,
      result: { matches: ['fast-agent.ts'] },
    });
    expect(mocks.callIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'conversation-1' }),
      expect.any(Array),
      {
        integrationId: 'github',
        toolName: 'search_code',
        args: { query: 'fast agent', nested: { exact: true } },
      },
    );
  });

  it('posts and mirrors a model-authored kickoff before opening the launch gate', async () => {
    const order: string[] = [];
    const launchTask = vi.fn<LaunchFastAgentTask>(async ({ postKickoff }) => {
      await postKickoff({
        taskId: 'task-1',
        taskUrl: 'https://roomote.example/task-1',
      });
      order.push('queued');
      return {
        success: true,
        taskId: 'task-1',
        taskUrl: 'https://roomote.example/task-1',
      };
    });
    const adapter = callbacks({
      launchTask,
      postReply: vi.fn(async () => {
        order.push('kickoff');
      }),
    });
    mocks.appendVisibleMessages.mockImplementation(async () => {
      order.push('mirrored');
    });
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        const result = await invokeTool(nativeToolNames.launchTask, {
          prompt: 'Fix checkout.',
          environmentId: 'env-1',
          model: 'anthropic/claude-sonnet-5',
          kickoffMessage: 'I’m delegating the checkout fix.',
        });
        expect(result).toEqual(
          expect.objectContaining({ success: true, taskId: 'task-1' }),
        );
        return '';
      },
    );

    const result = await answerFastAgentQuestion({
      ...baseParams,
      question: 'Fix checkout.',
      adapter,
    });

    expect(result).toContain('I’m delegating the checkout fix.');
    expect(result).toContain('https://roomote.example/task-1');
    expect(order).toEqual(['kickoff', 'mirrored', 'queued']);
    expect(adapter.postReply).toHaveBeenCalledOnce();
    expect(adapter.postReply).toHaveBeenCalledWith(
      expect.objectContaining({ kickoff: true, purpose: 'progress' }),
    );
    expect(launchTask).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'anthropic/claude-sonnet-5' }),
    );
  });

  it('launches two tasks, keeps the turn open, messages a child, and posts a closeout', async () => {
    let taskNumber = 0;
    const order: string[] = [];
    const launchTask = vi.fn<LaunchFastAgentTask>(async ({ postKickoff }) => {
      taskNumber += 1;
      const taskId = `task-${taskNumber}`;
      await postKickoff({ taskId });
      order.push(`queued:${taskId}`);
      return { success: true, taskId };
    });
    const adapter = callbacks({
      launchTask,
      postReply: vi.fn(async ({ purpose, kickoff }) => {
        order.push(kickoff ? 'kickoff' : purpose);
      }),
    });
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        await expect(
          invokeTool(nativeToolNames.launchTask, {
            prompt: 'Fix checkout.',
            kickoffMessage: 'I’m delegating the checkout fix.',
          }),
        ).resolves.toMatchObject({ success: true, taskId: 'task-1' });
        await expect(
          invokeTool(nativeToolNames.launchTask, {
            prompt: 'Update checkout docs.',
            kickoffMessage: 'I’m delegating the checkout docs.',
          }),
        ).resolves.toMatchObject({ success: true, taskId: 'task-2' });
        await expect(
          invokeTool(nativeToolNames.sendTaskMessage, {
            taskId: 'task-1',
            message: 'Include the regression test.',
          }),
        ).resolves.toEqual({ success: true });
        await expect(
          invokeTool(nativeToolNames.sendChatReply, {
            purpose: 'closeout',
            message: 'Both tasks are underway.',
          }),
        ).resolves.toMatchObject({ success: true, closed: true });
        return '';
      },
    );

    await expect(
      answerFastAgentQuestion({ ...baseParams, adapter }),
    ).resolves.toBe('Both tasks are underway.');

    expect(launchTask).toHaveBeenCalledTimes(2);
    expect(adapter.postReply).toHaveBeenCalledTimes(3);
    expect(mocks.sendTaskMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      { taskId: 'task-1', message: 'Include the regression test.' },
    );
    expect(order).toEqual([
      'kickoff',
      'queued:task-1',
      'kickoff',
      'queued:task-2',
      'closeout',
    ]);
  });

  it('deduplicates an identical launch retry', async () => {
    const launchTask = vi.fn<LaunchFastAgentTask>(async ({ postKickoff }) => {
      await postKickoff({ taskId: 'task-1' });
      return { success: true, taskId: 'task-1' };
    });
    const adapter = callbacks({ launchTask });
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        const launch = {
          prompt: 'Fix checkout.',
          environmentId: 'env-1',
          kickoffMessage: 'I’m delegating the checkout fix.',
        };
        await expect(
          invokeTool(nativeToolNames.launchTask, launch),
        ).resolves.toMatchObject({ success: true });
        await expect(
          invokeTool(nativeToolNames.launchTask, launch),
        ).resolves.toEqual({
          success: false,
          error: 'The same task was already launched in this turn.',
        });
        return '';
      },
    );

    await answerFastAgentQuestion({ ...baseParams, adapter });

    expect(launchTask).toHaveBeenCalledOnce();
    expect(adapter.postReply).toHaveBeenCalledOnce();
  });

  it('allows a corrected launch after rejecting an unavailable model', async () => {
    const launchTask = vi.fn<LaunchFastAgentTask>(async () => ({
      success: true,
      taskId: 'task-corrected',
    }));
    const adapter = callbacks({ launchTask });
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        const rejected = await invokeTool(nativeToolNames.launchTask, {
          prompt: 'Fix checkout.',
          model: 'openrouter/example/not-enabled',
          kickoffMessage: 'I’m delegating the checkout fix.',
        });
        expect(rejected).toEqual({
          success: false,
          error: expect.stringContaining('not enabled for new tasks'),
        });
        const corrected = await invokeTool(nativeToolNames.launchTask, {
          prompt: 'Fix checkout.',
          model: 'anthropic/claude-sonnet-5',
          kickoffMessage: 'I’m delegating the checkout fix.',
        });
        expect(corrected).toEqual({
          success: true,
          taskId: 'task-corrected',
        });
        return '';
      },
    );

    await answerFastAgentQuestion({ ...baseParams, adapter });

    expect(launchTask).toHaveBeenCalledOnce();
    expect(launchTask).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'anthropic/claude-sonnet-5' }),
    );
  });

  it('delivers the kickoff when a surface launcher does not invoke the gate callback', async () => {
    const adapter = callbacks({
      launchTask: vi.fn(async () => ({
        success: true as const,
        taskId: 'task-discord',
        taskUrl: 'https://roomote.example/task-discord',
      })),
    });
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        await invokeTool(nativeToolNames.launchTask, {
          prompt: 'Fix checkout.',
          kickoffMessage: 'I’m delegating the Discord checkout fix.',
        });
        return '';
      },
    );

    await answerFastAgentQuestion({ ...baseParams, adapter });

    expect(adapter.postReply).toHaveBeenCalledWith(
      expect.objectContaining({ kickoff: true, purpose: 'progress' }),
    );
  });

  it('does not repost a kickoff or generic fallback for an idempotent surface replay', async () => {
    const adapter = callbacks({
      launchTask: vi.fn(async () => ({
        success: true as const,
        taskId: 'task-discord',
        taskUrl: 'https://roomote.example/task-discord',
        kickoffDelivered: true,
      })),
    });
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        await invokeTool(nativeToolNames.launchTask, {
          prompt: 'Fix checkout.',
          kickoffMessage: 'I’m delegating the Discord checkout fix.',
        });
        return '';
      },
    );

    await answerFastAgentQuestion({ ...baseParams, adapter });

    expect(adapter.postReply).not.toHaveBeenCalled();
  });

  it('uses native task tools after an acknowledgement', async () => {
    mocks.getActiveTasks.mockResolvedValue([
      { taskId: 'task-1', title: 'Checkout', status: 'running' },
    ]);
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'ack',
          message: 'I’ll update and stop it.',
        });
        await invokeTool(nativeToolNames.sendTaskMessage, {
          taskId: 'task-1',
          message: 'Include the failing test.',
        });
        await invokeTool(nativeToolNames.cancelTask, { taskId: 'task-1' });
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'closeout',
          message: 'The task was updated and canceled.',
        });
        return '';
      },
    );
    const adapter = callbacks();

    await answerFastAgentQuestion({ ...baseParams, adapter });

    expect(mocks.sendTaskMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      { taskId: 'task-1', message: 'Include the failing test.' },
    );
    expect(mocks.cancelTask).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      'task-1',
    );
  });

  it('uses deployment-wide task inspection without a conversation allow-list', async () => {
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        const result = await invokeTool(nativeToolNames.manageTasks, {
          action: 'get_summary',
          taskId: 'task-completed',
        });
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'closeout',
          message: 'The task completed.',
        });
        return JSON.stringify(result);
      },
    );

    await answerFastAgentQuestion({ ...baseParams, adapter: callbacks() });

    expect(mocks.inspectTasks).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      { action: 'get_summary', taskId: 'task-completed' },
    );
  });

  it('ignores a platform event through a native terminal tool', async () => {
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        await invokeTool(nativeToolNames.ignoreEvent, { reason: 'duplicate' });
        return '';
      },
    );
    const adapter = callbacks();

    await expect(
      answerFastAgentQuestion({
        ...baseParams,
        turnSource: 'platform_event',
        adapter,
      }),
    ).resolves.toBe('');
    expect(adapter.postReply).not.toHaveBeenCalled();
  });

  it('posts a closeout when a visibility-required event tries to ignore itself', async () => {
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        expect(
          await invokeTool(nativeToolNames.ignoreEvent, {
            reason: 'duplicate',
          }),
        ).toEqual({
          success: false,
          error: 'This platform event requires a user-visible closeout.',
        });
        return 'There is new pull request feedback to review.';
      },
    );
    const adapter = callbacks();

    await answerFastAgentQuestion({
      ...baseParams,
      turnSource: 'platform_event',
      platformEventVisibility: 'required',
      adapter,
    });

    expect(adapter.postReply).toHaveBeenCalledWith({
      purpose: 'closeout',
      message: 'There is new pull request feedback to review.',
    });
  });

  it('only permits a closeout for presentation-only platform events', async () => {
    mocks.getActiveTasks.mockResolvedValue([
      { taskId: 'task-1', title: 'Checkout', status: 'running' },
    ]);
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        expect(
          await invokeTool(nativeToolNames.sendTaskMessage, {
            taskId: 'task-1',
            message: 'Address the review feedback.',
          }),
        ).toEqual({
          success: false,
          error:
            'This platform event may only be presented to the user with a closeout.',
        });
        expect(
          await invokeTool(nativeToolNames.launchTask, {
            prompt: 'Fix the review feedback.',
            environmentId: null,
            kickoffMessage: 'I’ll fix it.',
          }),
        ).toEqual({
          success: false,
          error:
            'This platform event may only be presented to the user with a closeout.',
        });
        expect(
          await invokeTool(nativeToolNames.sendChatReply, {
            purpose: 'clarification',
            message: 'Should I fix this?',
          }),
        ).toEqual({
          success: false,
          error: 'This platform event must be presented with a closeout.',
        });
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'closeout',
          message: 'The review found one issue.',
        });
        return 'This final text must not post a duplicate closeout.';
      },
    );
    const adapter = callbacks();

    await answerFastAgentQuestion({
      ...baseParams,
      turnSource: 'platform_event',
      platformEventHandling: 'present_only',
      platformEventVisibility: 'required',
      adapter,
    });

    expect(adapter.launchTask).not.toHaveBeenCalled();
    expect(mocks.sendTaskMessage).not.toHaveBeenCalled();
    expect(adapter.postReply).toHaveBeenCalledOnce();
    expect(adapter.postReply).toHaveBeenCalledWith({
      purpose: 'closeout',
      message: 'The review found one issue.',
    });
  });

  it('retries eligible task startup through a native tool', async () => {
    const retryTaskStart = vi.fn().mockResolvedValue({
      success: true,
      runId: 42,
    });
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        await invokeTool(nativeToolNames.retryTaskStart, {});
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'closeout',
          message: 'Startup was retried.',
        });
        return '';
      },
    );
    const adapter = callbacks({ retryTaskStart });

    await answerFastAgentQuestion({
      ...baseParams,
      turnSource: 'platform_event',
      adapter,
    });

    expect(retryTaskStart).toHaveBeenCalledOnce();
  });

  it('posts an error closeout when the native OpenCode prompt fails', async () => {
    mocks.generateText.mockRejectedValue(new Error('OpenCode unavailable'));
    const adapter = callbacks();

    await expect(
      answerFastAgentQuestion({ ...baseParams, adapter }),
    ).resolves.toContain('error');
    expect(adapter.postReply).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'closeout' }),
    );
    expect(mocks.invalidateSession).toHaveBeenCalledWith('conversation-1');
  });

  it('retries a gateway block from a clean compatibility bootstrap', async () => {
    vi.useFakeTimers();
    try {
      mocks.getSession.mockResolvedValue({
        id: 'conversation-1',
        compatibilityMessages: [
          { role: 'user', content: 'Earlier question' },
          { role: 'assistant', content: 'Earlier answer' },
        ],
      });
      mocks.generateText
        .mockRejectedValueOnce(
          new Error('Forbidden: request was blocked by a gateway or proxy.'),
        )
        .mockImplementationOnce(async (_params, _session, options) => {
          await options.onSessionReady('replacement-session');
          await invokeTool(nativeToolNames.sendChatReply, {
            purpose: 'closeout',
            message: 'The retry recovered.',
          });
          return '';
        });
      const adapter = callbacks();

      const resultPromise = answerFastAgentQuestion({ ...baseParams, adapter });
      await vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toBe('The retry recovered.');
      expect(mocks.generateText).toHaveBeenCalledTimes(2);
      expect(mocks.generateText.mock.calls[0]?.[0].prompt).not.toContain(
        'Earlier answer',
      );
      expect(mocks.generateText.mock.calls[1]?.[0].prompt).toContain(
        'Earlier answer',
      );
      expect(adapter.postReply).toHaveBeenNthCalledWith(1, {
        purpose: 'progress',
        message:
          'Having trouble reaching the inference provider. Retrying in 1s (attempt 1/6).',
      });
      expect(mocks.invalidateSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not replay a failed turn after a native tool was invoked', async () => {
    mocks.generateText.mockImplementationOnce(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'ack',
          message: 'I’m checking.',
        });
        throw new Error('TypeError: fetch failed');
      },
    );
    const replaceReply = vi.fn().mockResolvedValue({ messageId: 'retry-1' });
    const adapter = callbacks({ replaceReply });

    await answerFastAgentQuestion({ ...baseParams, adapter });

    expect(mocks.generateText).toHaveBeenCalledOnce();
    expect(adapter.postReply).not.toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'progress',
        message: expect.stringContaining('Retrying in'),
      }),
    );
    expect(replaceReply).not.toHaveBeenCalled();
    expect(mocks.invalidateSession).toHaveBeenCalledWith('conversation-1');
  });

  it('uses the extended retry budget for provider timeouts', async () => {
    vi.useFakeTimers();
    try {
      mocks.generateText
        .mockRejectedValueOnce(new Error('Provider request timed out'))
        .mockImplementationOnce(async (_params, _session, options) => {
          await options.onSessionReady('opencode-session-1');
          await invokeTool(nativeToolNames.sendChatReply, {
            purpose: 'closeout',
            message: 'The retry recovered.',
          });
          return '';
        });
      const adapter = callbacks();

      const resultPromise = answerFastAgentQuestion({ ...baseParams, adapter });
      await vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toBe('The retry recovered.');
      expect(adapter.postReply).toHaveBeenNthCalledWith(1, {
        purpose: 'progress',
        message: expect.stringContaining('attempt 1/6'),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the OpenCode prompt deadline as the single retry budget', async () => {
    const timeout = new Error(
      'Timed out waiting for OpenCode output after 120000ms.',
    );
    timeout.name = 'NonTaskOpenCodePromptTimeoutError';
    mocks.generateText.mockImplementation(async (params, _session, options) => {
      options.onModelResolved?.('openrouter/openai/gpt-5.4');
      options.onPromptStarted?.();
      await params.onProviderRetry?.({
        attempt: 1,
        message: '429 Too Many Requests',
      });
      throw timeout;
    });
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      await answerFastAgentQuestion({ ...baseParams, adapter: callbacks() });

      expect(mocks.generateText).toHaveBeenCalledOnce();
      expect(mocks.invalidateSession).toHaveBeenCalledWith('conversation-1');
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          '[Fast Agent] Turn finished. surface="slack" workspaceId="team-1" conversationId="100.1" messageId="100.2" canonicalConversationId="conversation-1" turnSource="human" modelRole="orchestration"',
        ),
      );
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('resolvedModel="openrouter/openai/gpt-5.4"'),
      );
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('outcome="failure" reason="timeout"'),
      );
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('openCodeProviderRetryEventCount=1'),
      );
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('lastOpenCodeProviderRetryAttempt=1'),
      );
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('roomoteInferenceRetryCount=0'),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('identifies a native tool still running when the prompt times out', async () => {
    const timeout = new Error(
      'Timed out waiting for OpenCode output after 120000ms.',
    );
    timeout.name = 'NonTaskOpenCodePromptTimeoutError';
    let releaseTool: (() => void) | undefined;
    const toolResult = new Promise<Record<string, unknown>>((resolve) => {
      releaseTool = () => resolve({ success: true });
    });
    mocks.inspectTasks.mockReturnValueOnce(toolResult);
    let pendingTool: Promise<unknown> | undefined;
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        options.onPromptStarted?.();
        pendingTool = invokeTool(nativeToolNames.manageTasks, {
          action: 'get_summary',
          taskId: 'task-completed',
        });
        await Promise.resolve();
        throw timeout;
      },
    );
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      await answerFastAgentQuestion({ ...baseParams, adapter: callbacks() });

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('activeNativeToolCounts={"manage_tasks":1}'),
      );
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          'nativeToolCallCount=1 completedNativeToolCallCount=0',
        ),
      );
    } finally {
      releaseTool?.();
      await pendingTool;
      consoleError.mockRestore();
    }
  });

  it('retries a transient native prompt failure with a visible notice', async () => {
    vi.useFakeTimers();
    try {
      mocks.generateText
        .mockRejectedValueOnce(new Error('TypeError: fetch failed'))
        .mockImplementationOnce(async (_params, _session, options) => {
          await options.onSessionReady('opencode-session-1');
          await invokeTool(nativeToolNames.sendChatReply, {
            purpose: 'closeout',
            message: 'It coordinates incoming requests.',
          });
          return '';
        });
      const adapter = callbacks();

      const resultPromise = answerFastAgentQuestion({ ...baseParams, adapter });
      await vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toBe(
        'It coordinates incoming requests.',
      );
      expect(mocks.generateText).toHaveBeenCalledTimes(2);
      expect(adapter.postReply).toHaveBeenNthCalledWith(1, {
        purpose: 'progress',
        message: expect.stringContaining('Retrying in 1s (attempt 1/6)'),
      });
      expect(adapter.postReply).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ purpose: 'closeout' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a clean-session retry so a stalled provider cannot lock the conversation forever', async () => {
    vi.useFakeTimers();
    try {
      const retryTimeout = new Error(
        'Timed out waiting for OpenCode output after 300000ms.',
      );
      retryTimeout.name = 'NonTaskOpenCodePromptTimeoutError';
      mocks.generateText
        .mockRejectedValueOnce(new Error('TypeError: fetch failed'))
        .mockRejectedValueOnce(retryTimeout);
      const adapter = callbacks();

      const resultPromise = answerFastAgentQuestion({ ...baseParams, adapter });
      await vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toBe(
        'The inference provider did not respond after retrying. Any delegated tasks can keep running; please try again in a moment.',
      );
      expect(mocks.generateText).toHaveBeenCalledTimes(2);
      expect(mocks.generateText.mock.calls[0]?.[0]).toMatchObject({
        timeoutMs: null,
      });
      expect(mocks.generateText.mock.calls[1]?.[0]).toMatchObject({
        timeoutMs: 300_000,
      });
      expect(adapter.postReply).toHaveBeenLastCalledWith({
        purpose: 'closeout',
        message:
          'The inference provider did not respond after retrying. Any delegated tasks can keep running; please try again in a moment.',
      });
      expect(mocks.invalidateSession).toHaveBeenCalledWith('conversation-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off longer and reports a provider 429 before retrying', async () => {
    vi.useFakeTimers();
    try {
      mocks.generateText
        .mockRejectedValueOnce(
          new Error('OpenCode structured prompt failed: 429 Too Many Requests'),
        )
        .mockImplementationOnce(async (_params, _session, options) => {
          await options.onSessionReady('opencode-session-1');
          await invokeTool(nativeToolNames.sendChatReply, {
            purpose: 'closeout',
            message: 'It coordinates incoming requests.',
          });
          return '';
        });
      const adapter = callbacks();

      const resultPromise = answerFastAgentQuestion({ ...baseParams, adapter });
      await vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toBe(
        'It coordinates incoming requests.',
      );
      expect(adapter.postReply).toHaveBeenNthCalledWith(1, {
        purpose: 'progress',
        message:
          'The inference provider is rate limiting requests. Retrying in 5s (attempt 1/3).',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors provider Retry-After before retrying a 429', async () => {
    vi.useFakeTimers();
    try {
      const rateLimitError = new Error('429 Too Many Requests') as Error & {
        providerError: unknown;
      };
      rateLimitError.providerError = {
        data: { responseHeaders: { 'retry-after': '12' } },
      };
      mocks.generateText
        .mockRejectedValueOnce(rateLimitError)
        .mockImplementationOnce(async (_params, _session, options) => {
          await options.onSessionReady('opencode-session-1');
          await invokeTool(nativeToolNames.sendChatReply, {
            purpose: 'closeout',
            message: 'It coordinates incoming requests.',
          });
          return '';
        });
      const adapter = callbacks();

      const resultPromise = answerFastAgentQuestion({ ...baseParams, adapter });
      await vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toBe(
        'It coordinates incoming requests.',
      );
      expect(adapter.postReply).toHaveBeenNthCalledWith(1, {
        purpose: 'progress',
        message:
          'The inference provider is rate limiting requests. Retrying in 12s (attempt 1/3).',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports OpenCode internal provider retries while the prompt is pending', async () => {
    mocks.generateText.mockImplementationOnce(
      async (params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        options.onPromptStarted?.();
        await params.onProviderRetry?.({
          attempt: 1,
          message: '429 Too Many Requests',
        });
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'closeout',
          message: 'It coordinates incoming requests.',
        });
        return '';
      },
    );
    const adapter = callbacks();

    await expect(
      answerFastAgentQuestion({ ...baseParams, adapter }),
    ).resolves.toBe('It coordinates incoming requests.');
    expect(mocks.generateText.mock.calls[0]?.[0]).toMatchObject({
      maxProviderRetryAttempts: 3,
    });
    expect(adapter.postReply).toHaveBeenNthCalledWith(1, {
      purpose: 'progress',
      message:
        'The inference provider is rate limiting requests. Retrying automatically…',
    });
  });

  it('bounds an initial prompt after OpenCode enters provider recovery', async () => {
    vi.useFakeTimers();
    try {
      mocks.generateText.mockImplementationOnce(
        async (params, _session, options) => {
          await options.onSessionReady('opencode-session-1');
          options.onPromptStarted?.();
          await params.onProviderRetry?.({
            attempt: 1,
            message: 'Provider temporarily unavailable',
          });
          await new Promise((resolve) => setTimeout(resolve, 240_000));
          await params.onProviderRetry?.({
            attempt: 2,
            message: 'Provider still unavailable',
          });
          await new Promise((_resolve, reject) => {
            if (options.signal.aborted) {
              reject(options.signal.reason);
              return;
            }
            options.signal.addEventListener(
              'abort',
              () => reject(options.signal.reason),
              { once: true },
            );
          });
          return '';
        },
      );
      const adapter = callbacks();

      const resultPromise = answerFastAgentQuestion({ ...baseParams, adapter });
      await vi.advanceTimersByTimeAsync(300_000);

      await expect(resultPromise).resolves.toBe(
        'The inference provider did not respond after retrying. Any delegated tasks can keep running; please try again in a moment.',
      );
      expect(mocks.generateText).toHaveBeenCalledOnce();
      expect(mocks.invalidateSession).toHaveBeenCalledWith('conversation-1');
      expect(adapter.postReply).toHaveBeenLastCalledWith({
        purpose: 'closeout',
        message:
          'The inference provider did not respond after retrying. Any delegated tasks can keep running; please try again in a moment.',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the classified provider failure after retries are exhausted', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      mocks.generateText.mockRejectedValue(
        new Error('TypeError: fetch failed'),
      );
      const adapter = callbacks();
      const startedAt = Date.now();

      const resultPromise = answerFastAgentQuestion({ ...baseParams, adapter });
      await vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toBe(
        'Could not reach the inference provider after retrying. Please try again in a moment.',
      );
      expect(mocks.generateText).toHaveBeenCalledTimes(7);
      expect(Date.now() - startedAt).toBe(67_100);
      expect(adapter.postReply).toHaveBeenNthCalledWith(6, {
        purpose: 'progress',
        message: expect.stringContaining('Retrying in 33s (attempt 6/6)'),
      });
      expect(adapter.postReply).toHaveBeenLastCalledWith({
        purpose: 'closeout',
        message:
          'Could not reach the inference provider after retrying. Please try again in a moment.',
      });
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it('explains content filter failures without suggesting a retry', async () => {
    mocks.generateText.mockRejectedValue(
      new Error(
        "ContentFilterError: The response was blocked by the provider's content filter",
      ),
    );
    const adapter = callbacks();
    const message =
      'The inference provider blocked this response with its content filter, so retrying will not help. Try rephrasing the request or asking in a new thread.';

    await expect(
      answerFastAgentQuestion({ ...baseParams, adapter }),
    ).resolves.toBe(message);
    expect(mocks.generateText).toHaveBeenCalledOnce();
    expect(adapter.postReply).toHaveBeenCalledWith({
      purpose: 'closeout',
      message,
    });
  });

  it('does not surface a duplicate retry notice for repeated failures', async () => {
    vi.useFakeTimers();
    try {
      mocks.generateText
        .mockRejectedValueOnce(new Error('TypeError: fetch failed'))
        .mockRejectedValueOnce(new Error('TypeError: fetch failed'))
        .mockImplementationOnce(async (_params, _session, options) => {
          await options.onSessionReady('opencode-session-1');
          await invokeTool(nativeToolNames.sendChatReply, {
            purpose: 'closeout',
            message: 'It coordinates incoming requests.',
          });
          return '';
        });
      const adapter = callbacks();

      const resultPromise = answerFastAgentQuestion({ ...baseParams, adapter });
      await vi.runAllTimersAsync();
      await resultPromise;

      const progressMessages = vi
        .mocked(adapter.postReply)
        .mock.calls.filter(([reply]) => reply.purpose === 'progress');
      expect(progressMessages).toHaveLength(2);
      expect(progressMessages[0]?.[0]?.message).toContain('attempt 1/6');
      expect(progressMessages[1]?.[0]?.message).toContain('attempt 2/6');
    } finally {
      vi.useRealTimers();
    }
  });

  it('edits one retry notice through recovery and the final reply', async () => {
    vi.useFakeTimers();
    try {
      mocks.generateText
        .mockRejectedValueOnce(new Error('TypeError: fetch failed'))
        .mockRejectedValueOnce(new Error('TypeError: fetch failed'))
        .mockImplementationOnce(async (_params, _session, options) => {
          await options.onSessionReady('opencode-session-1');
          await invokeTool(nativeToolNames.sendChatReply, {
            purpose: 'closeout',
            message: 'Connection restored.',
          });
          return '';
        });
      const postReply = vi.fn().mockResolvedValue({ messageId: 'retry-1' });
      const replaceReply = vi.fn().mockResolvedValue({ messageId: 'retry-1' });
      const adapter = callbacks({ postReply, replaceReply });

      const resultPromise = answerFastAgentQuestion({ ...baseParams, adapter });
      await vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toBe('Connection restored.');
      expect(postReply).toHaveBeenCalledOnce();
      expect(postReply).toHaveBeenCalledWith(
        expect.objectContaining({
          purpose: 'progress',
          message: expect.stringContaining('attempt 1/6'),
        }),
      );
      expect(replaceReply).toHaveBeenNthCalledWith(
        1,
        { messageId: 'retry-1' },
        expect.objectContaining({
          purpose: 'progress',
          message: expect.stringContaining('attempt 2/6'),
        }),
      );
      expect(replaceReply).toHaveBeenLastCalledWith(
        { messageId: 'retry-1' },
        { purpose: 'closeout', message: 'Connection restored.' },
      );
      expect(mocks.appendVisibleMessages).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'assistant',
              content: [{ type: 'text', text: 'Connection restored.' }],
            }),
          ]),
        }),
      );
      expect(
        JSON.stringify(mocks.appendVisibleMessages.mock.lastCall),
      ).not.toContain('Retrying in');
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces the retry notice with the terminal provider failure', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      mocks.generateText.mockRejectedValue(
        new Error('TypeError: fetch failed'),
      );
      const postReply = vi.fn().mockResolvedValue({ messageId: 'retry-1' });
      const replaceReply = vi.fn().mockResolvedValue({ messageId: 'retry-1' });
      const adapter = callbacks({ postReply, replaceReply });

      const resultPromise = answerFastAgentQuestion({ ...baseParams, adapter });
      await vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toContain(
        'Could not reach the inference provider',
      );
      expect(postReply).toHaveBeenCalledOnce();
      expect(replaceReply).toHaveBeenCalledTimes(6);
      expect(replaceReply).toHaveBeenLastCalledWith(
        { messageId: 'retry-1' },
        expect.objectContaining({
          purpose: 'closeout',
          message: expect.stringContaining(
            'Could not reach the inference provider',
          ),
        }),
      );
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it('posts the real reply when replacing the retry notice fails', async () => {
    vi.useFakeTimers();
    const consoleWarn = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      mocks.generateText
        .mockRejectedValueOnce(new Error('TypeError: fetch failed'))
        .mockImplementationOnce(async (_params, _session, options) => {
          await options.onSessionReady('opencode-session-1');
          await invokeTool(nativeToolNames.sendChatReply, {
            purpose: 'closeout',
            message: 'Connection restored.',
          });
          return '';
        });
      const postReply = vi
        .fn()
        .mockResolvedValueOnce({ messageId: 'retry-1' })
        .mockResolvedValueOnce({ messageId: 'reply-1' });
      const adapter = callbacks({
        postReply,
        replaceReply: vi.fn().mockRejectedValue(new Error('edit failed')),
      });

      const resultPromise = answerFastAgentQuestion({ ...baseParams, adapter });
      await vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toBe('Connection restored.');
      expect(postReply).toHaveBeenCalledTimes(2);
      expect(postReply).toHaveBeenLastCalledWith({
        purpose: 'closeout',
        message: 'Connection restored.',
      });
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to replace inference retry notice'),
      );
    } finally {
      consoleWarn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('retries platform events without posting retry notices', async () => {
    vi.useFakeTimers();
    try {
      mocks.generateText
        .mockRejectedValueOnce(new Error('TypeError: fetch failed'))
        .mockImplementationOnce(async (_params, _session, options) => {
          await options.onSessionReady('opencode-session-1');
          await invokeTool(nativeToolNames.sendChatReply, {
            purpose: 'closeout',
            message: 'Startup recovered.',
          });
          return '';
        });
      const adapter = callbacks();

      const resultPromise = answerFastAgentQuestion({
        ...baseParams,
        turnSource: 'platform_event',
        adapter,
      });
      await vi.runAllTimersAsync();
      await resultPromise;

      expect(mocks.generateText).toHaveBeenCalledTimes(2);
      expect(adapter.postReply).toHaveBeenCalledOnce();
      expect(adapter.postReply).toHaveBeenCalledWith(
        expect.objectContaining({ purpose: 'closeout' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('rethrows native prompt failures for platform event retry', async () => {
    mocks.generateText.mockRejectedValue(new Error('OpenCode unavailable'));

    await expect(
      answerFastAgentQuestion({
        ...baseParams,
        turnSource: 'platform_event',
        adapter: callbacks(),
      }),
    ).rejects.toThrow('OpenCode unavailable');
  });
});
