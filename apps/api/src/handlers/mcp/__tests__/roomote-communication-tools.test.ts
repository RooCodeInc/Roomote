const {
  hasUserDirectMessageIdentityMock,
  listCommunicationChannelsMock,
  maybeAddCommunicationReactionMock,
  sendUserDirectMessageMock,
  sendCommunicationChannelPostMock,
} = vi.hoisted(() => ({
  hasUserDirectMessageIdentityMock: vi.fn(),
  listCommunicationChannelsMock: vi.fn(),
  maybeAddCommunicationReactionMock: vi.fn(),
  sendUserDirectMessageMock: vi.fn(),
  sendCommunicationChannelPostMock: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  hasUserDirectMessageIdentity: hasUserDirectMessageIdentityMock,
  sendUserDirectMessage: sendUserDirectMessageMock,
}));

vi.mock('../communication-channel-discovery', () => ({
  listCommunicationChannels: listCommunicationChannelsMock,
}));

vi.mock('../communication-channel-posts', () => ({
  sendCommunicationChannelPost: sendCommunicationChannelPostMock,
}));

vi.mock('../communication-thread-replies', () => ({
  maybeAddCommunicationReaction: maybeAddCommunicationReactionMock,
}));

import { registerRoomoteCommunicationTools } from '../roomote-communication-tools';

type RegisteredTool = {
  name: string;
  config: { description?: string; inputSchema?: Record<string, unknown> };
  handler: (params: Record<string, string>) => Promise<unknown>;
};

function registerTools(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const server = {
    registerTool: (
      name: string,
      config: RegisteredTool['config'],
      handler: RegisteredTool['handler'],
    ) => tools.push({ name, config, handler }),
  };
  registerRoomoteCommunicationTools(server as never, 'user-1');
  return tools;
}

describe('Roomote member communication tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listCommunicationChannelsMock.mockResolvedValue({ channelCount: 0 });
    hasUserDirectMessageIdentityMock.mockResolvedValue(true);
    sendUserDirectMessageMock.mockResolvedValue(true);
    sendCommunicationChannelPostMock.mockResolvedValue(
      Response.json({ channelId: 'C2', messageTs: '200.1' }),
    );
  });

  it('registers the normal channel tool inventory once', () => {
    expect(registerTools().map(({ name }) => name)).toEqual([
      'list_chat_channels',
      'post_to_channel',
      'send_chat_reaction_emoji',
      'send_direct_message_to_self',
    ]);
  });

  it('advertises self and linked-member direct-message capabilities', () => {
    const tools = registerTools();

    expect(
      tools.find(({ name }) => name === 'post_to_channel')?.config.description,
    ).toContain('linked workspace member');
    expect(
      tools.find(({ name }) => name === 'send_direct_message_to_self')?.config
        .description,
    ).toContain('linked Telegram or Slack account');
  });

  it.each(['telegram', 'slack'] as const)(
    'sends an exact %s direct message only to the acting member',
    async (provider) => {
      const directMessage = registerTools().find(
        ({ name }) => name === 'send_direct_message_to_self',
      )!;
      const text = 'Keep this text exactly as written.';

      const result = await directMessage.handler({ provider, text });

      expect(hasUserDirectMessageIdentityMock).toHaveBeenCalledWith(
        provider,
        'user-1',
      );
      expect(sendUserDirectMessageMock).toHaveBeenCalledWith({
        provider,
        userId: 'user-1',
        text,
        logContext: 'roomote-mcp-self-direct-message',
      });
      expect(result).toMatchObject({
        structuredContent: { delivered: true, provider },
      });
    },
  );

  it('reports missing provider linkage without attempting delivery', async () => {
    hasUserDirectMessageIdentityMock.mockResolvedValue(false);
    const directMessage = registerTools().find(
      ({ name }) => name === 'send_direct_message_to_self',
    )!;

    const result = await directMessage.handler({
      provider: 'telegram',
      text: 'Hello.',
    });

    expect(sendUserDirectMessageMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        code: 'recipient_not_linked',
        provider: 'telegram',
      },
    });
  });

  it('reports an unconfirmed provider delivery as an error', async () => {
    sendUserDirectMessageMock.mockResolvedValue(false);
    const directMessage = registerTools().find(
      ({ name }) => name === 'send_direct_message_to_self',
    )!;

    const result = await directMessage.handler({
      provider: 'telegram',
      text: 'Hello.',
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        code: 'delivery_failed',
        provider: 'telegram',
      },
    });
  });

  it('binds channel discovery and posting to the acting user and workspace', async () => {
    const tools = registerTools();
    await tools
      .find(({ name }) => name === 'list_chat_channels')!
      .handler({ slackTeamId: 'T1' });
    await tools
      .find(({ name }) => name === 'post_to_channel')!
      .handler({
        provider: 'slack',
        slackTeamId: 'T1',
        channel: '#shipping',
        threadTs: '199.9',
        text: 'Release is ready.',
      });

    expect(listCommunicationChannelsMock).toHaveBeenCalledWith({
      actingUserId: 'user-1',
      slackTeamId: 'T1',
    });
    expect(sendCommunicationChannelPostMock).toHaveBeenCalledWith({
      taskRun: {
        id: 0,
        taskId: 'member:user-1',
        actingUserId: 'user-1',
        payload: {
          communicationProvider: 'slack',
          communicationTeamId: 'T1',
        },
      },
      parsedBody: {
        channel: '#shipping',
        threadTs: '199.9',
        text: 'Release is ready.',
        images: [],
      },
    });
  });

  it('routes reactions through the shared communication handler', async () => {
    maybeAddCommunicationReactionMock.mockResolvedValue(
      Response.json({ channelId: 'C1', messageTs: '100.2', name: 'eyes' }),
    );
    const reaction = registerTools().find(
      ({ name }) => name === 'send_chat_reaction_emoji',
    )!;

    await reaction.handler({
      provider: 'slack',
      slackTeamId: 'T1',
      channel: 'C1',
      messageId: '100.2',
      name: 'eyes',
    });

    expect(maybeAddCommunicationReactionMock).toHaveBeenCalledWith({
      taskRun: {
        id: 0,
        payload: {
          communicationProvider: 'slack',
          communicationTeamId: 'T1',
          communicationChannelId: 'C1',
        },
      },
      parsedBody: {
        channel: 'C1',
        messageTs: '100.2',
        name: 'eyes',
      },
    });
  });
});
