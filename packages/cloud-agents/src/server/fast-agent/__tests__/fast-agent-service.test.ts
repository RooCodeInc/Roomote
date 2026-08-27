const mocks = vi.hoisted(() => ({
  appendVisibleMessages: vi.fn(),
  getActiveTasks: vi.fn(),
  getSession: vi.fn(),
  getNativeRuntime: vi.fn(),
  setOpenCodeSession: vi.fn(),
  upsertMessage: vi.fn(),
  getEnvironments: vi.fn(),
  getTaskModelOptions: vi.fn(),
  appendMemory: vi.fn(),
  isBrainProviderConfigured: vi.fn(),
  generateText: vi.fn(),
  classifyInferenceError: vi.fn(),
  invalidateSession: vi.fn(),
  runSession: vi.fn(),
  listIntegrations: vi.fn(),
  callIntegration: vi.fn(),
  sendTaskMessage: vi.fn(),
  cancelTask: vi.fn(),
  getUserIdentity: vi.fn(),
  bindExecutor: vi.fn(),
  bindMcpExecutor: vi.fn(),
  revokeMcpCapabilities: vi.fn(),
  nativeExecutor: undefined as
    | ((call: {
        agent?: string;
        name: string;
        args: Record<string, unknown>;
      }) => Promise<unknown>)
    | undefined,
  mcpExecutor: undefined as
    | ((call: {
        integrationId: string;
        toolName: string;
        args: Record<string, unknown>;
      }) => Promise<unknown>)
    | undefined,
  mcpCapabilityAvailable: false,
}));

const nativeToolNames = vi.hoisted(
  () =>
    ({
      cancelTask: 'cancel_task',
      ignoreEvent: 'ignore_event',
      launchTask: 'launch_task',
      retryTaskStart: 'retry_task_start',
      saveMemory: 'save_memory',
      sendChatReaction: 'send_chat_reaction',
      sendChatReply: 'send_chat_reply',
      sendTaskMessage: 'send_task_message',
      listSkills: 'list_skills',
      loadSkill: 'load_skill',
      showWidget: 'show_widget',
      spillGrep: 'spill_grep',
      spillRead: 'spill_read',
    }) as const,
);

const fastAgentSessionPermissions = vi.hoisted(() => [
  { permission: 'task', pattern: '*', action: 'allow' },
]);

vi.mock('../fast-agent-session', () => ({
  appendFastAgentVisibleMessages: mocks.appendVisibleMessages,
  getActiveFastAgentTasks: mocks.getActiveTasks,
  getOrCreateFastAgentSession: mocks.getSession,
  setFastAgentOpenCodeSession: mocks.setOpenCodeSession,
  upsertFastAgentMessage: mocks.upsertMessage,
}));

vi.mock('../../router', () => ({
  getAvailableEnvironments: mocks.getEnvironments,
}));

