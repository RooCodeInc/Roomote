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
  handleSendChatReactionEmoji: vi.fn(),
  handleAddReactionToSlackMessage: vi.fn(),
  recordChatReplySatisfaction: vi.fn(),
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

vi.mock('../send-chat-reaction-emoji.js', () => ({
  handleSendChatReactionEmoji: mockState.handleSendChatReactionEmoji,
}));

vi.mock('../add-reaction-to-slack-message.js', () => ({
  handleAddReactionToSlackMessage: mockState.handleAddReactionToSlackMessage,
}));

vi.mock('../chat-reply-satisfaction.js', () => ({
  recordChatReplySatisfaction: mockState.recordChatReplySatisfaction,
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
    mockState.handleSendChatReactionEmoji.mockReset();
    mockState.handleAddReactionToSlackMessage.mockReset();
    mockState.recordChatReplySatisfaction.mockReset();

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
