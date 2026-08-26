const {
  advancePendingSlackRequestUserInputQuestionMock,
  clearTaskResolutionMock,
  clearPendingSlackRequestUserInputMock,
  findActiveSlackTaskRunMock,
  fetchThreadMessagesMock,
  getPendingSlackRequestUserInputMock,
  mockDbUpdate,
  mockDbUpdateReturning,
  mockDbUpdateSet,
  mockDbUpdateWhere,
  mockGetSlackThreadFooterText,
  postMessageMock,
  promptSlackAccountLinkMock,
  queueSlackMessageMock,
  selectLimitMock,
  setPendingSlackRequestUserInputPromptMessageTsMock,
  setTrustedRunActingUserMock,
  setTrustedRunActingUserOnSuccessMock,
  submitPendingSlackRequestUserInputAnswerMock,
  updateMessageMock,
} = vi.hoisted(() => ({
  advancePendingSlackRequestUserInputQuestionMock: vi.fn(),
  clearTaskResolutionMock: vi.fn(),
  clearPendingSlackRequestUserInputMock: vi.fn(),
  findActiveSlackTaskRunMock: vi.fn(),
  fetchThreadMessagesMock: vi.fn().mockResolvedValue([
    {
      user: 'U123',
      text: 'Which language should I use?',
      ts: '111.222',
      thread_ts: '111.222',
      type: 'message',
    },
  ]),
  getPendingSlackRequestUserInputMock: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbUpdateReturning: vi.fn(),
  mockDbUpdateSet: vi.fn(),
  mockDbUpdateWhere: vi.fn(),
  mockGetSlackThreadFooterText: vi
    .fn()
    .mockResolvedValue(
      '_Reply or use the <http://localhost:13000/task/task-1|web app>._',
    ),
  postMessageMock: vi.fn(),
  promptSlackAccountLinkMock: vi.fn(),
  queueSlackMessageMock: vi.fn(),
  selectLimitMock: vi.fn(),
  setPendingSlackRequestUserInputPromptMessageTsMock: vi.fn(),
  setTrustedRunActingUserMock: vi.fn(),
  setTrustedRunActingUserOnSuccessMock: vi.fn(
    async ({ operation }: { operation: () => Promise<boolean> }) =>
      await operation(),
  ),
  submitPendingSlackRequestUserInputAnswerMock: vi.fn(),
  updateMessageMock: vi.fn().mockResolvedValue(true),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  clearTaskResolution: clearTaskResolutionMock,
  taskRuns: {
    id: 'task_run_id',
    taskId: 'task_id',
    result: 'result',
  },
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: selectLimitMock,
        })),
      })),
    })),
    update: mockDbUpdate,
  },
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  })),
  recordTaskKickoffMessageBestEffort: vi.fn().mockResolvedValue(undefined),
  slackInstallations: { teamId: 'teamId' },
  slackUserMappings: { slackTeamId: 'slackTeamId', slackUserId: 'slackUserId' },
  setTrustedRunActingUser: setTrustedRunActingUserMock,
  setTrustedRunActingUserOnSuccess: setTrustedRunActingUserOnSuccessMock,
}));

vi.mock('../find-active-slack-task-run', () => ({
  findActiveSlackTaskRun: findActiveSlackTaskRunMock,
}));

vi.mock('../block-kit', async () => {
  const actual =
    await vi.importActual<typeof import('../block-kit')>('../block-kit');

  return {
    ...actual,
    promptSlackAccountLink: promptSlackAccountLinkMock,
  };
});

vi.mock('../request-user-input', () => ({
  advancePendingSlackRequestUserInputQuestion:
    advancePendingSlackRequestUserInputQuestionMock,
  clearPendingSlackRequestUserInput: clearPendingSlackRequestUserInputMock,
  getPendingSlackRequestUserInput: getPendingSlackRequestUserInputMock,
  setPendingSlackRequestUserInputPromptMessageTs:
    setPendingSlackRequestUserInputPromptMessageTsMock,
  submitPendingSlackRequestUserInputAnswer:
    submitPendingSlackRequestUserInputAnswerMock,
}));

vi.mock('../slack-messages', () => ({
  queueSlackMessage: queueSlackMessageMock,
  setQueuedSlackStartedMessageTs: vi.fn(),
}));

vi.mock('../slack-notifier', () => ({
  SlackNotifier: vi.fn().mockImplementation(function () {
    return {
      fetchThreadMessages: fetchThreadMessagesMock,
      getMessagePermalink: vi.fn().mockResolvedValue(null),
      postMessage: postMessageMock,
      updateMessage: updateMessageMock,
    };
  }),
}));

