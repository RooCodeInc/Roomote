const mocks = vi.hoisted(() => ({
  appendVisibleMessages: vi.fn(),
  getActiveTasks: vi.fn(),
  getSession: vi.fn(),
  getEnvironments: vi.fn(),
  generateText: vi.fn(),
  listIntegrations: vi.fn(),
  callIntegration: vi.fn(),
  sendTaskMessage: vi.fn(),
  cancelTask: vi.fn(),
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
      ignoreEvent: 'ignore_event',
      integrationCall: 'integration_call',
      launchTask: 'launch_task',
      retryTaskStart: 'retry_task_start',
      sendChatReaction: 'send_chat_reaction',
      sendChatReply: 'send_chat_reply',
      sendTaskMessage: 'send_task_message',
    }) as const,
);

vi.mock('../fast-agent-session', () => ({
  appendFastAgentVisibleMessages: mocks.appendVisibleMessages,
  getActiveFastAgentTasks: mocks.getActiveTasks,
  getOrCreateFastAgentSession: mocks.getSession,
}));

vi.mock('../../router', () => ({
  getAvailableEnvironments: mocks.getEnvironments,
}));

vi.mock('../../non-task-provider-usage', () => ({
  NON_TASK_INFERENCE_SURFACES: {
    fastAgentQuestionAnswering: 'fast_agent_question_answering',
  },
  generateTrackedNonTaskTextInOpenCodeSession: mocks.generateText,
}));

vi.mock('../fast-agent-opencode-session', () => ({
  fastAgentOpenCodeSessionManager: {
    run: ({
      prompt,
      execute,
    }: {
      prompt: string;
      execute: (
        session: { id: string },
        selectedPrompt: string,
      ) => Promise<unknown>;
    }) => execute({ id: 'opencode-session-1' }, prompt),
  },
}));

vi.mock('../fast-agent-native-tool-bridge', () => ({
  FAST_AGENT_NATIVE_TOOL_NAMES: nativeToolNames,
  FAST_AGENT_NATIVE_TOOL_FILTER: {
    '*': false,
    send_chat_reply: true,
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
    mocks.listIntegrations.mockResolvedValue([]);
    mocks.callIntegration.mockResolvedValue({ matches: ['fast-agent.ts'] });
    mocks.sendTaskMessage.mockResolvedValue({ success: true });
    mocks.cancelTask.mockResolvedValue({ success: true });
    mocks.getUserIdentity.mockResolvedValue({
      displayName: 'Matt Rubens',
      githubLogin: 'mrubens',
    });
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
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
        modelRole: 'primary',
        prompt: expect.stringContaining('What does this service do?'),
      }),
      { id: 'opencode-session-1' },
      expect.objectContaining({
        directory: '/tmp/fast-native-tools',
        tools: expect.objectContaining({
          send_chat_reply: true,
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
          kickoffMessage: 'I’m delegating the checkout fix.',
        });
        expect(result).toEqual(
          expect.objectContaining({ success: true, taskId: 'task-1' }),
        );
        return 'This text is not posted after the kickoff.';
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
      expect.objectContaining({ kickoff: true, purpose: 'closeout' }),
    );
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
  });

  it('does not claim a retry after a transient native prompt failure', async () => {
    mocks.generateText.mockRejectedValue(new Error('fetch failed'));
    const adapter = callbacks();

    await expect(
      answerFastAgentQuestion({ ...baseParams, adapter }),
    ).resolves.toBe(
      'Fast mode could not reach the model. Please try again in a moment.',
    );
    expect(mocks.generateText).toHaveBeenCalledOnce();
    expect(adapter.postReply).toHaveBeenCalledWith({
      purpose: 'closeout',
      message:
        'Fast mode could not reach the model. Please try again in a moment.',
    });
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
