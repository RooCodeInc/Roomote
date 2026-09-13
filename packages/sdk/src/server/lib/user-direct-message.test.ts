import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockOpenConversation,
  mockCreateDiscordDirectMessage,
  mockCreateTeamsDirectMessage,
  mockDiscordPostMessage,
  mockDiscordUserMappingsFindFirst,
  mockPostDirectMessage,
  mockTeamsPostMessage,
  mockSlackInstallationsFindMany,
  mockSlackPostMessage,
  mockSlackUserMappingsFindFirst,
  mockTeamsUserMappingsFindFirst,
  mockTelegramPostMessage,
  mockTelegramUserMappingsFindFirst,
  mockStartAgentMailConversation,
  mockCanStartAgentMailConversation,
  mockAgentMailPostMessage,
  mockPostSlackRootWithFooter,
  mockPostSlackThreadWithFooter,
  mockBuildFooterText,
  mockPostTextWithFooter,
  mockDeliverManagedFooter,
  mockSetFooterRecord,
} = vi.hoisted(() => ({
  mockOpenConversation: vi.fn(),
  mockCreateDiscordDirectMessage: vi.fn(),
  mockCreateTeamsDirectMessage: vi.fn(),
  mockDiscordPostMessage: vi.fn(),
  mockDiscordUserMappingsFindFirst: vi.fn(),
  mockPostDirectMessage: vi.fn(),
  mockTeamsPostMessage: vi.fn(),
  mockSlackInstallationsFindMany: vi.fn(),
  mockSlackPostMessage: vi.fn(),
  mockSlackUserMappingsFindFirst: vi.fn(),
  mockTeamsUserMappingsFindFirst: vi.fn(),
  mockTelegramPostMessage: vi.fn(),
  mockTelegramUserMappingsFindFirst: vi.fn(),
  mockStartAgentMailConversation: vi.fn(),
  mockCanStartAgentMailConversation: vi.fn(),
  mockAgentMailPostMessage: vi.fn(),
  mockPostSlackRootWithFooter: vi.fn(),
  mockPostSlackThreadWithFooter: vi.fn(),
  mockBuildFooterText: vi.fn(),
  mockPostTextWithFooter: vi.fn(),
  mockDeliverManagedFooter: vi.fn(),
  mockSetFooterRecord: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      slackInstallations: { findMany: mockSlackInstallationsFindMany },
      slackUserMappings: { findFirst: mockSlackUserMappingsFindFirst },
      discordUserMappings: { findFirst: mockDiscordUserMappingsFindFirst },
      teamsUserMappings: { findFirst: mockTeamsUserMappingsFindFirst },
      telegramUserMappings: { findFirst: mockTelegramUserMappingsFindFirst },
    },
  },
  and: vi.fn(),
  discordUserMappings: {},
  eq: vi.fn(),
  slackInstallations: {},
  slackUserMappings: {},
  teamsUserMappings: {},
  telegramUserMappings: {},
}));

vi.mock('./discord-communication', () => ({
  createDiscordCommunicationProviderFromRuntimeCredentials: vi.fn(async () => ({
    createDirectMessage: mockCreateDiscordDirectMessage,
    postMessage: mockDiscordPostMessage,
  })),
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: vi.fn().mockImplementation(function () {
    return {
      openConversation: mockOpenConversation,
      postMessage: mockSlackPostMessage,
    };
  }),
  postSlackRootMessageWithFooterText: mockPostSlackRootWithFooter,
  postSlackThreadMessageWithFooterText: mockPostSlackThreadWithFooter,
}));

vi.mock('@roomote/communication', () => ({
  buildFastSessionReplyFooterText: mockBuildFooterText,
  postTextThreadReplyWithFooter: mockPostTextWithFooter,
  deliverManagedThreadReplyFooter: mockDeliverManagedFooter,
  setThreadReplyFooterRecord: mockSetFooterRecord,
  getDiscordFooterlessFinalChunk: ({
    textWithFooter,
  }: {
    textWithFooter: string;
  }) => textWithFooter,
}));

