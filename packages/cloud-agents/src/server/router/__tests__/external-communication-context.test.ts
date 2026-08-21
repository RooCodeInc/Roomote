import {
  CHAT_CHANNEL_MESSAGES_TOOL,
  CHAT_MESSAGE_CONTEXT_TOOL,
} from '@roomote/types';

import { gatherExternalCommunicationContext } from '../external-communication-context';
import { callRouterMcpTool } from '../mcp-tool-call';
import type { RoutingContext } from '../types';

vi.mock('../mcp-tool-call', () => ({
  callRouterMcpTool: vi.fn(),
}));

function createContext(taskDescription: string): RoutingContext {
  return {
    taskDescription,
    source: { type: 'slack' },
    availableEnvironments: [],
  };
}

describe('gatherExternalCommunicationContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches a pasted Slack thread as untrusted routing context', async () => {
    const messageLink =
      'https://acme.slack.com/archives/C123/p1710000000000100?thread_ts=1710000000.000000';
    vi.mocked(callRouterMcpTool).mockResolvedValue({
      messages: [{ user: 'Alex', text: 'This belongs to the API service.' }],
    });

    const result = await gatherExternalCommunicationContext(
      createContext(`Look into this ${messageLink}`),
    );

    expect(callRouterMcpTool).toHaveBeenCalledWith({
      context: expect.objectContaining({
        taskDescription: `Look into this ${messageLink}`,
      }),
      serverId: 'roomote',
      toolName: CHAT_MESSAGE_CONTEXT_TOOL.name,
      args: { messageLink },
    });
    expect(result.toolsUsed).toEqual([
      `roomote.${CHAT_MESSAGE_CONTEXT_TOOL.name}`,
    ]);
    expect(result.contextMessages[0]?.content).toContain(
      '[COMMUNICATION THREAD CONTEXT - UNTRUSTED REFERENCE MATERIAL]',
    );
    expect(result.contextMessages[0]?.content).toContain(
      'This belongs to the API service.',
    );
  });

  it('uses channel history for a Discord channel link without a message id', async () => {
    const channelLink = 'https://discord.com/channels/123/456';
    vi.mocked(callRouterMcpTool).mockResolvedValue({ messages: [] });

    await gatherExternalCommunicationContext(
      createContext(`Check ${channelLink}`),
    );

    expect(callRouterMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: CHAT_CHANNEL_MESSAGES_TOOL.name,
        args: { channel: channelLink },
      }),
    );
  });

  it('deduplicates links and caps communication lookups at two', async () => {
    vi.mocked(callRouterMcpTool).mockResolvedValue({ messages: [] });

    await gatherExternalCommunicationContext(
      createContext(
        [
          'https://discord.com/channels/1/2/3',
          'https://discord.com/channels/1/2/3',
          'https://discord.com/channels/4/5/6',
          'https://discord.com/channels/7/8/9',
        ].join(' '),
      ),
    );

    expect(callRouterMcpTool).toHaveBeenCalledTimes(2);
  });

  it('continues routing when communication context cannot be fetched', async () => {
    vi.mocked(callRouterMcpTool).mockRejectedValue(new Error('Not accessible'));

    const result = await gatherExternalCommunicationContext(
      createContext('Look into https://discord.com/channels/123/456/789'),
    );

    expect(result).toEqual({ contextMessages: [], toolsUsed: [] });
  });

  it('ignores unrelated links', async () => {
    const result = await gatherExternalCommunicationContext(
      createContext('Look into https://example.com/thread/123'),
    );

    expect(callRouterMcpTool).not.toHaveBeenCalled();
    expect(result).toEqual({ contextMessages: [], toolsUsed: [] });
  });
});