vi.mock('@roomote/db/server', () => ({
  getDeploymentTaskModelOptions: mocks.getTaskModelOptions,
  appendFastAgentMemory: mocks.appendMemory,
  isBrainProviderConfigured: mocks.isBrainProviderConfigured,
  db: {},
  getSessionForFastConversation: vi.fn().mockResolvedValue(null),
  getSessionForTask: vi.fn().mockResolvedValue(null),
  touchSessionActivity: vi.fn().mockResolvedValue(undefined),
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
  isNonTaskOpenCodeSessionValidationError: (error: unknown) =>
    error instanceof Error &&
    error.name === 'NonTaskOpenCodeSessionValidationError',
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
  getFastAgentNativeToolRuntime: mocks.getNativeRuntime,
  bindFastAgentNativeToolExecutor: mocks.bindExecutor,
  createFastAgentSpillTurnBudget: () => ({ calls: 0, outputBytes: 0 }),
  bindFastAgentMcpToolExecutor: mocks.bindMcpExecutor,
  revokeFastAgentMcpCapabilitiesForConversation: mocks.revokeMcpCapabilities,
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

import {
  ACP_ENVELOPE_EVENT_TYPES,
  ACP_UI_TOOL_OUTPUT_MAX_CHARS,
  ALL_REPOSITORIES,
} from '@roomote/types';

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

async function invokeTool(
  name: string,
  args: Record<string, unknown>,
  agent?: string,
) {
  if (!mocks.nativeExecutor) throw new Error('Native executor is not bound.');
  return mocks.nativeExecutor({ name, args, ...(agent ? { agent } : {}) });
}

async function invokeMcpTool(
  integrationId: string,
  toolName: string,
  args: Record<string, unknown>,
) {
  if (!mocks.mcpExecutor) throw new Error('MCP executor is not bound.');
  return mocks.mcpExecutor({ integrationId, toolName, args });
}

describe('answerFastAgentQuestion native OpenCode tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nativeExecutor = undefined;
    mocks.mcpExecutor = undefined;
    mocks.mcpCapabilityAvailable = false;
    mocks.getNativeRuntime.mockImplementation(async () => {
      mocks.mcpCapabilityAvailable = true;
      return {
        directory: '/tmp/fast-native-tools',
        mcpCapability: 'mcp-capability-1',
        env: {
          ROOMOTE_FAST_TOOL_BRIDGE_URL: 'http://127.0.0.1:4321/tool',
          ROOMOTE_FAST_TOOL_BRIDGE_TOKEN: 'test-token',
        },
      };
    });
    mocks.runSession.mockImplementation(
      ({
        prompt,
        execute,
      }: {
        prompt: string;
        execute: (
          session: { id?: string },
          selectedPrompt: string,
          context: { path: string; validateSession: boolean },
        ) => Promise<unknown>;
      }) =>
        execute({ id: 'opencode-session-1' }, prompt, {
          path: 'warm',
          validateSession: false,
        }),
    );
    mocks.bindExecutor.mockImplementation(
      (_sessionID, _conversationId, executor) => {
        mocks.nativeExecutor = executor;
        return () => {
          mocks.nativeExecutor = undefined;
        };
      },
    );
    mocks.bindMcpExecutor.mockImplementation((_capability, executor) => {
      if (!mocks.mcpCapabilityAvailable) {
        throw new Error('The Fast MCP capability is unavailable.');
      }
      mocks.mcpExecutor = executor;
      return () => {
        mocks.mcpExecutor = undefined;
        mocks.mcpCapabilityAvailable = false;
      };
    });
    mocks.revokeMcpCapabilities.mockImplementation(() => {
      mocks.mcpCapabilityAvailable = false;
    });
    mocks.getSession.mockResolvedValue({
      id: 'conversation-1',
      compatibilityMessages: [],
      openCodeSessionId: null,
    });
    mocks.setOpenCodeSession.mockResolvedValue(undefined);
    mocks.upsertMessage.mockResolvedValue(undefined);
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
    expect(mocks.upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'conversation-1',
        message: expect.objectContaining({
          eventId: '100.2:user',
          turnSeq: 0,
          eventType: 'roomote_runtime.user_prompt',
        }),
      }),
    );
    expect(mocks.upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          eventId: '100.2:tool:0',
          eventType: 'roomote_runtime.tool_call',
          metadata: { visibleInTranscript: true },
          payload: expect.objectContaining({
            toolCallId: '100.2:tool:0',
            toolName: 'send_chat_reply',
          }),
        }),
      }),
    );
    expect(mocks.upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          eventId: '100.2:assistant:0',
          eventType: 'roomote_runtime.assistant_message',
          nativeSessionId: 'opencode-session-1',
        }),
      }),
    );
    expect(mocks.upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          eventId: '100.2:tool:0',
          eventType: 'roomote_runtime.tool_result',
          payload: expect.objectContaining({
            toolCallId: '100.2:tool:0',
            status: 'completed',
          }),
        }),
      }),
    );
    const toolWrites = mocks.upsertMessage.mock.calls
      .map(([input]) => input.message)
      .filter((message) => message.eventId === '100.2:tool:0');
    expect(toolWrites.map((message) => message.eventType)).toEqual([
      'roomote_runtime.tool_call',
      'roomote_runtime.tool_result',
    ]);
    expect(new Set(toolWrites.map((message) => message.turnSeq)).size).toBe(1);
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
    expect(mocks.setOpenCodeSession).toHaveBeenCalledWith({
      sessionId: 'conversation-1',
      openCodeSessionId: 'opencode-session-1',
    });
  });

  it('sanitizes and persists Fast widgets while posting only the Slack fallback', async () => {
    const adapter = callbacks();
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        const result = await invokeTool(nativeToolNames.showWidget, {
          html: '<p onclick="alert(1)">Safe</p><script>alert(2)</script>',
          title: 'Status',
          textFallback: 'Status is available in the web transcript.',
        });
        expect(result).toMatchObject({
          success: true,
          shown: true,
          html: '<p>Safe</p>',
        });
        return '';
      },
    );

    await expect(
      answerFastAgentQuestion({ ...baseParams, adapter }),
    ).resolves.toBe('Status is available in the web transcript.');

    expect(adapter.postReply).toHaveBeenCalledTimes(1);
    expect(adapter.postReply).toHaveBeenCalledWith({
      purpose: 'progress',
      message: 'Status is available in the web transcript.',
    });
    const toolResult = mocks.upsertMessage.mock.calls
      .map(([input]) => input.message)
      .find(
        (message) =>
          message.eventId === '100.2:tool:0' &&
          message.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolResult,
      );
    expect(toolResult).toMatchObject({
      metadata: { visibleInTranscript: true, truncated: false },
      payload: {
        toolName: 'show_widget',
        isMcp: false,
        isRoomoteNativeTool: true,
        status: 'completed',
      },
    });
    expect(JSON.parse(toolResult.payload.output)).toMatchObject({
      success: true,
      shown: true,
      html: '<p>Safe</p>',
      textFallback: 'Status is available in the web transcript.',
    });
  });

  it('rejects a compact widget that exceeds the limit when pretty-serialized', async () => {
    const adapter = callbacks();
    const textFallback = 'This must not be posted.';
    const emptyResult = {
      success: true,
      shown: true,
      title: null,
      html: '',
      css: null,
      height: 320,
      textFallback,
    };
    const html = 'x'.repeat(
      ACP_UI_TOOL_OUTPUT_MAX_CHARS - JSON.stringify(emptyResult).length,
    );
    const compactResult = { ...emptyResult, html };
    expect(JSON.stringify(compactResult)).toHaveLength(
      ACP_UI_TOOL_OUTPUT_MAX_CHARS,
    );
    expect(JSON.stringify(compactResult, null, 2).length).toBeGreaterThan(
      ACP_UI_TOOL_OUTPUT_MAX_CHARS,
    );
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        const result = await invokeTool(nativeToolNames.showWidget, {
          html,
          textFallback,
        });
        expect(result).toMatchObject({
          success: false,
          error: expect.stringContaining('Fast transcript limit'),
        });
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'closeout',
          message: 'The widget was too large to display.',
        });
        return '';
      },
    );

    await answerFastAgentQuestion({ ...baseParams, adapter });

    expect(adapter.postReply).toHaveBeenCalledTimes(1);
    expect(adapter.postReply).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'This must not be posted.' }),
    );
    const widgetResult = mocks.upsertMessage.mock.calls
      .map(([input]) => input.message)
      .find(
        (message) =>
          message.eventId === '100.2:tool:0' &&
          message.eventType === ACP_ENVELOPE_EVENT_TYPES.ToolResult,
      );
    expect(widgetResult).toMatchObject({
      metadata: { visibleInTranscript: true, truncated: false },
      payload: { status: 'failed', toolName: 'show_widget' },
    });
    expect(JSON.parse(widgetResult.payload.output)).toMatchObject({
      success: false,
      error: expect.stringContaining('Fast transcript limit'),
    });
  });

  it('saves a conversation memory through the outbox', async () => {
    mocks.isBrainProviderConfigured.mockResolvedValue(true);
    mocks.appendMemory.mockResolvedValue({ saved: true });
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        options.onModelResolved?.('openrouter/openai/gpt-5.4');
        await options.onSessionReady('opencode-session-1');
        options.onPromptStarted?.();
        const result = await invokeTool(nativeToolNames.saveMemory, {
          memory: 'Prefers deploys on Fridays',
        });
        expect(result).toMatchObject({ success: true, saved: true });
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'closeout',
          message: 'Remembered.',
        });
        return '';
      },
    );

    await answerFastAgentQuestion({ ...baseParams, adapter: callbacks() });

    expect(mocks.appendMemory).toHaveBeenCalledWith(
      expect.anything(),
      'conversation-1',
      'Prefers deploys on Fridays',
    );
  });

  it('refuses a memory save when no Brain is configured', async () => {
    mocks.isBrainProviderConfigured.mockResolvedValue(false);
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        options.onModelResolved?.('openrouter/openai/gpt-5.4');
        await options.onSessionReady('opencode-session-1');
        options.onPromptStarted?.();
        const result = await invokeTool(nativeToolNames.saveMemory, {
          memory: 'Prefers deploys on Fridays',
        });
        expect(result).toMatchObject({
          success: false,
          error: 'This deployment has no Brain configured.',
        });
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'closeout',
          message: 'No memory available here.',
        });
        return '';
      },
    );

    await answerFastAgentQuestion({ ...baseParams, adapter: callbacks() });

    expect(mocks.appendMemory).not.toHaveBeenCalled();
  });

  it('surfaces a full conversation memory as a tool failure', async () => {
    mocks.isBrainProviderConfigured.mockResolvedValue(true);
    mocks.appendMemory.mockResolvedValue({
      saved: false,
      reason: 'memory_full',
    });
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        options.onModelResolved?.('openrouter/openai/gpt-5.4');
        await options.onSessionReady('opencode-session-1');
        options.onPromptStarted?.();
        const result = await invokeTool(nativeToolNames.saveMemory, {
          memory: 'One fact too many',
        });
        expect(result).toMatchObject({
          success: false,
          error: expect.stringContaining('memory is full'),
        });
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'closeout',
          message: 'Memory is full.',
        });
        return '';
      },
    );

    await answerFastAgentQuestion({ ...baseParams, adapter: callbacks() });
  });

  it('validates a durable session before resuming with the new turn', async () => {
    mocks.getSession.mockResolvedValue({
      id: 'conversation-1',
      compatibilityMessages: [
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: 'Earlier answer' },
      ],
      openCodeSessionId: 'persisted-session',
    });
    mocks.runSession.mockImplementation(({ prompt, execute }) =>
      execute({ id: 'persisted-session' }, prompt, {
        path: 'cold_resume',
        validateSession: true,
      }),
    );
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('persisted-session');
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'closeout',
          message: 'It coordinates incoming requests.',
        });
        return '';
      },
    );

    await answerFastAgentQuestion({ ...baseParams, adapter: callbacks() });

    expect(mocks.runSession).toHaveBeenCalledWith(
      expect.objectContaining({
        persistedSessionId: 'persisted-session',
      }),
    );
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.not.stringContaining('Earlier answer'),
      }),
      { id: 'persisted-session' },
      expect.objectContaining({ validateSession: true }),
    );
    expect(mocks.setOpenCodeSession).not.toHaveBeenCalled();
  });

  it('rebuilds missing durable sessions and stores the replacement id', async () => {
    const { FastAgentOpenCodeSessionManager } = await vi.importActual<
      typeof import('../fast-agent-opencode-session')
    >('../fast-agent-opencode-session');
    const manager = new FastAgentOpenCodeSessionManager();
    const prompts: string[] = [];
    mocks.runSession.mockImplementation((input) => manager.run(input));
    mocks.getSession.mockResolvedValue({
      id: 'conversation-1',
      compatibilityMessages: [
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: 'Earlier answer' },
      ],
      openCodeSessionId: 'missing-session',
    });
    mocks.generateText.mockImplementation(async (params, session, options) => {
      prompts.push(params.prompt);
      if (options.validateSession) {
        const error = new Error('Session not found');
        error.name = 'NonTaskOpenCodeSessionNotFoundError';
        throw error;
      }
      session.id = 'replacement-session';
      await options.onSessionReady(session.id);
      await invokeTool(nativeToolNames.sendChatReply, {
        purpose: 'closeout',
        message: 'Recovered from visible history.',
      });
      return '';
    });

    await answerFastAgentQuestion({ ...baseParams, adapter: callbacks() });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('Earlier answer');
    expect(prompts[1]).toContain('Earlier answer');
    expect(mocks.setOpenCodeSession).toHaveBeenCalledWith({
      sessionId: 'conversation-1',
      openCodeSessionId: 'replacement-session',
    });
    expect(mocks.getNativeRuntime).toHaveBeenCalledTimes(2);
  });

  it('keeps Fast-native tools parent-only while MCP tools use the shared broker', async () => {
    const adapter = callbacks();
    mocks.listIntegrations.mockResolvedValue([
      {
        id: 'github',
        name: 'GitHub',
        description: 'Repository access',
        tools: [{ name: 'search_code' }],
      },
      {
        id: 'roomote',
        name: 'Roomote',
        description: 'Deployment management',
        tools: [
          { name: 'manage_custom_automations' },
          { name: 'manage_tasks' },
        ],
      },
    ]);
    mocks.callIntegration.mockImplementation(
      async (_context, _integrations, request) =>
        request.toolName === 'manage_tasks'
          ? { id: request.args.taskId, taskRunStatus: 'running' }
          : { matches: ['fast-agent.ts'] },
    );

    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        await options.onSubagentSessionReady('opencode-subagent-1');
        await options.onSubagentSessionReady('opencode-subagent-1');

        const parentExecutor = mocks.bindExecutor.mock.calls.find(
          ([sessionID]) => sessionID === 'opencode-session-1',
        )?.[2];
        const subagentExecutor = mocks.bindExecutor.mock.calls.find(
          ([sessionID]) => sessionID === 'opencode-subagent-1',
        )?.[2];
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
              name: nativeToolNames.sendChatReply,
              args: { purpose: 'closeout', message: 'leak' },
            }),
          ).resolves.toEqual({
            success: false,
            error: 'That tool is reserved for the Fast parent agent.',
          });
        }
        await expect(
          invokeMcpTool('roomote', 'manage_tasks', {
            action: 'get_summary',
            taskId: 'task-advisor',
          }),
        ).resolves.toEqual({
          success: true,
          result: { id: 'task-advisor', taskRunStatus: 'running' },
        });
        await expect(
          invokeMcpTool('github', 'search_code', {
            query: 'Fast Agent advisor',
          }),
        ).resolves.toEqual({
          success: true,
          result: { matches: ['fast-agent.ts'] },
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
    expect(mocks.callIntegration).toHaveBeenCalledTimes(2);
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        trackSessionTreeUsage: true,
        tools: expect.objectContaining({
          'github_*': true,
          'roomote_*': true,
        }),
      }),
    );
    expect(mocks.generateText.mock.calls[0]?.[2].tools).not.toHaveProperty(
      'integration_call',
    );
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
    expect(mocks.callIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      expect.arrayContaining([expect.objectContaining({ id: 'roomote' })]),
      {
        integrationId: 'roomote',
        toolName: 'manage_tasks',
        args: {
          action: 'get_summary',
          taskId: expect.stringMatching(/^task-/),
        },
      },
    );
    expect(adapter.postReply).toHaveBeenCalledTimes(2);
    expect(mocks.bindExecutor).toHaveBeenCalledTimes(2);
    expect(
      mocks.bindExecutor.mock.calls.find(
        ([sessionID]) => sessionID === 'opencode-session-1',
      )?.[3],
    ).toMatchObject({ allowSkillAccess: true, allowSpillRecovery: true });
    expect(
      mocks.bindExecutor.mock.calls.find(
        ([sessionID]) => sessionID === 'opencode-subagent-1',
      )?.[3],
    ).toMatchObject({ allowSkillAccess: false, allowSpillRecovery: false });
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
        openCodeSessionId: null,
      })
      .mockResolvedValue({
        id: 'conversation-1',
        compatibilityMessages: [
          { role: 'user', content: 'Earlier question' },
          { role: 'assistant', content: 'Earlier answer' },
        ],
        openCodeSessionId: null,
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
          context: { path: string; validateSession: boolean },
        ) => Promise<unknown>;
      }) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return execute({ id: 'opencode-session-1' }, prompt, {
          path: 'warm',
          validateSession: false,
        });
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

  it('closes a retry notice when conversation lock loss cancels backoff', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const lockLost = new Error('Fast conversation lock ownership was lost.');
    const postReply = vi.fn().mockImplementation(async () => {
      controller.abort(lockLost);
      return { messageId: 'retry-1' };
    });
    const replaceReply = vi.fn().mockResolvedValue({ messageId: 'retry-1' });
    mocks.generateText.mockRejectedValue(new Error('TypeError: fetch failed'));

    try {
      const resultPromise = answerFastAgentQuestion({
        ...baseParams,
        adapter: callbacks({ postReply, replaceReply }),
        signal: controller.signal,
      });
      const rejection = expect(resultPromise).rejects.toBe(lockLost);
      await vi.runAllTimersAsync();

      await rejection;
      expect(mocks.generateText).toHaveBeenCalledOnce();
      expect(postReply).toHaveBeenCalledWith({
        purpose: 'progress',
        message: expect.stringContaining('attempt 1/6'),
      });
      expect(replaceReply).toHaveBeenCalledWith(
        { messageId: 'retry-1' },
        {
          purpose: 'closeout',
          message:
            'The inference retry was interrupted before it completed. Please send the request again.',
        },
      );
      expect(mocks.invalidateSession).toHaveBeenCalledWith('conversation-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start another attempt when lock loss follows backoff expiry', async () => {
    const controller = new AbortController();
    const lockLost = new Error('Fast conversation lock ownership was lost.');
    const postReply = vi.fn().mockResolvedValue({ messageId: 'retry-1' });
    const replaceReply = vi.fn().mockResolvedValue({ messageId: 'retry-1' });
    const originalSetTimeout = globalThis.setTimeout;
    let shouldAbort = true;
    const timeout = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
    ) => {
      return originalSetTimeout(() => {
        callback();
        if (shouldAbort) {
          shouldAbort = false;
          controller.abort(lockLost);
        }
      }, 0);
    }) as typeof setTimeout);
    mocks.generateText.mockRejectedValue(new Error('TypeError: fetch failed'));

    try {
      await expect(
        answerFastAgentQuestion({
          ...baseParams,
          adapter: callbacks({ postReply, replaceReply }),
          signal: controller.signal,
        }),
      ).rejects.toBe(lockLost);

      expect(mocks.generateText).toHaveBeenCalledOnce();
      expect(replaceReply).toHaveBeenCalledWith(
        { messageId: 'retry-1' },
        expect.objectContaining({ purpose: 'closeout' }),
      );
    } finally {
      timeout.mockRestore();
    }
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

  it('still answers when the canonical user prompt cannot persist', async () => {
    mocks.upsertMessage.mockRejectedValue(new Error('database unavailable'));

    const adapter = callbacks();
    await expect(
      answerFastAgentQuestion({
        ...baseParams,
        adapter,
      }),
    ).resolves.toBe('It coordinates incoming requests.');
    expect(mocks.generateText).toHaveBeenCalledOnce();
  });

  it('does not repost when canonical persistence fails after a visible reply', async () => {
    mocks.upsertMessage.mockImplementation(async ({ message }) => {
      if (message.eventType === 'roomote_runtime.assistant_message') {
        throw new Error('database unavailable');
      }
    });
    const adapter = callbacks();

    await expect(
      answerFastAgentQuestion({ ...baseParams, adapter }),
    ).resolves.toBe('It coordinates incoming requests.');
    expect(adapter.postReply).toHaveBeenCalledOnce();
  });

  it('posts final assistant text only as a defensive fallback', async () => {
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        await options.onMessageCompleted?.({
          id: 'native-message-1',
          sessionId: 'opencode-session-1',
          createdAtMs: 100,
          completedAtMs: 200,
        });
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
    expect(mocks.upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          eventId: '100.2:assistant:0',
          ts: 200,
          nativeSessionId: 'opencode-session-1',
          nativeMessageId: 'native-message-1',
        }),
      }),
    );
  });

  it.each(['github', 'gbrain'])(
    'requires an acknowledgement before calling the %s integration',
    async (integrationId) => {
      mocks.listIntegrations.mockResolvedValue([
        {
          id: integrationId,
          name: integrationId,
          description: 'Read integration',
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
            await invokeMcpTool(integrationId, 'search_code', {
              query: 'fast agent',
              nested: { exact: true },
            }),
          );
          await invokeTool(nativeToolNames.sendChatReply, {
            purpose: 'ack',
            message: 'I’ll check.',
          });
          toolResults.push(
            await invokeMcpTool(integrationId, 'search_code', {
              query: 'fast agent',
              nested: { exact: true },
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
          integrationId,
          toolName: 'search_code',
          args: { query: 'fast agent', nested: { exact: true } },
        },
      );
    },
  );

  it('stays silent after an acknowledgement when an integration has no result to report', async () => {
    mocks.listIntegrations.mockResolvedValue([
      {
        id: 'github',
        name: 'GitHub',
        description: 'Read GitHub',
        tools: [{ name: 'search_code', inputSchema: { type: 'object' } }],
      },
    ]);
    mocks.callIntegration.mockResolvedValue({ matches: [] });
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'ack',
          message: 'I’ll check.',
        });
        await invokeMcpTool('github', 'search_code', { query: 'missing' });
        return '';
      },
    );
    const adapter = callbacks();

    await expect(
      answerFastAgentQuestion({ ...baseParams, adapter }),
    ).resolves.toBe('I’ll check.');
    expect(adapter.postReply).toHaveBeenCalledOnce();
    expect(adapter.postReply).toHaveBeenCalledWith({
      purpose: 'ack',
      message: 'I’ll check.',
    });
  });

  it('routes task inspection and chat context through the Roomote MCP', async () => {
    mocks.listIntegrations.mockResolvedValue([
      {
        id: 'roomote',
        name: 'Roomote',
        description: 'Manage Roomote',
        tools: [{ name: 'manage_tasks' }, { name: 'get_chat_message_context' }],
      },
    ]);
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'ack',
          message: 'I’ll inspect that.',
        });
        await invokeMcpTool('roomote', 'manage_tasks', {
          action: 'get_summary',
          taskId: 'task-1',
        });
        await invokeMcpTool('roomote', 'get_chat_message_context', {
          messageId: '1710000000.000100',
        });
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'closeout',
          message: 'I found the context.',
        });
        return '';
      },
    );

    await answerFastAgentQuestion({ ...baseParams, adapter: callbacks() });

    expect(mocks.callIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      expect.arrayContaining([expect.objectContaining({ id: 'roomote' })]),
      {
        integrationId: 'roomote',
        toolName: 'manage_tasks',
        args: { action: 'get_summary', taskId: 'task-1' },
      },
    );
    expect(mocks.callIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      expect.any(Array),
      {
        integrationId: 'roomote',
        toolName: 'get_chat_message_context',
        args: {
          channel: 'channel-1',
          messageId: '1710000000.000100',
          provider: 'slack',
        },
      },
    );
  });

  it.each([
    [undefined, '2026-08-23T12:00:00.000Z'],
    ['1710000000.000000', '2024-03-08T16:00:00.000Z'],
    ['2026-08-24T12:00:00.000Z', '2026-08-23T12:00:00.000Z'],
  ])(
    'defaults Slack Roomote MCP history from latest %s to the previous 24 hours',
    async (latest, expectedOldest) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-24T12:00:00.000Z'));
      mocks.listIntegrations.mockResolvedValue([
        {
          id: 'roomote',
          name: 'Roomote',
          description: 'Manage Roomote',
          tools: [{ name: 'get_chat_channel_messages' }],
        },
      ]);
      mocks.generateText.mockImplementation(
        async (_params, _session, options) => {
          await options.onSessionReady('opencode-session-1');
          await invokeTool(nativeToolNames.sendChatReply, {
            purpose: 'ack',
            message: 'I’ll inspect that.',
          });
          await invokeMcpTool('roomote', 'get_chat_channel_messages', {
            ...(latest ? { latest } : {}),
          });
          await invokeTool(nativeToolNames.sendChatReply, {
            purpose: 'closeout',
            message: 'I found the history.',
          });
          return '';
        },
      );

      try {
        await answerFastAgentQuestion({ ...baseParams, adapter: callbacks() });
      } finally {
        vi.useRealTimers();
      }

      expect(mocks.callIntegration).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Array),
        {
          integrationId: 'roomote',
          toolName: 'get_chat_channel_messages',
          args: {
            channel: 'channel-1',
            ...(latest ? { latest } : {}),
            oldest: expectedOldest,
            provider: 'slack',
          },
        },
      );
    },
  );

  it('defaults Discord Roomote MCP lookups to the current thread', async () => {
    mocks.listIntegrations.mockResolvedValue([
      {
        id: 'roomote',
        name: 'Roomote',
        description: 'Manage Roomote',
        tools: [
          { name: 'get_chat_message_context' },
          { name: 'get_chat_channel_messages' },
        ],
      },
    ]);
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'ack',
          message: 'I’ll inspect that.',
        });
        await invokeMcpTool('roomote', 'get_chat_message_context', {
          messageId: 'message-1',
        });
        await invokeMcpTool('roomote', 'get_chat_channel_messages', {});
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'closeout',
          message: 'I found the context.',
        });
        return '';
      },
    );

    await answerFastAgentQuestion({
      ...baseParams,
      conversation: {
        surface: 'discord',
        workspaceId: 'guild-1',
        conversationId: 'thread-1',
        replyTarget: { channelId: 'channel-1', threadId: 'thread-1' },
      },
      adapter: callbacks(),
    });

    expect(mocks.callIntegration).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Array),
      {
        integrationId: 'roomote',
        toolName: 'get_chat_message_context',
        args: {
          channel: 'thread-1',
          messageId: 'message-1',
          provider: 'discord',
        },
      },
    );
    expect(mocks.callIntegration).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Array),
      {
        integrationId: 'roomote',
        toolName: 'get_chat_channel_messages',
        args: { channel: 'thread-1', provider: 'discord' },
      },
    );
  });

  it('lets the Fast parent manage custom automations through MCP tools', async () => {
    const resolveMcpServerConfigs = vi.fn(async () => ({}));
    mocks.listIntegrations.mockResolvedValue([
      {
        id: 'roomote',
        name: 'Roomote',
        description: 'Manage Roomote',
        tools: [{ name: 'manage_custom_automations' }],
      },
    ]);
    mocks.callIntegration.mockResolvedValue({
      automations: [],
    });
    const toolResults: unknown[] = [];
    mocks.generateText.mockImplementationOnce(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        for (let attempt = 0; attempt < 2; attempt += 1) {
          toolResults.push(
            await invokeMcpTool('roomote', 'manage_custom_automations', {
              action: 'list',
            }),
          );
        }
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'closeout',
          message: 'The automation is disabled.',
        });
        return '';
      },
    );

    await answerFastAgentQuestion({
      ...baseParams,
      adapter: callbacks({ resolveMcpServerConfigs }),
    });

    expect(toolResults[0]).toEqual({
      success: true,
      result: { automations: [] },
    });
    expect(toolResults[1]).toEqual({
      success: false,
      error: 'The same integration call already ran in this turn.',
    });
    expect(mocks.callIntegration).toHaveBeenCalledOnce();
    expect(mocks.listIntegrations).toHaveBeenCalledWith(
      { userId: 'user-1', apiBaseUrl: 'https://api.example.com' },
      resolveMcpServerConfigs,
    );
    expect(mocks.callIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      expect.arrayContaining([expect.objectContaining({ id: 'roomote' })]),
      {
        integrationId: 'roomote',
        toolName: 'manage_custom_automations',
        args: { action: 'list' },
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
      expect.objectContaining({
        model: 'anthropic/claude-sonnet-5',
        prompt: 'Fix checkout.',
      }),
    );
    const canonicalWrites = mocks.upsertMessage.mock.calls.map(
      ([input]) => input.message,
    );
    const toolCallIndex = canonicalWrites.findIndex(
      (message) =>
        message.eventId === '100.2:tool:0' &&
        message.eventType === 'roomote_runtime.tool_call',
    );
    const kickoffIndex = canonicalWrites.findIndex(
      (message) =>
        message.eventType === 'roomote_runtime.assistant_message' &&
        JSON.stringify(message.contentBlocks).includes(
          'delegating the checkout fix',
        ),
    );
    const toolResultIndex = canonicalWrites.findIndex(
      (message) =>
        message.eventId === '100.2:tool:0' &&
        message.eventType === 'roomote_runtime.tool_result',
    );
    expect(toolCallIndex).toBeGreaterThanOrEqual(0);
    expect(kickoffIndex).toBeGreaterThan(toolCallIndex);
    expect(toolResultIndex).toBeGreaterThan(kickoffIndex);
    expect(canonicalWrites[toolResultIndex]?.turnSeq).toBe(
      canonicalWrites[toolCallIndex]?.turnSeq,
    );
  });

  it('launches across all repositories when the sentinel is explicit', async () => {
    const launchTask = vi.fn<LaunchFastAgentTask>(async ({ postKickoff }) => {
      await postKickoff({ taskId: 'task-1' });
      return { success: true, taskId: 'task-1' };
    });
    const adapter = callbacks({ launchTask });
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        await expect(
          invokeTool(nativeToolNames.launchTask, {
            prompt: 'Update every repository.',
            environmentId: ALL_REPOSITORIES,
            kickoffMessage: 'I’m delegating the cross-repository update.',
          }),
        ).resolves.toMatchObject({ success: true, taskId: 'task-1' });
        return '';
      },
    );

    await answerFastAgentQuestion({ ...baseParams, adapter });

    expect(launchTask).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: ALL_REPOSITORIES }),
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
      {
        taskId: 'task-1',
        message: 'Include the regression test.',
      },
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

  it('steers an active task before posting a user-visible response', async () => {
    mocks.getActiveTasks.mockResolvedValue([
      { taskId: 'task-1', title: 'Checkout', status: 'running' },
    ]);
    const order: string[] = [];
    mocks.sendTaskMessage.mockImplementation(async () => {
      order.push('steer');
      return { success: true };
    });
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        await expect(
          invokeTool(nativeToolNames.sendTaskMessage, {
            taskId: 'task-1',
            message: 'Include the failing test.',
          }),
        ).resolves.toEqual({ success: true });
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'closeout',
          message: 'The task was updated.',
        });
        return '';
      },
    );
    const adapter = callbacks({
      postReply: vi.fn(async () => {
        order.push('reply');
      }),
    });

    await answerFastAgentQuestion({ ...baseParams, adapter });

    expect(mocks.sendTaskMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      {
        taskId: 'task-1',
        message: 'Include the failing test.',
      },
    );
    expect(order).toEqual(['steer', 'reply']);
  });

  it('still requires an acknowledgement before canceling a task', async () => {
    mocks.getActiveTasks.mockResolvedValue([
      { taskId: 'task-1', title: 'Checkout', status: 'running' },
    ]);
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        await expect(
          invokeTool(nativeToolNames.cancelTask, { taskId: 'task-1' }),
        ).resolves.toEqual({
          success: false,
          error:
            'Post an acknowledgement with send_chat_reply before this action.',
        });
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'ack',
          message: 'I’ll stop it.',
        });
        await expect(
          invokeTool(nativeToolNames.cancelTask, { taskId: 'task-1' }),
        ).resolves.toEqual({ success: true });
        return '';
      },
    );

    await answerFastAgentQuestion({ ...baseParams, adapter: callbacks() });

    expect(mocks.cancelTask).toHaveBeenCalledOnce();
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

  it('continues the same session without redelivering completed chat tools', async () => {
    vi.useFakeTimers();
    try {
      let duplicateAckResult: unknown;
      let duplicateReactionResult: unknown;
      mocks.generateText
        .mockImplementationOnce(async (_params, _session, options) => {
          await options.onSessionReady('opencode-session-1');
          await invokeTool(nativeToolNames.sendChatReply, {
            purpose: 'ack',
            message: 'I’m checking.',
          });
          await invokeTool(nativeToolNames.sendChatReaction, {
            name: 'eyes',
            purpose: 'ack',
          });
          throw new Error('TypeError: fetch failed');
        })
        .mockImplementationOnce(async (_params, _session, options) => {
          await options.onSessionReady('opencode-session-1');
          duplicateAckResult = await invokeTool(nativeToolNames.sendChatReply, {
            purpose: 'ack',
            message: 'I’m checking.',
          });
          duplicateReactionResult = await invokeTool(
            nativeToolNames.sendChatReaction,
            {
              name: 'eyes',
              purpose: 'ack',
            },
          );
          await invokeTool(nativeToolNames.sendChatReply, {
            purpose: 'closeout',
            message: 'The provider recovered.',
          });
          return '';
        });
      const replaceReply = vi.fn().mockResolvedValue({ messageId: 'retry-1' });
      const postReaction = vi.fn().mockResolvedValue(undefined);
      const adapter = callbacks({
        postReply: vi.fn().mockResolvedValue({ messageId: 'retry-1' }),
        postReaction,
        replaceReply,
      });

      const resultPromise = answerFastAgentQuestion({
        ...baseParams,
        images: ['data:image/png;base64,aGVsbG8='],
        adapter,
      });
      await vi.runAllTimersAsync();

      await expect(resultPromise).resolves.toBe('The provider recovered.');
      expect(mocks.generateText).toHaveBeenCalledTimes(2);
      expect(mocks.generateText.mock.calls[1]?.[1]).toBe(
        mocks.generateText.mock.calls[0]?.[1],
      );
      expect(mocks.generateText.mock.calls[1]?.[1]).toEqual({
        id: 'opencode-session-1',
      });
      expect(mocks.generateText.mock.calls[1]?.[0]).toMatchObject({
        prompt: expect.stringContaining(
          'Do not repeat completed tool calls or messages already sent',
        ),
        timeoutMs: 300_000,
      });
      expect(mocks.generateText.mock.calls[0]?.[0]).toHaveProperty('files');
      expect(mocks.generateText.mock.calls[1]?.[0]).not.toHaveProperty('files');
      expect(adapter.postReply).toHaveBeenCalledWith({
        purpose: 'progress',
        message: expect.stringContaining('Retrying in 1s (attempt 1/6)'),
      });
      expect(adapter.postReply).toHaveBeenCalledTimes(2);
      expect(adapter.postReply).toHaveBeenNthCalledWith(1, {
        purpose: 'ack',
        message: 'I’m checking.',
      });
      expect(duplicateAckResult).toMatchObject({
        success: true,
        delivered: true,
        duplicate: true,
      });
      expect(postReaction).toHaveBeenCalledOnce();
      expect(postReaction).toHaveBeenCalledWith({
        name: 'eyes',
        purpose: 'ack',
        messageId: '100.2',
      });
      expect(duplicateReactionResult).toMatchObject({
        success: true,
        delivered: true,
        duplicate: true,
      });
      expect(replaceReply).toHaveBeenCalledWith(
        { messageId: 'retry-1' },
        { purpose: 'closeout', message: 'The provider recovered.' },
      );
      expect(mocks.setOpenCodeSession).toHaveBeenCalledWith({
        sessionId: 'conversation-1',
        openCodeSessionId: 'opencode-session-1',
      });
      expect(mocks.invalidateSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry or append an error after the turn already closed', async () => {
    mocks.generateText.mockImplementationOnce(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'closeout',
          message: 'The requested work is complete.',
        });
        throw new Error('TypeError: fetch failed');
      },
    );
    const adapter = callbacks();

    await expect(
      answerFastAgentQuestion({ ...baseParams, adapter }),
    ).resolves.toBe('The requested work is complete.');

    expect(mocks.generateText).toHaveBeenCalledOnce();
    expect(adapter.postReply).toHaveBeenCalledOnce();
    expect(adapter.postReply).toHaveBeenCalledWith({
      purpose: 'closeout',
      message: 'The requested work is complete.',
    });
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
    mocks.getActiveTasks.mockResolvedValue([
      { taskId: 'task-1', taskRunStatus: 'running' },
    ]);
    mocks.cancelTask.mockReturnValueOnce(toolResult);
    let pendingTool: Promise<unknown> | undefined;
    mocks.generateText.mockImplementation(
      async (_params, _session, options) => {
        await options.onSessionReady('opencode-session-1');
        options.onPromptStarted?.();
        await invokeTool(nativeToolNames.sendChatReply, {
          purpose: 'ack',
          message: 'I’ll cancel it.',
        });
        pendingTool = invokeTool(nativeToolNames.cancelTask, {
          taskId: 'task-1',
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
        expect.stringContaining('activeNativeToolCounts={"cancel_task":1}'),
      );
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          'nativeToolCallCount=2 completedNativeToolCallCount=1',
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
      const retryWrites = mocks.upsertMessage.mock.calls
        .map(([input]) => input.message)
        .filter((message) => message.eventId === '100.2:retry-notice:0');
      expect(retryWrites.length).toBeGreaterThan(1);
      expect(new Set(retryWrites.map((message) => message.eventId)).size).toBe(
        1,
      );
      expect(retryWrites.at(-1)?.contentBlocks).toEqual([
        { type: 'text', text: 'Connection restored.' },
      ]);
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
