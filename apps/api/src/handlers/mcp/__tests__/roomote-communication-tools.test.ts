const {
  listCommunicationDestinationsMock,
  maybeAddCommunicationReactionMock,
  sendCommunicationMessageMock,
} = vi.hoisted(() => ({
  listCommunicationDestinationsMock: vi.fn(),
  maybeAddCommunicationReactionMock: vi.fn(),
  sendCommunicationMessageMock: vi.fn(),
}));

vi.mock('../communication-channel-discovery', () => ({
  listCommunicationDestinations: listCommunicationDestinationsMock,
}));

vi.mock('../communication-message-send', () => ({
  sendCommunicationMessage: sendCommunicationMessageMock,
}));

vi.mock('../communication-thread-replies', () => ({
  maybeAddCommunicationReaction: maybeAddCommunicationReactionMock,
}));

import { registerRoomoteCommunicationTools } from '../roomote-communication-tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

type RegisteredTool = {
  name: string;
  config: { description?: string; inputSchema?: Record<string, unknown> };
  handler: (params: Record<string, unknown>) => Promise<unknown>;
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
    listCommunicationDestinationsMock.mockResolvedValue({
      provider: 'slack',
      kind: 'person',
      totalCount: 0,
      returnedCount: 0,
      offset: 0,
      limit: 20,
      hasMore: false,
      truncated: false,
      destinations: [],
      limitations: [],
    });
    sendCommunicationMessageMock.mockResolvedValue(
      Response.json({ delivered: true, destination: 'telegram:me' }),
    );
  });

  it('registers one destination lookup and one standalone send tool', () => {
    expect(registerTools().map(({ name }) => name)).toEqual([
      'list_chat_destinations',
      'send_chat_message',
      'send_chat_reaction_emoji',
    ]);
  });

  it('describes the lookup-issued destination contract', () => {
    const tools = registerTools();

    expect(
      tools.find(({ name }) => name === 'list_chat_destinations')?.config
        .description,
    ).toContain('Provider and destination kind are required');
    expect(
      tools.find(({ name }) => name === 'list_chat_destinations')?.config
        .inputSchema,
    ).toEqual(
      expect.objectContaining({
        provider: expect.anything(),
        kind: expect.anything(),
        query: expect.anything(),
        destination: expect.anything(),
        offset: expect.anything(),
        limit: expect.anything(),
      }),
    );
    expect(
      tools.find(({ name }) => name === 'send_chat_message')?.config
        .description,
    ).toContain('Self destinations resolve only from the authenticated member');
    expect(
      tools.find(({ name }) => name === 'send_chat_message')?.config
        .inputSchema,
    ).not.toHaveProperty('imageArtifactIds');
  });

  it.each(['telegram:me', 'slack:me'])(
    'routes %s through the authenticated member sender',
    async (destination) => {
      const send = registerTools().find(
        ({ name }) => name === 'send_chat_message',
      )!;

      await send.handler({ destination, message: 'Exact message.' });

      expect(sendCommunicationMessageMock).toHaveBeenCalledWith({
        actingUserId: 'user-1',
        destination,
        message: 'Exact message.',
      });
    },
  );

  it('binds targeted destination discovery to the acting user and workspace', async () => {
    const lookup = registerTools().find(
      ({ name }) => name === 'list_chat_destinations',
    )!;

    await lookup.handler({
      provider: 'slack',
      kind: 'person',
      query: 'alice',
      workspaceId: 'T1',
      offset: 20,
      limit: 10,
    });

    expect(listCommunicationDestinationsMock).toHaveBeenCalledWith({
      actingUserId: 'user-1',
      provider: 'slack',
      kind: 'person',
      query: 'alice',
      workspaceId: 'T1',
      offset: 20,
      limit: 10,
    });
  });

  it('rejects an unfiltered MCP lookup before invoking discovery', async () => {
    const server = new McpServer({ name: 'communication-test', version: '1' });
    const client = new Client({ name: 'communication-test', version: '1' });
    registerRoomoteCommunicationTools(server, 'user-1');
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: 'list_chat_destinations',
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(listCommunicationDestinationsMock).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
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
