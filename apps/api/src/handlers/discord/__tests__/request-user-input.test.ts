const mocks = vi.hoisted(() => ({
  advance: vi.fn(),
  buildButtons: vi.fn(),
  buildPrompt: vi.fn(),
  getCurrentQuestion: vi.fn(),
  getPending: vi.fn(),
  parseAnswerCallback: vi.fn(),
  parseCancelCallback: vi.fn(),
  reply: vi.fn(),
  setTrustedRunActingUserOnSuccess: vi.fn(),
  submit: vi.fn(),
}));

vi.mock('@roomote/communication', () => ({
  advancePendingCommunicationRequestUserInputQuestion: mocks.advance,
  buildDiscordAnsweredRequestUserInputText: vi.fn(),
  buildDiscordCancelledRequestUserInputText: vi.fn(),
  buildDiscordRequestUserInputButtons: mocks.buildButtons,
  buildDiscordRequestUserInputPromptText: mocks.buildPrompt,
  clearPendingCommunicationRequestUserInput: vi.fn(),
  getDiscordRequestUserInputCurrentQuestion: mocks.getCurrentQuestion,
  getPendingCommunicationRequestUserInput: mocks.getPending,
  parseDiscordRequestUserInputAnswerCallbackData: mocks.parseAnswerCallback,
  parseDiscordRequestUserInputCancelCallbackData: mocks.parseCancelCallback,
  submitPendingCommunicationRequestUserInputAnswer: mocks.submit,
}));

vi.mock('@roomote/db/server', () => ({
  setTrustedRunActingUserOnSuccess: mocks.setTrustedRunActingUserOnSuccess,
}));

vi.mock('../replies.js', () => ({ replyToDiscordEvent: mocks.reply }));
vi.mock('../../../logging.js', () => ({ apiLogger: { warn: vi.fn() } }));

import { tryHandleDiscordRequestUserInputCallback } from '../request-user-input.js';

const firstQuestion = {
  id: 'first',
  header: 'First',
  question: 'Choose the first answer',
  isOther: false,
  isSecret: false,
  options: [{ label: 'First option', description: '' }],
};

const secondQuestion = {
  ...firstQuestion,
  id: 'second',
  question: 'Choose the second answer',
  options: [{ label: 'Second option', description: '' }],
};

function pendingRequest(currentQuestionIndex = 0) {
  return {
    requestId: 'request-quest123',
    runId: 42,
    taskId: 'task-1',
    provider: 'discord' as const,
    conversationId: 'thread-1',
    questions: [firstQuestion, secondQuestion],
    status: 'pending' as const,
    promptMessageId: 'prompt-1',
    currentQuestionIndex,
    answers: currentQuestionIndex
      ? { first: { answers: ['First option'] } }
      : {},
    createdAt: Date.now(),
  };
}

describe('Discord request_user_input callbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parseAnswerCallback.mockReturnValue({
      runId: 42,
      questionIndex: 0,
      optionIndex: 0,
      requestToken: 'quest123',
    });
    mocks.parseCancelCallback.mockReturnValue(null);
    mocks.buildPrompt.mockReturnValue('NEXT PROMPT');
    mocks.buildButtons.mockReturnValue([[{ text: 'Second option' }]]);
    mocks.reply.mockResolvedValue(undefined);
    mocks.advance.mockResolvedValue(true);
    mocks.submit.mockResolvedValue(true);
    mocks.setTrustedRunActingUserOnSuccess.mockImplementation(
      async ({ operation }: { operation: () => Promise<boolean> }) =>
        operation(),
    );
  });

  function callbackParams(provider: { editMessage: ReturnType<typeof vi.fn> }) {
    return {
      provider: provider as never,
      applicationId: 'app-1',
      channel: { channelId: 'thread-1' } as never,
      interaction: { id: 'interaction-1' } as never,
      interactionDeferred: true,
      customId: 'discord:rui:42:0:0:quest123',
      userId: 'user-1',
    };
  }

  it('advances and edits the prompt after a non-final button answer', async () => {
    const request = pendingRequest();
    const provider = { editMessage: vi.fn().mockResolvedValue(undefined) };
    mocks.getPending.mockResolvedValue(request);
    mocks.getCurrentQuestion.mockReturnValue({
      question: firstQuestion,
      questionIndex: 0,
    });

    await tryHandleDiscordRequestUserInputCallback(callbackParams(provider));

    expect(mocks.advance).toHaveBeenCalledWith(
      'discord',
      'thread-1',
      request,
      1,
      { first: { answers: ['First option'] } },
    );
    expect(provider.editMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'prompt-1', text: 'NEXT PROMPT' }),
    );
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Picked: First option',
        ephemeral: true,
      }),
    );
  });

  it('submits accumulated answers after the final button answer', async () => {
    const request = pendingRequest(1);
    const provider = { editMessage: vi.fn().mockResolvedValue(undefined) };
    mocks.getPending.mockResolvedValue(request);
    mocks.getCurrentQuestion.mockReturnValue({
      question: secondQuestion,
      questionIndex: 1,
    });
    mocks.parseAnswerCallback.mockReturnValue({
      runId: 42,
      questionIndex: 1,
      optionIndex: 0,
      requestToken: 'quest123',
    });

    await tryHandleDiscordRequestUserInputCallback(callbackParams(provider));

    expect(mocks.advance).not.toHaveBeenCalled();
    expect(mocks.submit).toHaveBeenCalledWith(
      'discord',
      'thread-1',
      request,
      expect.objectContaining({
        answers: {
          first: { answers: ['First option'] },
          second: { answers: ['Second option'] },
        },
      }),
    );
  });

  it('notifies a losing advance claim without editing the prompt', async () => {
    const provider = { editMessage: vi.fn().mockResolvedValue(undefined) };
    mocks.getPending.mockResolvedValue(pendingRequest());
    mocks.getCurrentQuestion.mockReturnValue({
      question: firstQuestion,
      questionIndex: 0,
    });
    mocks.advance.mockResolvedValue(false);

    await tryHandleDiscordRequestUserInputCallback(callbackParams(provider));

    expect(provider.editMessage).not.toHaveBeenCalled();
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'I already received your answer. Please wait for the agent to continue.',
      }),
    );
  });

  it('shows the next question when editing the existing prompt fails', async () => {
    const provider = {
      editMessage: vi.fn().mockRejectedValue(new Error('gone')),
    };
    mocks.getPending.mockResolvedValue(pendingRequest());
    mocks.getCurrentQuestion.mockReturnValue({
      question: firstQuestion,
      questionIndex: 0,
    });

    await tryHandleDiscordRequestUserInputCallback(callbackParams(provider));

    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Picked: First option\n\nNEXT PROMPT',
        ephemeral: true,
      }),
    );
  });
});
