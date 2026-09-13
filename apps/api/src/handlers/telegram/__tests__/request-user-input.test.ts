const mocks = vi.hoisted(() => ({
  getPending: vi.fn(),
  clearPending: vi.fn(),
  parseAnswer: vi.fn(),
  retirePrompt: vi.fn(),
  submitPending: vi.fn(),
  setActingUser: vi.fn(),
  postMessage: vi.fn(),
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
  retireTelegramRequestUserInputPromptBestEffort: mocks.retirePrompt,
}));

vi.mock('../replies.js', () => ({
  answerTelegramCallbackQueryBestEffort: vi.fn(),
  postTelegramMessageBestEffort: mocks.postMessage,
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
    mocks.retirePrompt.mockResolvedValue(true);
    mocks.submitPending.mockResolvedValue(true);
    mocks.setActingUser.mockImplementation(({ operation }) => operation());
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

  it('retires durable controls while rendering a rich confirmation', async () => {
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
    ).resolves.toBe('submitted');

    expect(mocks.retirePrompt).toHaveBeenCalledWith({
      channelId: 'chat-1',
      threadId: 'topic-1',
      messageId: 'message-1',
      replacementText: '**Picked:** One',
    });
    expect(mocks.retirePrompt).toHaveBeenCalledTimes(1);
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it('posts the confirmation when prompt replacement fails', async () => {
    mocks.parseAnswer.mockReturnValue({
      resolution: 'answered',
      answers: { choice: { answers: ['One'] } },
    });
    mocks.retirePrompt.mockResolvedValue(false);

    await tryHandleTelegramRequestUserInputMessage({
      activeRunId: 42,
      userId: 'user-1',
      text: '1',
      chatId: 'chat-1',
      threadId: 'topic-1',
    });

    expect(mocks.postMessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: 'topic-1',
      text: '**Picked:** One',
      textFormat: 'markdown',
    });
  });
});
