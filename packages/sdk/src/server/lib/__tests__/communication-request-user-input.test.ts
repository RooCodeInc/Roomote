const mocks = vi.hoisted(() => ({
  buildButtons: vi.fn(),
  buildPrompt: vi.fn(),
  getAdapter: vi.fn(),
  getPending: vi.fn(),
  postMessage: vi.fn(),
  setPending: vi.fn(),
}));

vi.mock('@roomote/communication', () => ({
  buildDiscordRequestUserInputButtons: mocks.buildButtons,
  buildDiscordRequestUserInputPromptText: mocks.buildPrompt,
  getCommunicationRequestUserInputConversationId: vi.fn(() => 'conversation-1'),
  getPendingCommunicationRequestUserInput: mocks.getPending,
  setPendingCommunicationRequestUserInput: mocks.setPending,
}));

vi.mock('@roomote/types', () => ({
  getCommunicationChannelFromTaskPayload: vi.fn(() => 'channel-1'),
  getCommunicationProviderFromTaskPayload: vi.fn((payload) => payload.provider),
  getCommunicationServiceUrlFromTaskPayload: vi.fn(() => null),
  getCommunicationThreadIdFromTaskPayload: vi.fn(() => null),
}));

vi.mock('../communication-providers', () => ({
  getCommunicationProviderAdapter: mocks.getAdapter,
}));

import { publishCommunicationRequestUserInput } from '../communication-request-user-input';

const question = {
  id: 'question-1',
  header: 'Question',
  question: 'Choose one',
  isOther: false,
  isSecret: false,
  options: [{ label: 'One', description: '' }],
};

describe('publishCommunicationRequestUserInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPending.mockResolvedValue(null);
    mocks.setPending.mockResolvedValue(undefined);
    mocks.buildPrompt.mockReturnValue('prompt');
    mocks.buildButtons.mockReturnValue([[{ text: 'One' }]]);
    mocks.postMessage.mockResolvedValue({ messageId: 'prompt-1' });
    mocks.getAdapter.mockResolvedValue({ postMessage: mocks.postMessage });
  });

  it('uses the wizard renderer only for Discord', async () => {
    for (const provider of ['discord', 'telegram', 'teams'] as const) {
      await publishCommunicationRequestUserInput({
        runId: 1,
        taskId: 'task-1',
        payload: { provider },
        request: { requestId: 'request-1', questions: [question, question] },
      });
    }

    expect(mocks.buildPrompt).toHaveBeenNthCalledWith(
      1,
      expect.not.objectContaining({ showAllQuestions: true }),
    );
    expect(mocks.buildPrompt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ showAllQuestions: true }),
    );
    expect(mocks.buildPrompt).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ showAllQuestions: true }),
    );
    expect(mocks.postMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ buttons: [[{ text: 'One' }]] }),
    );
    expect(mocks.postMessage).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ buttons: expect.anything() }),
    );
    expect(mocks.postMessage).toHaveBeenNthCalledWith(
      3,
      expect.not.objectContaining({ buttons: expect.anything() }),
    );
  });

  it('keeps Telegram buttons for a single-question prompt', async () => {
    await publishCommunicationRequestUserInput({
      runId: 1,
      taskId: 'task-1',
      payload: { provider: 'telegram' },
      request: { requestId: 'request-1', questions: [question] },
    });

    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ buttons: [[{ text: 'One' }]] }),
    );
  });

  it('keeps Telegram Cancel available for an empty prompt', async () => {
    mocks.buildButtons.mockReturnValue([[{ text: 'Cancel' }]]);

    await publishCommunicationRequestUserInput({
      runId: 1,
      taskId: 'task-1',
      payload: { provider: 'telegram' },
      request: { requestId: 'request-1', questions: [] },
    });

    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ buttons: [[{ text: 'Cancel' }]] }),
    );
  });
});
