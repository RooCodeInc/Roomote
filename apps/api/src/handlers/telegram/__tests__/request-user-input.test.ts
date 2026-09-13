const mocks = vi.hoisted(() => ({
  getPending: vi.fn(),
  clearPending: vi.fn(),
  parseAnswer: vi.fn(),
  retirePrompt: vi.fn(),
  submitPending: vi.fn(),
  setActingUser: vi.fn(),
  createProvider: vi.fn(),
  editMessageText: vi.fn(),
}));

vi.mock('@roomote/communication', () => ({
  buildDiscordAnsweredRequestUserInputText: vi.fn(
    ({ answer }) => `**Picked:** ${answer}`,
  ),
  buildDiscordCancelledRequestUserInputText: vi.fn(),
  getDiscordRequestUserInputCurrentQuestion: vi.fn(),
  getPendingCommunicationRequestUserInput: mocks.getPending,
  clearPendingCommunicationRequestUserInput: mocks.clearPending,
  parseDiscordRequestUserInputAnswerCallbackData: vi.fn(),
  parseDiscordRequestUserInputCancelCallbackData: vi.fn(),
  submitPendingCommunicationRequestUserInputAnswer: mocks.submitPending,
}));

vi.mock('@roomote/types', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/types')>()),
  parseAcpRequestUserInputAnswerReply: mocks.parseAnswer,
}));

vi.mock('@roomote/db/server', () => ({
  setTrustedRunActingUserOnSuccess: mocks.setActingUser,
}));

vi.mock('@roomote/sdk/server', () => ({
  createTelegramCommunicationProviderFromRuntimeCredentials:
    mocks.createProvider,
  retireTelegramRequestUserInputPromptBestEffort: mocks.retirePrompt,
}));

vi.mock('../replies.js', () => ({
  answerTelegramCallbackQueryBestEffort: vi.fn(),
  postTelegramMessageBestEffort: vi.fn(),
}));

import { tryHandleTelegramRequestUserInputMessage } from '../request-user-input.js';

describe('Telegram request_user_input messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPending.mockResolvedValue({
      requestId: 'request-1',
      runId: 42,
      taskId: 'task-1',
      provider: 'telegram',
      conversationId: 'topic-1',
      questions: [
        {
          id: 'choice',
          header: 'Choice',
          question: 'Pick one',
          options: [{ label: 'One', description: 'First' }],
        },
      ],
      status: 'pending',
      promptMessageId: 'message-1',
      createdAt: 1,
    });
    mocks.clearPending.mockResolvedValue(true);
    mocks.parseAnswer.mockReturnValue(null);
    mocks.retirePrompt.mockResolvedValue(undefined);
    mocks.submitPending.mockResolvedValue(true);
    mocks.setActingUser.mockImplementation(({ operation }) => operation());
    mocks.editMessageText.mockResolvedValue(undefined);
    mocks.createProvider.mockResolvedValue({
      editMessageText: mocks.editMessageText,
    });
  });

  it('retires an unanswered prompt when an unrelated message supersedes it', async () => {
    await expect(
      tryHandleTelegramRequestUserInputMessage({
        activeRunId: 42,
        userId: 'user-1',
        text: 'Do something else instead',
        chatId: 'chat-1',
        threadId: 'topic-1',
      }),
    ).resolves.toBe(false);

    expect(mocks.clearPending).toHaveBeenCalledWith('telegram', 'topic-1', {
      requestId: 'request-1',
      runId: 42,
    });
    expect(mocks.retirePrompt).toHaveBeenCalledWith({
      channelId: 'chat-1',
      threadId: 'topic-1',
      messageId: 'message-1',
    });
  });

  it('does not retire a replacement request that wins the clear race', async () => {
    mocks.clearPending.mockResolvedValue(false);

    await tryHandleTelegramRequestUserInputMessage({
      activeRunId: 42,
      userId: 'user-1',
      text: 'Do something else instead',
      chatId: 'chat-1',
      threadId: 'topic-1',
    });

    expect(mocks.retirePrompt).not.toHaveBeenCalled();
  });

  it('retires durable controls before rendering a rich confirmation', async () => {
    mocks.parseAnswer.mockReturnValue({
      resolution: 'answered',
      answers: { choice: { answers: ['One'] } },
    });

    await expect(
      tryHandleTelegramRequestUserInputMessage({
        activeRunId: 42,
        userId: 'user-1',
        text: '1',
        chatId: 'chat-1',
        threadId: 'topic-1',
      }),
    ).resolves.toBe(true);

    expect(mocks.retirePrompt).toHaveBeenCalledWith({
      channelId: 'chat-1',
      threadId: 'topic-1',
      messageId: 'message-1',
    });
    expect(mocks.editMessageText).toHaveBeenCalledWith({
      channelId: 'chat-1',
      messageId: 'message-1',
      text: '**Picked:** One',
      textFormat: 'markdown',
      buttons: [],
    });
    expect(mocks.retirePrompt.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.editMessageText.mock.invocationCallOrder[0]!,
    );
  });
});
