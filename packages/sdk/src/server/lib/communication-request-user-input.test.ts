const mocks = vi.hoisted(() => ({
  getPending: vi.fn(),
  setPending: vi.fn(),
  getFooter: vi.fn(),
  setFooter: vi.fn(),
  postMessage: vi.fn(),
  editMessageText: vi.fn(),
  editMessageReplyMarkup: vi.fn(),
  getAdapter: vi.fn(),
}));

vi.mock('@roomote/communication', () => ({
  buildDiscordRequestUserInputButtons: vi.fn(() => [
    [{ text: 'One', callbackData: 'rui:one' }],
  ]),
  buildDiscordRequestUserInputPromptText: vi.fn(
    () =>
      'Which treatment?\n\n1. **One** — First option\n\n_Pick a button or `cancel`._',
  ),
  getCommunicationRequestUserInputConversationId: vi.fn(
    ({ threadId, channelId }) => threadId || channelId || null,
  ),
  getPendingCommunicationRequestUserInput: mocks.getPending,
  setPendingCommunicationRequestUserInput: mocks.setPending,
  getThreadReplyFooterRecord: mocks.getFooter,
  setThreadReplyFooterRecord: mocks.setFooter,
  withThreadReplyFooterLock: vi.fn(async ({ fn }) =>
    fn(
      vi.fn(async () => undefined),
      { token: 'lock' },
    ),
  ),
}));

vi.mock('./communication-providers', () => ({
  getCommunicationProviderAdapter: mocks.getAdapter,
}));

import {
  publishCommunicationRequestUserInput,
  retireTelegramRequestUserInputPromptBestEffort,
} from './communication-request-user-input';

describe('Telegram communication request_user_input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPending.mockResolvedValue(null);
    mocks.setPending.mockResolvedValue(undefined);
    mocks.postMessage.mockResolvedValue({
      provider: 'telegram',
      channelId: 'chat-1',
      messageId: 'message-1',
    });
    mocks.editMessageText.mockResolvedValue(undefined);
    mocks.editMessageReplyMarkup.mockResolvedValue(undefined);
    mocks.getAdapter.mockResolvedValue({
      provider: 'telegram',
      postMessage: mocks.postMessage,
      editMessageText: mocks.editMessageText,
      editMessageReplyMarkup: mocks.editMessageReplyMarkup,
    });
  });

  const payload = {
    communicationProvider: 'telegram',
    communicationChannelId: 'chat-1',
    communicationThreadId: 'topic-1',
  };
  const request = {
    requestId: 'request-1',
    questions: [
      {
        id: 'question-1',
        header: 'Treatment',
        question: 'Which treatment?',
        options: [{ label: 'One', description: 'First option' }],
        isOther: false,
        isSecret: false,
      },
    ],
  };

  it('posts elicitation copy as Telegram rich Markdown', async () => {
    await publishCommunicationRequestUserInput({
      runId: 42,
      taskId: 'task-1',
      payload,
      request,
    });

    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'chat-1',
        threadId: 'topic-1',
        text: expect.stringContaining('**One**'),
        textFormat: 'markdown',
      }),
    );
  });

  it('edits enriched elicitation copy as Telegram rich Markdown', async () => {
    mocks.getPending.mockResolvedValue({
      requestId: 'request-1',
      runId: 42,
      taskId: 'task-1',
      provider: 'telegram',
      conversationId: 'topic-1',
      questions: request.questions,
      status: 'pending',
      promptMessageId: 'message-1',
      currentQuestionIndex: 0,
      createdAt: 1,
    });

    await publishCommunicationRequestUserInput({
      runId: 42,
      taskId: 'task-1',
      payload,
      request,
    });

    expect(mocks.editMessageText).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'chat-1',
        messageId: 'message-1',
        textFormat: 'markdown',
      }),
    );
  });

  it('retires live and persisted controls under the managed-footer lock', async () => {
    mocks.getFooter.mockResolvedValue({
      messageId: 'message-1',
      textWithoutFooter: 'Question',
      buttons: [[{ text: 'One', callbackData: 'rui:one' }]],
      refresh: { footerText: 'Reply anytime', channelId: 'chat-1' },
    });
    mocks.setFooter.mockResolvedValue(true);

    await retireTelegramRequestUserInputPromptBestEffort({
      channelId: 'chat-1',
      threadId: 'topic-1',
      messageId: 'message-1',
    });

    expect(mocks.setFooter).toHaveBeenCalledWith(
      'telegram',
      'chat-1',
      'topic-1',
      {
        messageId: 'message-1',
        textWithoutFooter: 'Question',
        refresh: { footerText: 'Reply anytime', channelId: 'chat-1' },
      },
      expect.objectContaining({ keepTtl: true }),
    );
    expect(mocks.editMessageReplyMarkup).toHaveBeenCalledWith({
      channelId: 'chat-1',
      messageId: 'message-1',
    });
    expect(mocks.setFooter.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.editMessageReplyMarkup.mock.invocationCallOrder[0]!,
    );
  });
});