vi.mock('./fast-agent-slack-reply-blocks', () => ({
  buildFastAgentSlackReplyBodyBlocks: ({
    message,
    quote,
  }: {
    message: string;
    quote?: string | null;
  }) => [
    ...(quote
      ? [{ type: 'section', text: { type: 'mrkdwn', text: quote } }]
      : []),
    { type: 'markdown', text: message },
  ],
}));

vi.mock('./teams-communication', () => ({
  createTeamsCommunicationProviderFromRuntimeCredentials: vi.fn(async () => ({
    createDirectMessage: mockCreateTeamsDirectMessage,
    postDirectMessage: mockPostDirectMessage,
    postMessage: mockTeamsPostMessage,
  })),
}));

vi.mock('./telegram-communication', () => ({
  createTelegramCommunicationProviderFromRuntimeCredentials: vi.fn(
    async () => ({ postMessage: mockTelegramPostMessage }),
  ),
}));

vi.mock('./teams-primary-conversation', () => ({
  findTeamsPrimaryConversation: vi.fn(async () => ({
    conversationId: 'conversation-1',
    serviceUrl: 'https://smba.example.com/amer/',
    conversationType: 'personal',
  })),
}));

vi.mock('./agentmail/outbound', () => ({
  canStartAgentMailConversationWithUser: mockCanStartAgentMailConversation,
  startAgentMailConversation: mockStartAgentMailConversation,
  startAgentMailConversationWithResult: mockStartAgentMailConversation,
}));

vi.mock('./agentmail-communication', () => ({
  createAgentMailCommunicationProviderFromRuntimeCredentials: vi.fn(
    async () => ({ postMessage: mockAgentMailPostMessage }),
  ),
}));

import { createTelegramCommunicationProviderFromRuntimeCredentials } from './telegram-communication';
import {
  findSlackUserDirectMessageDestination,
  findUserDirectMessageDestination,
  hasAnyUserDirectMessageIdentity,
  sendUserDirectMessage,
  sendUserDirectMessageBestEffort,
  sendUserDirectMessageBestEffortWithReceipts,
} from './user-direct-message';

describe('findSlackUserDirectMessageDestination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSlackInstallationsFindMany.mockResolvedValue([
      { botAccessToken: 'xoxb-token', teamId: 'T123' },
    ]);
    mockSlackUserMappingsFindFirst.mockResolvedValue({ slackUserId: 'U123' });
    mockOpenConversation.mockResolvedValue('D123');
  });

  it('opens a DM for the linked Slack identity', async () => {
    await expect(
      findSlackUserDirectMessageDestination('user-1'),
    ).resolves.toEqual({ channelId: 'D123', teamId: 'T123' });
    expect(mockOpenConversation).toHaveBeenCalledWith('U123');
  });

  it('returns null when the user has no linked Slack identity', async () => {
    mockSlackUserMappingsFindFirst.mockResolvedValue(undefined);

    await expect(
      findSlackUserDirectMessageDestination('user-1'),
    ).resolves.toBeNull();
    expect(mockOpenConversation).not.toHaveBeenCalled();
  });
});

