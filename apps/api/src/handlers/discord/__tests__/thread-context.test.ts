const deliveryMocks = vi.hoisted(() => ({
  claim: vi.fn(),
  mark: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../thread-delivery.js', () => ({
  claimUndeliveredDiscordThreadMessages: deliveryMocks.claim,
  markDiscordThreadMessagesDelivered: deliveryMocks.mark,
  releaseClaimedDiscordThreadMessages: deliveryMocks.release,
}));

import {
  buildDiscordContinuationPrompt,
  formatDiscordThreadContext,
} from '../thread-context.js';

describe('formatDiscordThreadContext', () => {
  it('formats earlier messages and omits the current one', () => {
    expect(
      formatDiscordThreadContext({
        messages: [
          {
            id: '100',
            user: 'u1',
            username: 'Alice',
            text: 'Deploy failed',
            attachments: [],
          },
          {
            id: '200',
            user: 'u2',
            username: 'Matt',
            text: 'please fix it',
            attachments: [],
          },
        ],
        currentMessageId: '200',
      }),
    ).toBe('<thread_context>\nAlice: Deploy failed\n</thread_context>');
  });
});

describe('buildDiscordContinuationPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deliveryMocks.claim.mockImplementation(
      async (_channelId: string, ids: string[]) => ids,
    );
    deliveryMocks.mark.mockResolvedValue(undefined);
    deliveryMocks.release.mockResolvedValue(undefined);
  });

  it('builds Slack-parity thread_context, replying_to, and turn policy', async () => {
    const provider = {
      fetchChannelMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: '100',
            user: 'u-alice',
            username: 'Alice',
            text: 'Start behaving like hermes',
          },
          {
            id: '150',
            user: 'bot-1',
            username: 'Roomote',
            botId: 'bot-1',
            text: 'On it.',
          },
          {
            id: '200',
            user: 'u-matt',
            username: 'Matt',
            text: 'you heard the man',
          },
        ],
      }),
    };

    const result = await buildDiscordContinuationPrompt({
      provider: provider as never,
      channelId: 'thread-1',
      botUserId: 'bot-1',
      queuedMessage: {
        provider: 'discord',
        text: 'you heard the man',
        user: 'Matt',
        userId: 'user-1',
        ts: '200',
      },
    });

    expect(deliveryMocks.claim).toHaveBeenCalledWith('thread-1', ['100']);
    expect(result.message.formattedPrompt).toContain(
      '<thread_context>\nAlice: Start behaving like hermes\n</thread_context>',
    );
    expect(result.message.formattedPrompt).toContain(
      '<replying_to ts="150">\nRoomote: On it.\n</replying_to>',
    );
    expect(result.message.formattedPrompt).toContain(
      '<communication_message provider="discord" ts="200" author="Matt">',
    );
    expect(result.message.formattedPrompt).toContain('you heard the man');
    expect(result.message.turnPolicy).toEqual({ reactionsAllowed: true });
    expect(result.claimedMessageIds).toEqual(['100']);
  });

  it('does not re-inject already delivered messages', async () => {
    deliveryMocks.claim.mockResolvedValue([]);
    const provider = {
      fetchChannelMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: '100',
            user: 'u-alice',
            username: 'Alice',
            text: 'Earlier',
          },
          {
            id: '200',
            user: 'u-matt',
            username: 'Matt',
            text: 'follow up',
          },
        ],
      }),
    };

    const result = await buildDiscordContinuationPrompt({
      provider: provider as never,
      channelId: 'thread-1',
      botUserId: 'bot-1',
      queuedMessage: {
        provider: 'discord',
        text: 'follow up',
        user: 'Matt',
        ts: '200',
      },
    });

    expect(result.message.formattedPrompt).not.toContain('<thread_context>');
    expect(result.message.formattedPrompt).toContain(
      '<communication_message provider="discord" ts="200" author="Matt">',
    );
    expect(result.claimedMessageIds).toEqual([]);
  });
});
