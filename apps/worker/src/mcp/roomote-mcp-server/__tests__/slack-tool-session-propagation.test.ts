type RegisteredTool = {
  name: string;
  handler?: (
    params: Record<string, unknown>,
    extra?: { sessionId?: string },
  ) => Promise<unknown>;
};

const mockState = vi.hoisted(() => ({
  registeredTools: [] as RegisteredTool[],
  connect: vi.fn(async () => undefined),
  handleSendChatReply: vi.fn(),
  handleRelayFastAgentChatReply: vi.fn(),
  handleSendChatReactionEmoji: vi.fn(),
  handleAddReactionToSlackMessage: vi.fn(),
  recordChatReplySatisfaction: vi.fn(),
  recordChatReplyDeliveryFailure: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    registerTool(
      name: string,
      _config: unknown,
      handler?: RegisteredTool['handler'],
    ) {
      mockState.registeredTools.push({ name, handler });
    }

    connect = mockState.connect;
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));

vi.mock('../../monitoring/sentry.js', () => ({
  captureWorkerException: vi.fn(),
  flushWorkerSentry: vi.fn(async () => undefined),
  initWorkerSentry: vi.fn(async () => undefined),
  installWorkerFatalProcessHandlers: vi.fn(),
}));

vi.mock('../send-chat-reply.js', () => ({
  handleSendChatReply: mockState.handleSendChatReply,
}));

vi.mock('../relay-fast-agent-chat-reply.js', () => ({
  handleRelayFastAgentChatReply: mockState.handleRelayFastAgentChatReply,
}));

vi.mock('../send-chat-reaction-emoji.js', () => ({
  handleSendChatReactionEmoji: mockState.handleSendChatReactionEmoji,
}));

vi.mock('../add-reaction-to-slack-message.js', () => ({
  handleAddReactionToSlackMessage: mockState.handleAddReactionToSlackMessage,
}));

vi.mock('../chat-reply-satisfaction.js', () => ({
  recordChatReplySatisfaction: mockState.recordChatReplySatisfaction,
  recordChatReplyDeliveryFailure: mockState.recordChatReplyDeliveryFailure,
}));

function getRegisteredTool(toolName: string): RegisteredTool {
  const tool = mockState.registeredTools.find(({ name }) => name === toolName);

  expect(tool).toBeDefined();

  return tool!;
}

describe('roomote MCP Slack tool session propagation', () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.resetModules();
    mockState.registeredTools.length = 0;
    mockState.connect.mockClear();
    mockState.handleSendChatReply.mockReset();
    mockState.handleRelayFastAgentChatReply.mockReset();
    mockState.handleSendChatReactionEmoji.mockReset();
    mockState.handleAddReactionToSlackMessage.mockReset();
    mockState.recordChatReplySatisfaction.mockReset();
    mockState.recordChatReplyDeliveryFailure.mockReset();
    mockState.recordChatReplyDeliveryFailure.mockReturnValue({
      terminalDeliveryFailure: false,
    });

    process.env = {
      ...originalEnv,
      ROOMOTE_CLOUD_TOKEN: 'cloud-token',
      ROOMOTE_TASK_ID: 'task-1',
      ROOMOTE_SLACK_CHANNEL: 'C123',
      ROOMOTE_SLACK_THREAD_TS: '123.456',
    };

    await import('../index.js');
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('passes the MCP session id into send_chat_reply satisfaction writes', async () => {
    mockState.handleSendChatReply.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, messageTs: '111.222' }),
        },
      ],
    });

    await getRegisteredTool('send_chat_reply').handler!(
      { message: 'done', purpose: 'closeout' },
      { sessionId: 'thread-child' },
    );

    expect(mockState.recordChatReplySatisfaction).toHaveBeenCalledWith({
      messageTs: '111.222',
      tool: 'send_chat_reply',
      replyPurpose: 'closeout',
      sessionId: 'thread-child',
    });
  });

  it('records a successful Fast parent relay as lifecycle satisfaction', async () => {
    vi.resetModules();
    mockState.registeredTools.length = 0;
    mockState.handleRelayFastAgentChatReply.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            relayed: true,
            relayId: 'relay-1',
          }),
        },
      ],
    });
    process.env = {
      ...originalEnv,
      ROOMOTE_CLOUD_TOKEN: 'cloud-token',
      ROOMOTE_TASK_ID: 'task-1',
      ROOMOTE_TASK_RUN_ID: '42',
      ROOMOTE_FAST_AGENT_CHILD: 'true',
    };
    await import('../index.js');

    await getRegisteredTool('send_chat_reply').handler!(
      { message: 'still working', purpose: 'progress' },
      { sessionId: 'fast-child-session' },
    );

    expect(mockState.recordChatReplySatisfaction).toHaveBeenCalledWith({
      messageTs: 'relay-1',
      tool: 'send_chat_reply',
      replyPurpose: 'progress',
      sessionId: 'fast-child-session',
    });
  });

  it('records failed deliveries with the MCP session id and keeps the result unchanged while retryable', async () => {
    const failedResult = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: 'Failed to reply to chat thread: 502 transport hiccup',
            deliveryFailure: { retryable: true },
          }),
        },
      ],
    };
    mockState.handleSendChatReply.mockResolvedValue(failedResult);

    const result = await getRegisteredTool('send_chat_reply').handler!(
      { message: 'done', purpose: 'closeout' },
      { sessionId: 'thread-child' },
    );

    expect(mockState.recordChatReplyDeliveryFailure).toHaveBeenCalledWith({
      retryable: true,
      providerErrorCode: undefined,
      sessionId: 'thread-child',
    });
    expect(mockState.recordChatReplySatisfaction).not.toHaveBeenCalled();
    expect(result).toBe(failedResult);
  });

  it('rewrites the result with do-not-retry guidance once delivery is terminal', async () => {
    mockState.recordChatReplyDeliveryFailure.mockReturnValue({
      terminalDeliveryFailure: true,
    });
    mockState.handleSendChatReply.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: 'Failed to reply to chat thread: 422 not_in_channel',
            deliveryFailure: {
              retryable: false,
              providerErrorCode: 'not_in_channel',
            },
          }),
        },
      ],
    });

    const result = (await getRegisteredTool('send_chat_reply').handler!(
      { message: 'done', purpose: 'closeout' },
      { sessionId: 'thread-child' },
    )) as { content: Array<{ type: string; text: string }> };

    expect(mockState.recordChatReplyDeliveryFailure).toHaveBeenCalledWith({
      retryable: false,
      providerErrorCode: 'not_in_channel',
      sessionId: 'thread-child',
    });

    const parsed = JSON.parse(result.content[0]!.text) as Record<
      string,
      unknown
    >;
    expect(parsed.success).toBe(false);
    expect(parsed.deliveryPermanentlyFailed).toBe(true);
    expect(parsed.error).toContain('not_in_channel');
    expect(parsed.error).toContain('failing permanently');
    expect(parsed.error).toContain('do not retry');
  });

  it('does not record a delivery failure for non-delivery errors', async () => {
    mockState.handleSendChatReply.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: 'ROOMOTE_WORKSPACE_PATH not set',
          }),
        },
      ],
    });

    await getRegisteredTool('send_chat_reply').handler!(
      { message: 'done', purpose: 'closeout' },
      { sessionId: 'thread-child' },
    );

    expect(mockState.recordChatReplyDeliveryFailure).not.toHaveBeenCalled();
  });

  it('passes the MCP session id into send_chat_reaction_emoji satisfaction writes', async () => {
    mockState.handleSendChatReactionEmoji.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, messageTs: '333.444' }),
        },
      ],
    });

    await getRegisteredTool('send_chat_reaction_emoji').handler!(
      { name: 'thumbsup' },
      { sessionId: 'thread-child' },
    );

    expect(mockState.recordChatReplySatisfaction).toHaveBeenCalledWith({
      messageTs: '333.444',
      tool: 'send_chat_reaction_emoji',
      replyPurpose: undefined,
      sessionId: 'thread-child',
    });
  });
});