describe('findUserDirectMessageDestination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTeamsUserMappingsFindFirst.mockResolvedValue({
      teamsUserId: 'teams-user-1',
      teamsTenantId: 'tenant-1',
    });
    mockCreateTeamsDirectMessage.mockResolvedValue({ channelId: 'teams-dm-1' });
    mockTelegramUserMappingsFindFirst.mockResolvedValue({
      telegramChatId: '424242',
    });
    mockDiscordUserMappingsFindFirst.mockResolvedValue({
      discordDmChannelId: 'discord-dm-1',
      discordUserId: 'discord-user-1',
    });
  });

  it('creates a Teams conversation for the linked identity', async () => {
    await expect(
      findUserDirectMessageDestination('teams', 'user-1'),
    ).resolves.toEqual({
      channelId: 'teams-dm-1',
      teamId: 'tenant-1',
      serviceUrl: 'https://smba.example.com/amer/',
    });
    expect(mockCreateTeamsDirectMessage).toHaveBeenCalledWith({
      serviceUrl: 'https://smba.example.com/amer/',
      tenantId: 'tenant-1',
      userId: 'teams-user-1',
    });
  });

  it('uses the linked Telegram chat', async () => {
    await expect(
      findUserDirectMessageDestination('telegram', 'user-1'),
    ).resolves.toEqual({ channelId: '424242' });
  });

  it('reuses the linked Discord DM channel', async () => {
    await expect(
      findUserDirectMessageDestination('discord', 'user-1'),
    ).resolves.toEqual({ channelId: 'discord-dm-1' });
    expect(mockCreateDiscordDirectMessage).not.toHaveBeenCalled();
  });

  it('creates a Discord DM when the linked channel is missing', async () => {
    mockDiscordUserMappingsFindFirst.mockResolvedValue({
      discordDmChannelId: null,
      discordUserId: 'discord-user-1',
    });
    mockCreateDiscordDirectMessage.mockResolvedValue({
      id: 'discord-dm-2',
    });

    await expect(
      findUserDirectMessageDestination('discord', 'user-1'),
    ).resolves.toEqual({ channelId: 'discord-dm-2' });
    expect(mockCreateDiscordDirectMessage).toHaveBeenCalledWith(
      'discord-user-1',
    );
  });
});

describe('sendUserDirectMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDiscordUserMappingsFindFirst.mockResolvedValue({
      discordDmChannelId: 'discord-dm-1',
      discordUserId: 'discord-user-1',
    });
    mockDiscordPostMessage.mockResolvedValue({
      messageId: 'discord-message-1',
    });
    mockStartAgentMailConversation.mockResolvedValue({
      sent: true,
      conversation: {
        conversationId: 'email-conversation-1',
        inboxId: 'roomote@example.com',
        messageId: 'email-message-1',
        providerThreadId: 'email-thread-1',
      },
    });
  });

  it('sends to a linked Discord DM', async () => {
    await expect(
      sendUserDirectMessage({
        provider: 'discord',
        userId: 'user-1',
        text: 'hello',
        logContext: 'test',
      }),
    ).resolves.toBe(true);
    expect(mockDiscordPostMessage).toHaveBeenCalledWith({
      channelId: 'discord-dm-1',
      text: 'hello',
      textFormat: 'markdown',
    });
  });

  it('treats an accepted email without a recorded receipt as delivered', async () => {
    mockStartAgentMailConversation.mockResolvedValue({
      sent: true,
      conversation: null,
    });

    await expect(
      sendUserDirectMessage({
        provider: 'agentmail',
        userId: 'user-1',
        text: 'Task completed.',
        logContext: 'test',
      }),
    ).resolves.toBe(true);
  });

  it('uses an AgentMail thread as the reply receipt when recording fails', async () => {
    mockSlackUserMappingsFindFirst.mockResolvedValue(undefined);
    mockTeamsUserMappingsFindFirst.mockResolvedValue(undefined);
    mockTelegramUserMappingsFindFirst.mockResolvedValue(undefined);
    mockDiscordUserMappingsFindFirst.mockResolvedValue(undefined);
    mockStartAgentMailConversation.mockResolvedValue({
      sent: true,
      conversation: null,
      replyAnchor: {
        inboxId: 'roomote@example.com',
        messageId: null,
        providerThreadId: 'email-thread-1',
      },
    });

    await expect(
      sendUserDirectMessageBestEffortWithReceipts({
        userId: 'user-1',
        text: 'Task completed.',
        logContext: 'test',
      }),
    ).resolves.toEqual({
      deliveredProviders: ['agentmail'],
      receipts: [
        {
          provider: 'agentmail',
          workspaceId: 'roomote@example.com',
          channelId: 'email-thread-1',
          messageId: 'thread:email-thread-1',
          threadId: 'email-thread-1',
        },
      ],
    });
  });
});

