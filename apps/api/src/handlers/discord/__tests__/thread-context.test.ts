const deliveryMocks = vi.hoisted(() => ({
  claim: vi.fn(),
  mark: vi.fn(),
  release: vi.fn(),
  processAttachments: vi.fn(),
}));

vi.mock('../thread-delivery.js', () => ({
  claimUndeliveredDiscordThreadMessages: deliveryMocks.claim,
  markDiscordThreadMessagesDelivered: deliveryMocks.mark,
  releaseClaimedDiscordThreadMessages: deliveryMocks.release,
}));

vi.mock('../attachments.js', () => ({
  processDiscordAttachments: deliveryMocks.processAttachments,
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

  it('includes attachment-only earlier messages', () => {
    expect(
      formatDiscordThreadContext({
        messages: [
          {
            id: '100',
            user: 'u1',
            username: 'Alice',
            text: '',
            attachments: [
              {
                id: 'att-1',
                filename: 'screenshot.png',
                size: 12,
                url: 'https://cdn.discordapp.com/attachments/screenshot.png',
              },
            ],
          },
          {
            id: '200',
            user: 'u2',
            username: 'Matt',
            text: 'what is in that screenshot?',
            attachments: [],
          },
        ],
        currentMessageId: '200',
      }),
    ).toBe(
      '<thread_context>\nAlice: [attached: screenshot.png]\n</thread_context>',
    );
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
    deliveryMocks.processAttachments.mockResolvedValue({
      images: [],
      attachmentTexts: [],
      warnings: [],
    });
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

  it('claims and processes earlier attachment-only messages', async () => {
    deliveryMocks.processAttachments.mockResolvedValue({
      images: ['data:image/png;base64,prior'],
      attachmentTexts: ['notes.txt contents'],
      warnings: [],
    });
    const provider = {
      fetchChannelMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: '100',
            user: 'u-alice',
            username: 'Alice',
            text: '',
            files: [
              {
                id: 'att-img',
                name: 'shot.png',
                mimeType: 'image/png',
                size: 20,
                url: 'https://cdn.discordapp.com/attachments/shot.png',
              },
              {
                id: 'att-doc',
                name: 'notes.txt',
                mimeType: 'text/plain',
                size: 12,
                url: 'https://cdn.discordapp.com/attachments/notes.txt',
              },
            ],
          },
          {
            id: '200',
            user: 'u-matt',
            username: 'Matt',
            text: 'what does that say?',
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
        text: 'what does that say?',
        user: 'Matt',
        ts: '200',
        images: ['data:image/png;base64,current'],
      },
    });

    expect(deliveryMocks.claim).toHaveBeenCalledWith('thread-1', ['100']);
    expect(deliveryMocks.processAttachments).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'att-img',
        filename: 'shot.png',
        url: 'https://cdn.discordapp.com/attachments/shot.png',
      }),
      expect.objectContaining({
        id: 'att-doc',
        filename: 'notes.txt',
        url: 'https://cdn.discordapp.com/attachments/notes.txt',
      }),
    ]);
    expect(result.message.formattedPrompt).toContain(
      'Alice: [attached: shot.png, notes.txt]',
    );
    expect(result.message.formattedPrompt).toContain('notes.txt contents');
    expect(result.message.images).toEqual([
      'data:image/png;base64,current',
      'data:image/png;base64,prior',
    ]);
    expect(result.claimedMessageIds).toEqual(['100']);
  });

  it('claims attachments on the latest Roomote reply while keeping text in replying_to', async () => {
    deliveryMocks.processAttachments.mockResolvedValue({
      images: ['data:image/png;base64,bot'],
      attachmentTexts: [],
      warnings: [],
    });
    const provider = {
      fetchChannelMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: '100',
            user: 'u-alice',
            username: 'Alice',
            text: 'Please screenshot the error',
          },
          {
            id: '150',
            user: 'bot-1',
            username: 'Roomote',
            botId: 'bot-1',
            text: 'Here is what I found.',
            files: [
              {
                id: 'att-bot',
                name: 'error.png',
                mimeType: 'image/png',
                size: 40,
                url: 'https://cdn.discordapp.com/attachments/error.png',
              },
            ],
          },
          {
            id: '200',
            user: 'u-matt',
            username: 'Matt',
            text: 'what does that screenshot show?',
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
        text: 'what does that screenshot show?',
        user: 'Matt',
        ts: '200',
      },
    });

    expect(deliveryMocks.claim).toHaveBeenCalledWith('thread-1', [
      '100',
      '150',
    ]);
    expect(deliveryMocks.processAttachments).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'att-bot',
        filename: 'error.png',
      }),
    ]);
    expect(result.message.formattedPrompt).toContain(
      '<replying_to ts="150">\nRoomote: Here is what I found.\n</replying_to>',
    );
    expect(result.message.formattedPrompt).toContain(
      'Alice: Please screenshot the error',
    );
    // Bot text belongs in <replying_to>, not duplicated in <thread_context>.
    expect(result.message.formattedPrompt).not.toContain(
      'Roomote: Here is what I found. [attached: error.png]',
    );
    expect(result.message.images).toEqual(['data:image/png;base64,bot']);
    expect(result.claimedMessageIds).toEqual(['100', '150']);
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
    expect(deliveryMocks.processAttachments).not.toHaveBeenCalled();
    expect(result.claimedMessageIds).toEqual([]);
  });
});
