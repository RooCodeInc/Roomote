const {
  listCommunicationChannelsMock,
  maybeAddCommunicationReactionMock,
  sendCommunicationChannelPostMock,
} = vi.hoisted(() => ({
  listCommunicationChannelsMock: vi.fn(),
  maybeAddCommunicationReactionMock: vi.fn(),
  sendCommunicationChannelPostMock: vi.fn(),
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
  config: { inputSchema?: Record<string, unknown> };
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
    sendCommunicationChannelPostMock.mockResolvedValue(
      Response.json({ channelId: 'C2', messageTs: '200.1' }),
    );
  });

  it('registers the normal channel tool inventory once', () => {
    expect(registerTools().map(({ name }) => name)).toEqual([
      'list_chat_channels',
      'post_to_channel',
      'send_chat_reaction_emoji',
    ]);
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
