const {
  advancePendingSlackRequestUserInputQuestionMock,
  authorizeSlackRunReplyTargetMock,
  deliveryTrackerCommitMock,
  deliveryTrackerTrackMock,
  deliverPendingSlackRequestUserInputQuestionMock,
  getPendingSlackRequestUserInputMock,
  parseAcpRequestUserInputAnswerReplyMock,
} = vi.hoisted(() => ({
  advancePendingSlackRequestUserInputQuestionMock: vi.fn(),
  authorizeSlackRunReplyTargetMock: vi.fn(),
  deliveryTrackerCommitMock: vi.fn(),
  deliveryTrackerTrackMock: vi.fn(),
  deliverPendingSlackRequestUserInputQuestionMock: vi.fn(),
  getPendingSlackRequestUserInputMock: vi.fn(),
  parseAcpRequestUserInputAnswerReplyMock: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: { R_APP_URL: 'http://localhost:3000' },
}));

vi.mock('@roomote/types', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/types')>()),
  parseAcpRequestUserInputAnswerReply: parseAcpRequestUserInputAnswerReplyMock,
}));

vi.mock('@roomote/cloud-agents', () => ({
  stripLeadingRawSlackMention: vi.fn((text: string) => text),
  stripLeadingSlackProductMention: vi.fn((text: string) => text),
}));

vi.mock('@roomote/slack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/slack')>()),
  advancePendingSlackRequestUserInputQuestion:
    advancePendingSlackRequestUserInputQuestionMock,
  authorizeSlackRunReplyTarget: authorizeSlackRunReplyTargetMock,
  deliverPendingSlackRequestUserInputQuestion:
    deliverPendingSlackRequestUserInputQuestionMock,
  getPendingSlackRequestUserInput: getPendingSlackRequestUserInputMock,
  getSlackRequestUserInputCurrentQuestion: vi.fn((request) => ({
    question: request.questions[request.currentQuestionIndex],
    questionIndex: request.currentQuestionIndex,
  })),
  SlackThreadDeliveryTracker: class {
    commit = deliveryTrackerCommitMock;
    rollback = vi.fn();
    track = deliveryTrackerTrackMock;
  },
}));

vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  setTrustedRunActingUserOnSuccess: vi.fn(),
}));

import { processActiveRunMessage } from './active-run';

describe('typed Slack request_user_input replies', () => {
  const questions = [
    {
      id: 'language',
      header: 'Language',
      question: 'Which language should I use?',
      isOther: true,
      isSecret: false,
      options: [{ label: 'TypeScript', description: 'Use the app stack.' }],
    },
    {
      id: 'style',
      header: 'Style',
      question: 'What should the UI optimize for?',
      isOther: true,
      isSecret: false,
      options: [{ label: 'Dashboard', description: 'Pane-first interface.' }],
    },
  ];
  const pendingRequest = {
    requestId: 'rui:session:turn:call',
    runId: 42,
    taskId: 'task-1',
    promptMessageTs: 'prompt-ts',
    questions,
    currentQuestionIndex: 0,
    answers: {},
    status: 'pending' as const,
    createdAt: 123,
  };
  const event = {
    type: 'message',
    channel: 'C123',
    channel_type: 'channel',
    thread_ts: '111.222',
    user: 'U123',
    ts: '333.444',
    text: 'TypeScript',
  } as never;
  const activeRun = {
    id: 42,
    actingUserId: 'user-1',
    result: null,
    taskId: 'task-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getPendingSlackRequestUserInputMock.mockResolvedValue(pendingRequest);
    authorizeSlackRunReplyTargetMock.mockResolvedValue(undefined);
    advancePendingSlackRequestUserInputQuestionMock.mockResolvedValue(true);
    deliverPendingSlackRequestUserInputQuestionMock.mockResolvedValue(
      undefined,
    );
    deliveryTrackerCommitMock.mockResolvedValue(undefined);
    parseAcpRequestUserInputAnswerReplyMock
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        resolution: 'answered',
        answers: { language: { answers: ['TypeScript'] } },
      });
  });

  it('routes delivery through the shared lifecycle after advancing once', async () => {
    const slack = {
      normalizeIncomingText: vi.fn(async (text: string) => text),
      postMessage: vi.fn(),
      updateMessage: vi.fn(),
    };

    await processActiveRunMessage(
      event,
      slack as never,
      'user-1',
      activeRun,
      'T123',
    );

    expect(
      advancePendingSlackRequestUserInputQuestionMock,
    ).toHaveBeenCalledTimes(1);
    expect(
      deliverPendingSlackRequestUserInputQuestionMock,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        slack,
        channel: 'C123',
        threadId: '111.222',
        request: expect.objectContaining({
          currentQuestionIndex: 1,
          answers: { language: { answers: ['TypeScript'] } },
        }),
        previousQuestion: questions[0],
        previousAnswer: 'TypeScript',
      }),
    );
    expect(slack.updateMessage).not.toHaveBeenCalled();
    expect(slack.postMessage).not.toHaveBeenCalled();
  });

  it('does not retire the prompt directly when shared delivery fails', async () => {
    const slack = {
      normalizeIncomingText: vi.fn(async (text: string) => text),
      postMessage: vi.fn(),
      updateMessage: vi.fn(),
    };
    deliverPendingSlackRequestUserInputQuestionMock.mockRejectedValueOnce(
      new Error('next prompt delivery failed'),
    );

    await expect(
      processActiveRunMessage(
        event,
        slack as never,
        'user-1',
        activeRun,
        'T123',
      ),
    ).rejects.toThrow('next prompt delivery failed');

    expect(
      advancePendingSlackRequestUserInputQuestionMock,
    ).toHaveBeenCalledTimes(1);
    expect(slack.updateMessage).not.toHaveBeenCalled();
    expect(slack.postMessage).not.toHaveBeenCalled();
  });
});