vi.mock('../thread-footer', () => ({
  getSlackThreadFooterText: mockGetSlackThreadFooterText,
}));

import { handleFollowupAnswer } from '../handle-followup-answer';
import type { SlackInteractivePayload } from '../types';

function buildPayload(
  answerValue?: string,
  overrides?: Partial<SlackInteractivePayload>,
): SlackInteractivePayload {
  return {
    type: 'block_actions',
    team: {
      id: 'T123',
      domain: 'acme',
    },
    user: {
      id: 'U123',
      name: 'alice',
    },
    channel: {
      id: 'C123',
      name: 'general',
    },
    message: {
      ts: '111.222',
      thread_ts: '111.222',
    },
    actions: [
      {
        action_id: 'answer',
        type: 'button',
        text: { text: 'TypeScript' },
        value:
          answerValue ??
          JSON.stringify({
            requestId: 'rui:session:turn:call',
            questionId: 'language',
            questionIndex: 0,
            answer: 'TypeScript',
          }),
      },
    ],
    state: {
      values: {},
    },
    response_url: 'https://slack.test/response',
    trigger_id: 'trigger-123',
    ...overrides,
  };
}

describe('handleFollowupAnswer', () => {
  const fetchMock = vi.fn();
  const taskOrigin = process.env.R_APP_URL || 'http://localhost:13000';
  const consoleErrorMock = vi
    .spyOn(console, 'error')
    .mockImplementation(() => undefined);
  const consoleLogMock = vi
    .spyOn(console, 'log')
    .mockImplementation(() => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);

    findActiveSlackTaskRunMock.mockResolvedValue({
      id: 42,
      machineId: 'machine-1',
      taskId: 'task-1',
    });
    selectLimitMock.mockResolvedValue([{ userId: 'user-1' }]);
    clearPendingSlackRequestUserInputMock.mockResolvedValue(true);
    advancePendingSlackRequestUserInputQuestionMock.mockResolvedValue(true);
    fetchThreadMessagesMock.mockResolvedValue([
      {
        user: 'U123',
        text: 'Which language should I use?',
        ts: '111.222',
        thread_ts: '111.222',
        type: 'message',
      },
    ]);
    mockGetSlackThreadFooterText.mockResolvedValue(
      '_Reply or use the <http://localhost:13000/task/task-1|web app>._',
    );
    getPendingSlackRequestUserInputMock.mockResolvedValue({
      requestId: 'rui:session:turn:call',
      runId: 7,
      taskId: 'task-older',
      questions: [],
      currentQuestionIndex: 0,
      answers: {},
      status: 'pending',
      createdAt: Date.now(),
    });
    postMessageMock.mockResolvedValue('posted-ts');
    queueSlackMessageMock.mockResolvedValue(undefined);
    setPendingSlackRequestUserInputPromptMessageTsMock.mockResolvedValue(true);
    setTrustedRunActingUserMock.mockResolvedValue(undefined);
    submitPendingSlackRequestUserInputAnswerMock.mockResolvedValue(true);
    updateMessageMock.mockResolvedValue(true);
    promptSlackAccountLinkMock.mockResolvedValue({ dmPromptSent: true });
    fetchMock.mockResolvedValue({ ok: true });
    mockDbUpdate.mockReturnValue({ set: mockDbUpdateSet });
    mockDbUpdateSet.mockReturnValue({ where: mockDbUpdateWhere });
    mockDbUpdateWhere.mockReturnValue({ returning: mockDbUpdateReturning });
    mockDbUpdateReturning.mockResolvedValue([{ rejectionCount: 1 }]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    consoleErrorMock.mockRestore();
    consoleLogMock.mockRestore();
  });

  it('rejects structured answers for stale pending requests on a reused thread', async () => {
    await handleFollowupAnswer(buildPayload());

    expect(findActiveSlackTaskRunMock).toHaveBeenCalledWith('111.222', {
      slackTeamId: 'T123',
    });
    expect(clearPendingSlackRequestUserInputMock).toHaveBeenCalledWith(
      '111.222',
      {
        requestId: 'rui:session:turn:call',
      },
    );
    expect(submitPendingSlackRequestUserInputAnswerMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.test/response',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(consoleErrorMock).toHaveBeenCalledWith(
      expect.stringContaining(
        'This question belongs to an older task. Please ask the agent again.',
      ),
    );
  });

  it('prompts unlinked Slack users to connect before queueing a follow-up answer', async () => {
    selectLimitMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ teamId: 'T123', orgId: 'org-1' }]);

    await handleFollowupAnswer(buildPayload('Ship it'));

    expect(promptSlackAccountLinkMock).toHaveBeenCalledWith(
      expect.objectContaining({
        slackUserId: 'U123',
        channel: 'C123',
        threadTs: '111.222',
        originalText: 'Ship it',
        resumeOriginalThread: false,
      }),
    );
    expect(postMessageMock).toHaveBeenCalledWith({
      text: '<@U123> I sent you a DM to link your account.',
      channel: 'C123',
      thread_ts: '111.222',
    });
    expect(queueSlackMessageMock).not.toHaveBeenCalled();
    expect(submitPendingSlackRequestUserInputAnswerMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.test/response',
      expect.objectContaining({
        body: JSON.stringify({
          replace_original: false,
          text: 'Please link your Roomote account before using this button.',
        }),
      }),
    );
  });

  it('posts the fallback public thread reply when the account-link DM was not delivered', async () => {
    selectLimitMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ teamId: 'T123', orgId: 'org-1' }]);
    promptSlackAccountLinkMock.mockResolvedValueOnce({ dmPromptSent: false });

    await handleFollowupAnswer(buildPayload('Ship it'));

    expect(postMessageMock).toHaveBeenCalledWith({
      text: '<@U123> I need to link your account before I can help. Please open a DM with me and use the Link accounts button.',
      channel: 'C123',
      thread_ts: '111.222',
    });
  });

  it('skips the public thread reply when the follow-up button was clicked in a DM', async () => {
    selectLimitMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ teamId: 'T123', orgId: 'org-1' }]);

    await handleFollowupAnswer(
      buildPayload('Ship it', {
        channel: {
          id: 'D123',
          name: 'directmessage',
        },
      }),
    );

    expect(promptSlackAccountLinkMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'D123',
      }),
    );
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('shows a visible error when a follow-up button targets an inactive task', async () => {
    findActiveSlackTaskRunMock.mockResolvedValue(null);

    await handleFollowupAnswer(buildPayload('Ship it'));

    expect(promptSlackAccountLinkMock).not.toHaveBeenCalled();
    expect(queueSlackMessageMock).not.toHaveBeenCalled();
    expect(submitPendingSlackRequestUserInputAnswerMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.test/response',
      expect.objectContaining({
        body: JSON.stringify({
          replace_original: false,
          text: 'This task is no longer active. Please ask the agent again in the thread.',
        }),
      }),
    );
  });

  it('advances a multi-question structured prompt and posts the next question instead of submitting early', async () => {
    selectLimitMock
      .mockResolvedValueOnce([{ userId: 'user-1' }])
      .mockResolvedValueOnce([{ botAccessToken: 'xoxb-test' }]);
    getPendingSlackRequestUserInputMock.mockResolvedValue({
      requestId: 'rui:session:turn:call',
      runId: 42,
      taskId: 'task-1',
      promptMessageTs: 'prompt-ts',
      questions: [
        {
          id: 'language',
          header: 'Language',
          question: 'Which language should I use?',
          isOther: true,
          isSecret: false,
          options: [
            {
              label: 'TypeScript',
              description: 'Use the app stack.',
            },
          ],
        },
        {
          id: 'style',
          header: 'Style',
          question: 'What should the UI optimize for?',
          isOther: true,
          isSecret: false,
          options: [
            {
              label: 'Dashboard',
              description: 'Pane-first interface.',
            },
          ],
        },
      ],
      currentQuestionIndex: 0,
      answers: {},
      status: 'pending',
      createdAt: 123,
    });

    await handleFollowupAnswer(buildPayload());

    expect(
      advancePendingSlackRequestUserInputQuestionMock,
    ).toHaveBeenCalledWith(
      '111.222',
      expect.objectContaining({
        requestId: 'rui:session:turn:call',
      }),
      1,
      {
        language: {
          answers: ['TypeScript'],
        },
      },
    );
    expect(
      setPendingSlackRequestUserInputPromptMessageTsMock,
    ).toHaveBeenCalledWith('111.222', 'rui:session:turn:call', 1, 'posted-ts');
    expect(submitPendingSlackRequestUserInputAnswerMock).not.toHaveBeenCalled();
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '111.222',
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: 'context',
            elements: [
              expect.objectContaining({
                text: '_Reply or use the <http://localhost:13000/task/task-1|web app>._',
              }),
            ],
          }),
        ]),
      }),
    );
    expect(mockGetSlackThreadFooterText).toHaveBeenCalledWith({
      taskUrl: `${taskOrigin}/task/task-1?utm_source=slack&utm_medium=integration&utm_campaign=request_user_input`,
      taskId: 'task-1',
      prRepo: null,
      prNumber: null,
      channelId: 'C123',
      threadTs: '111.222',
    });
    expect(updateMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        ts: 'prompt-ts',
      }),
    );
  });

  it('queues a plain follow-up answer while the job is still booting', async () => {
    findActiveSlackTaskRunMock.mockResolvedValue({
      id: 42,
      machineId: null,
      taskId: null,
    });
    selectLimitMock
      .mockResolvedValueOnce([{ userId: 'user-1' }])
      .mockResolvedValueOnce([{ botAccessToken: 'xoxb-test' }]);

    await handleFollowupAnswer(buildPayload('Ship it'));

    expect(queueSlackMessageMock).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        text: 'Ship it',
        user: 'U123',
        userId: 'user-1',
      }),
    );
    expect(setTrustedRunActingUserMock).toHaveBeenCalledWith({
      runId: 42,
      userId: 'user-1',
    });
    expect(
      setTrustedRunActingUserMock.mock.invocationCallOrder[0]!,
    ).toBeLessThan(queueSlackMessageMock.mock.invocationCallOrder[0]!);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '111.222',
        blocks: [
          expect.objectContaining({
            text: '**Selected:** Ship it',
          }),
        ],
      }),
    );
    expect(consoleErrorMock).not.toHaveBeenCalled();
  });

  it('queues a structured final answer while the job is still booting', async () => {
    findActiveSlackTaskRunMock.mockResolvedValue({
      id: 42,
      machineId: null,
      taskId: null,
    });
    selectLimitMock
      .mockResolvedValueOnce([{ userId: 'user-1' }])
      .mockResolvedValueOnce([{ botAccessToken: 'xoxb-test' }]);
    getPendingSlackRequestUserInputMock.mockResolvedValue({
      requestId: 'rui:session:turn:call',
      runId: 42,
      taskId: 'task-1',
      questions: [
        {
          id: 'language',
          header: 'Language',
          question: 'Which language should I use?',
          isOther: true,
          isSecret: false,
          options: [
            {
              label: 'TypeScript',
              description: 'Use the app stack.',
            },
          ],
        },
      ],
      currentQuestionIndex: 0,
      answers: {},
      status: 'pending',
      createdAt: 123,
    });

    await handleFollowupAnswer(buildPayload());

    expect(submitPendingSlackRequestUserInputAnswerMock).toHaveBeenCalledWith(
      '111.222',
      expect.objectContaining({
        requestId: 'rui:session:turn:call',
      }),
      expect.objectContaining({
        answers: {
          language: {
            answers: ['TypeScript'],
          },
        },
        user: 'U123',
        userId: 'user-1',
      }),
    );
    expect(setTrustedRunActingUserOnSuccessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 42,
        userId: 'user-1',
        operation: expect.any(Function),
      }),
    );
    expect(
      setTrustedRunActingUserOnSuccessMock.mock.invocationCallOrder[0]!,
    ).toBeLessThan(
      submitPendingSlackRequestUserInputAnswerMock.mock.invocationCallOrder[0]!,
    );
    expect(queueSlackMessageMock).not.toHaveBeenCalled();
    expect(consoleErrorMock).not.toHaveBeenCalled();
  });

  it('shows already-received copy when a structured final answer loses the atomic claim', async () => {
    findActiveSlackTaskRunMock.mockResolvedValue({
      id: 42,
      machineId: null,
      taskId: null,
    });
    selectLimitMock
      .mockResolvedValueOnce([{ userId: 'user-1' }])
      .mockResolvedValueOnce([{ botAccessToken: 'xoxb-test' }]);
    submitPendingSlackRequestUserInputAnswerMock.mockResolvedValue(false);
    getPendingSlackRequestUserInputMock.mockResolvedValue({
      requestId: 'rui:session:turn:call',
      runId: 42,
      taskId: 'task-1',
      questions: [
        {
          id: 'language',
          header: 'Language',
          question: 'Which language should I use?',
          isOther: true,
          isSecret: false,
          options: [
            {
              label: 'TypeScript',
              description: 'Use the app stack.',
            },
          ],
        },
      ],
      currentQuestionIndex: 0,
      answers: {},
      status: 'pending',
      createdAt: 123,
    });

    await handleFollowupAnswer(buildPayload());

    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.test/response',
      expect.objectContaining({
        body: JSON.stringify({
          replace_original: false,
          text: 'I already received your answer. Please wait for the agent to continue.',
        }),
      }),
    );
    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(postMessageMock).not.toHaveBeenCalled();
    expect(consoleErrorMock).not.toHaveBeenCalled();
  });
});