describe('sendUserDirectMessageBestEffort', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSlackInstallationsFindMany.mockResolvedValue([
      { botAccessToken: 'xoxb-token', teamId: 'T123' },
    ]);
    mockSlackUserMappingsFindFirst.mockResolvedValue({ slackUserId: 'U123' });
    mockOpenConversation.mockResolvedValue('D123');
    mockSlackPostMessage.mockResolvedValue('1720000000.000100');
    mockPostSlackRootWithFooter.mockResolvedValue('1720000000.000100');
    mockPostSlackThreadWithFooter.mockResolvedValue('1720000000.000200');
    mockBuildFooterText.mockImplementation(
      ({ provider, sessionId }) =>
        `Reply anytime · [Open in Roomote](https://roomote.test/sessions/${sessionId}?provider=${provider})`,
    );
    mockPostTextWithFooter.mockResolvedValue({
      channelId: 'teams-dm-1',
      messageId: 'teams-message-1',
    });
    mockSetFooterRecord.mockResolvedValue(true);

    mockTeamsUserMappingsFindFirst.mockResolvedValue({
      teamsUserId: 'teams-user-1',
      teamsTenantId: 'tenant-1',
    });
    mockPostDirectMessage.mockResolvedValue({ messageId: 'teams-message-1' });

    mockTelegramUserMappingsFindFirst.mockResolvedValue({
      telegramChatId: '424242',
    });
    mockTelegramPostMessage.mockResolvedValue({ messageId: '77' });

    mockDiscordUserMappingsFindFirst.mockResolvedValue({
      discordDmChannelId: 'discord-dm-1',
      discordUserId: 'discord-user-1',
    });
    mockDiscordPostMessage.mockResolvedValue({
      messageId: 'discord-message-1',
    });
    mockStartAgentMailConversation.mockResolvedValue({
      sent: true,
      conversation: {
        conversationId: 'email-conversation-1',
        inboxId: 'roomote@example.com',
        messageId: 'email-message-1',
        providerThreadId: 'email-thread-1',
      },
    });
  });

  it('stops after the first successful personal route', async () => {
    const delivered = await sendUserDirectMessageBestEffort({
      userId: 'user-1',
      text: 'Your GitHub installation request was approved.',
      logContext: 'test',
    });

    expect(delivered).toEqual(['slack']);

    expect(mockOpenConversation).toHaveBeenCalledWith('U123');
    expect(mockSlackPostMessage).toHaveBeenCalledWith({
      channel: 'D123',
      text: 'Your GitHub installation request was approved.',
      blocks: [
        {
          type: 'markdown',
          text: 'Your GitHub installation request was approved.',
        },
      ],
    });
    expect(mockPostDirectMessage).not.toHaveBeenCalled();
    expect(mockTelegramPostMessage).not.toHaveBeenCalled();
    expect(mockDiscordPostMessage).not.toHaveBeenCalled();
    expect(mockStartAgentMailConversation).not.toHaveBeenCalled();
  });

  it('falls back to email after personal chat routes without consulting shared channels', async () => {
    mockSlackUserMappingsFindFirst.mockResolvedValue(undefined);
    mockTeamsUserMappingsFindFirst.mockResolvedValue(undefined);
    mockTelegramUserMappingsFindFirst.mockResolvedValue(undefined);
    mockDiscordUserMappingsFindFirst.mockResolvedValue(undefined);

    const delivered = await sendUserDirectMessageBestEffort({
      userId: 'user-1',
      text: 'Task completed.',
      logContext: 'test',
      idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });

    expect(delivered).toEqual(['agentmail']);
    expect(mockStartAgentMailConversation).toHaveBeenCalledWith({
      userId: 'user-1',
      subject: 'Task completed.',
      text: 'Task completed.',
      logContext: 'test',
      clientSendId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    const emailCallOrder =
      mockStartAgentMailConversation.mock.invocationCallOrder[0]!;
    expect(
      mockSlackUserMappingsFindFirst.mock.invocationCallOrder[0],
    ).toBeLessThan(emailCallOrder);
    expect(
      mockTeamsUserMappingsFindFirst.mock.invocationCallOrder[0],
    ).toBeLessThan(emailCallOrder);
    expect(
      mockTelegramUserMappingsFindFirst.mock.invocationCallOrder[0],
    ).toBeLessThan(emailCallOrder);
    expect(
      mockDiscordUserMappingsFindFirst.mock.invocationCallOrder[0],
    ).toBeLessThan(emailCallOrder);
  });

  it('sends the message when Discord is the only linked provider', async () => {
    mockSlackUserMappingsFindFirst.mockResolvedValue(undefined);
    mockTeamsUserMappingsFindFirst.mockResolvedValue(undefined);
    mockTelegramUserMappingsFindFirst.mockResolvedValue(undefined);

    const delivered = await sendUserDirectMessageBestEffort({
      userId: 'user-1',
      text: 'hello',
      logContext: 'test',
    });

    expect(delivered).toEqual(['discord']);
    expect(mockDiscordPostMessage).toHaveBeenCalledWith({
      channelId: 'discord-dm-1',
      text: 'hello',
      textFormat: 'markdown',
    });
  });

  it('skips providers the user has not linked without failing the rest', async () => {
    mockSlackUserMappingsFindFirst.mockResolvedValue(undefined);
    mockTeamsUserMappingsFindFirst.mockResolvedValue(undefined);
    mockDiscordUserMappingsFindFirst.mockResolvedValue(undefined);

    const delivered = await sendUserDirectMessageBestEffort({
      userId: 'user-1',
      text: 'hello',
      logContext: 'test',
    });

    expect(delivered).toEqual(['telegram']);
    expect(mockSlackPostMessage).not.toHaveBeenCalled();
    expect(mockPostDirectMessage).not.toHaveBeenCalled();
  });

  it('skips a provider whose credentials are not configured', async () => {
    mockSlackUserMappingsFindFirst.mockResolvedValue(undefined);
    mockTeamsUserMappingsFindFirst.mockResolvedValue(undefined);
    vi.mocked(
      createTelegramCommunicationProviderFromRuntimeCredentials,
    ).mockResolvedValueOnce(null);

    const delivered = await sendUserDirectMessageBestEffort({
      userId: 'user-1',
      text: 'hello',
      logContext: 'test',
    });

    expect(delivered).toEqual(['discord']);
    expect(mockTelegramPostMessage).not.toHaveBeenCalled();
  });

  it('falls through after a provider error and stops on the next success', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSlackPostMessage.mockRejectedValue(new Error('slack is down'));

    const delivered = await sendUserDirectMessageBestEffort({
      userId: 'user-1',
      text: 'hello',
      logContext: 'test',
    });

    expect(delivered).toEqual(['teams']);
    expect(warnSpy).toHaveBeenCalledWith(
      '[test] Failed to send Slack DM: slack is down',
    );
    expect(mockTelegramPostMessage).not.toHaveBeenCalled();
    expect(mockDiscordPostMessage).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('reuses a successful provider thread for the next Session notification', async () => {
    const first = await sendUserDirectMessageBestEffortWithReceipts({
      userId: 'user-1',
      text: 'First response',
      logContext: 'test',
    });
    mockSlackPostMessage.mockResolvedValueOnce('1720000000.000200');

    const second = await sendUserDirectMessageBestEffortWithReceipts({
      userId: 'user-1',
      text: 'Second response',
      logContext: 'test',
      replyAnchor: first.receipts[0]!,
    });

    expect(second.deliveredProviders).toEqual(['slack']);
    expect(mockSlackPostMessage).toHaveBeenLastCalledWith({
      channel: 'D123',
      text: 'Second response',
      blocks: [{ type: 'markdown', text: 'Second response' }],
      thread_ts: '1720000000.000100',
    });
    expect(mockOpenConversation).toHaveBeenCalledTimes(1);
    expect(mockPostDirectMessage).not.toHaveBeenCalled();
  });

  it('uses the standard Slack footer carrier for the first notification and relocates it later', async () => {
    const presentation = {
      sessionId: 'session-1',
      initialUserMessage: {
        senderDisplayName: 'Taylor',
        text: 'What time is it?',
      },
    };
    const first = await sendUserDirectMessageBestEffortWithReceipts({
      userId: 'user-1',
      text: 'It is 4:15 PM.',
      logContext: 'test',
      presentation,
    });

    expect(mockPostSlackRootWithFooter).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'D123',
        text: expect.stringContaining('Taylor'),
        footerText: expect.stringContaining('Reply anytime'),
      }),
    );
    await sendUserDirectMessageBestEffortWithReceipts({
      userId: 'user-1',
      text: 'A later response.',
      logContext: 'test',
      replyAnchor: first.receipts[0]!,
      presentation: { sessionId: 'session-1' },
    });
    expect(mockPostSlackThreadWithFooter).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'D123',
        threadTs: '1720000000.000100',
        text: 'A later response.',
        footerText: expect.stringContaining('Reply anytime'),
      }),
    );
  });

  it('uses the shared managed footer delivery after falling through to Teams', async () => {
    mockSlackUserMappingsFindFirst.mockResolvedValue(undefined);
    mockCreateTeamsDirectMessage.mockResolvedValue({ channelId: 'teams-dm-1' });

    await expect(
      sendUserDirectMessageBestEffortWithReceipts({
        userId: 'user-1',
        text: 'It is ready.',
        logContext: 'test',
        presentation: { sessionId: 'session-1' },
      }),
    ).resolves.toMatchObject({ deliveredProviders: ['teams'] });

    expect(mockPostTextWithFooter).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          channelId: 'teams-dm-1',
          text: 'It is ready.',
        }),
        footerText: expect.stringContaining('Reply anytime'),
      }),
    );
    expect(mockSetFooterRecord).toHaveBeenCalledWith(
      'teams',
      'teams-dm-1',
      'teams-message-1',
      expect.objectContaining({ messageId: 'teams-message-1' }),
    );
  });

  it('continues AgentMail notifications through the stored conversation', async () => {
    mockAgentMailPostMessage.mockResolvedValue({
      messageId: 'email-message-2',
      threadId: 'email-thread-1',
    });

    await expect(
      sendUserDirectMessageBestEffortWithReceipts({
        userId: 'user-1',
        text: 'Second response',
        logContext: 'test',
        replyAnchor: {
          provider: 'agentmail',
          workspaceId: 'roomote@example.com',
          channelId: 'email-conversation-1',
          messageId: 'email-message-1',
          threadId: 'email-thread-1',
        },
      }),
    ).resolves.toEqual({
      deliveredProviders: ['agentmail'],
      receipts: [
        {
          provider: 'agentmail',
          workspaceId: 'roomote@example.com',
          channelId: 'email-conversation-1',
          messageId: 'email-message-2',
          threadId: 'email-thread-1',
        },
      ],
    });
    expect(mockAgentMailPostMessage).toHaveBeenCalledWith({
      channelId: 'roomote@example.com',
      threadId: 'email-conversation-1',
      text: 'Second response',
      textFormat: 'markdown',
    });
    expect(mockSlackPostMessage).not.toHaveBeenCalled();
  });
});

describe('hasAnyUserDirectMessageIdentity', () => {
  it('returns false when the user has no personal destination', async () => {
    mockSlackInstallationsFindMany.mockResolvedValue([]);
    mockTeamsUserMappingsFindFirst.mockResolvedValue(undefined);
    mockTelegramUserMappingsFindFirst.mockResolvedValue(undefined);
    mockDiscordUserMappingsFindFirst.mockResolvedValue(undefined);
    mockCanStartAgentMailConversation.mockResolvedValue(false);

    await expect(hasAnyUserDirectMessageIdentity('user-1')).resolves.toBe(
      false,
    );
  });
});
