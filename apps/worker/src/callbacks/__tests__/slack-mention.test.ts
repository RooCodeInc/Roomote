const {
  mockBuildSlackRequestUserInputBlocks,
  mockBuildRequestUserInputTaskUrl,
  mockBuildStartedBlocks,
  mockClearPendingSlackRequestUserInput,
  mockAddReaction,
  mockEnqueueSlackPrInactivityCheck,
  mockFetchThreadMessages,
  mockGetSlackThreadFooterText,
  mockGetSlackStartedMessageData,
  mockPostMessage,
  mockRecordOutboundSlackConversationMessage,
  mockRemoveReaction,
  mockSetPendingSlackRequestUserInput,
  mockSlackInstallationsFindFirst,
  mockSupportsIntegrationRequestUserInput,
  mockUpdateMessage,
} = vi.hoisted(() => ({
  mockBuildSlackRequestUserInputBlocks: vi.fn(() => [
    {
      type: 'markdown',
      text: 'native request_user_input blocks',
    },
  ]),
  mockBuildRequestUserInputTaskUrl: vi
    .fn()
    .mockReturnValue(
      'http://localhost:13000/task/task_row_123?utm_source=slack',
    ),
  mockBuildStartedBlocks: vi.fn(() => [
    {
      type: 'markdown',
      text: 'started blocks',
    },
  ]),
  mockClearPendingSlackRequestUserInput: vi.fn().mockResolvedValue(true),
  mockAddReaction: vi.fn().mockResolvedValue(true),
  mockEnqueueSlackPrInactivityCheck: vi
    .fn()
    .mockResolvedValue({ enqueued: true, jobId: 'bullmq-job-1' }),
  mockFetchThreadMessages: vi.fn().mockResolvedValue([
    {
      user: 'U123',
      text: '<@BOT> investigate this',
      ts: '1710000000.100',
      thread_ts: '1710000000.123',
      type: 'message',
    },
  ]),
  mockGetSlackThreadFooterText: vi
    .fn()
    .mockResolvedValue(
      '_Reply or use the <http://localhost:13000/task/task_row_123?utm_source=slack|web app>._',
    ),
  mockGetSlackStartedMessageData: vi.fn(),
  mockPostMessage: vi.fn().mockResolvedValue('posted-ts'),
  mockRecordOutboundSlackConversationMessage: vi
    .fn()
    .mockResolvedValue(undefined),
  mockRemoveReaction: vi.fn().mockResolvedValue(true),
  mockSetPendingSlackRequestUserInput: vi.fn().mockResolvedValue(undefined),
  mockSlackInstallationsFindFirst: vi
    .fn()
    .mockResolvedValue({ botAccessToken: 'xoxb-test' }),
  mockSupportsIntegrationRequestUserInput: vi.fn().mockReturnValue(true),
  mockUpdateMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      enqueueSlackPrInactivityCheck: mockEnqueueSlackPrInactivityCheck,
      getSlackThreadFooterText: mockGetSlackThreadFooterText,
      getSlackStartedMessageData: mockGetSlackStartedMessageData,
      recordOutboundSlackConversationMessage:
        mockRecordOutboundSlackConversationMessage,
      setPendingSlackRequestUserInput: mockSetPendingSlackRequestUserInput,
      clearPendingSlackRequestUserInput: mockClearPendingSlackRequestUserInput,
    },
    slackInstallations: {
      findFirst: mockSlackInstallationsFindFirst,
    },
  },
}));

vi.mock('@roomote/slack/client', () => ({
  SlackNotifier: class {
    addReaction = mockAddReaction;
    fetchThreadMessages = mockFetchThreadMessages;
    removeReaction = mockRemoveReaction;
    updateMessage = mockUpdateMessage;
    postMessage = mockPostMessage;
  },
  buildSlackRequestUserInputBlocks: mockBuildSlackRequestUserInputBlocks,
  buildStartedBlocks: mockBuildStartedBlocks,
  convertMarkdownToSlack: vi.fn((text: string) => text),
}));

vi.mock('../request-user-input', () => ({
  buildRequestUserInputTaskUrl: mockBuildRequestUserInputTaskUrl,
  getRequestUserInputPromptSignature: (request: {
    requestId: string;
    questions: unknown[];
  }) =>
    JSON.stringify({
      requestId: request.requestId,
      questions: request.questions,
    }),
  isOpenCodeQuestionPlaceholderRequest: (request: {
    questions: Array<{
      id?: string;
      header?: string;
      question?: string;
      options?: unknown[];
    }>;
  }) => {
    if (request.questions.length !== 1) {
      return false;
    }
    const question = request.questions[0]!;
    const hasOptions = Boolean(question.options && question.options.length > 0);
    return (
      !hasOptions &&
      question.question?.trim() === 'Provide the requested input.' &&
      (question.id === 'response' || question.header === 'Response')
    );
  },
  supportsIntegrationRequestUserInput: mockSupportsIntegrationRequestUserInput,
}));

import { RunStatus, TaskPayloadKind } from '@roomote/types';
import { type TaskRun, sdk } from '@roomote/sdk/client';

import { slackMentionCallbacks } from '../slack-mention';

function createTaskRun(): TaskRun {
  return {
    id: 123,
    taskId: 'task_row_123',
    payloadKind: TaskPayloadKind.SlackAppMention,
    payload: {
      channel: 'C123',
      teamId: 'T123',
      user: 'U123',
      text: '<@BOT> investigate this',
      ts: '1710000000.100',
      thread_ts: '1710000000.123',
    },
  } as unknown as TaskRun;
}

function createSnapshotResumeTaskRun(): TaskRun {
  return {
    id: 123,
    taskId: 'task_row_123',
    payloadKind: TaskPayloadKind.SnapshotResume,
    payload: {
      slackChannel: 'C123',
      thread_ts: '1710000000.123',
      slackOriginMessageTs: '1710000000.100',
    },
  } as unknown as TaskRun;
}

describe('slackMentionCallbacks', () => {
  const originalRoomoteAppUrl = process.env.R_APP_URL;

  beforeEach(() => {
    process.env.R_APP_URL = 'http://localhost:13000';
    vi.clearAllMocks();
    mockGetSlackStartedMessageData.mockResolvedValue({
      ts: 'started-ts',
      agentName: 'Agent',
      initiatingSlackUserId: 'U123',
      otherRunningTasksCount: 2,
      workspaceDisplayName: 'App',
      workspaceOnly: false,
      warningText:
        '> :warning: Heads up: my humans are working on an issue that may affect me.',
    });
    mockSlackInstallationsFindFirst.mockResolvedValue({
      botAccessToken: 'xoxb-test',
    });
    mockSupportsIntegrationRequestUserInput.mockReturnValue(true);
    mockBuildRequestUserInputTaskUrl.mockReturnValue(
      'http://localhost:13000/task/task_row_123?utm_source=slack',
    );
    mockGetSlackThreadFooterText.mockResolvedValue(
      '_Reply or use the <http://localhost:13000/task/task_row_123?utm_source=slack|web app>._',
    );
    mockFetchThreadMessages.mockResolvedValue([
      {
        user: 'U123',
        text: '<@BOT> investigate this',
        ts: '1710000000.100',
        thread_ts: '1710000000.123',
        type: 'message',
      },
    ]);
    mockUpdateMessage.mockResolvedValue(undefined);
    mockPostMessage.mockResolvedValue('posted-ts');
    mockRecordOutboundSlackConversationMessage.mockResolvedValue(undefined);
    mockSetPendingSlackRequestUserInput.mockResolvedValue(undefined);
    mockEnqueueSlackPrInactivityCheck.mockResolvedValue({
      enqueued: true,
      jobId: 'bullmq-job-1',
    });
    mockClearPendingSlackRequestUserInput.mockResolvedValue(true);
  });

  afterAll(() => {
    if (originalRoomoteAppUrl === undefined) {
      delete process.env.R_APP_URL;
    } else {
      process.env.R_APP_URL = originalRoomoteAppUrl;
    }
  });

  it('loads started-message metadata through sdk.taskRuns on start', async () => {
    const taskRun = createTaskRun();
    const context = {};

    await slackMentionCallbacks.onStart?.(taskRun, 'task_123', context);

    expect(mockRemoveReaction).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: '1710000000.100',
      name: 'eyes',
    });
    expect(sdk.taskRuns.getSlackStartedMessageData).toHaveBeenCalledWith({
      runId: 123,
    });
    expect(mockBuildStartedBlocks).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDisplayName: 'App',
        runId: 123,
        initiatingSlackUserId: 'U123',
        otherRunningTasksCount: 2,
        warningText:
          '> :warning: Heads up: my humans are working on an issue that may affect me.',
        taskUrl: expect.stringContaining(
          '/task/task_row_123?utm_source=slack&utm_medium=link&utm_campaign=slack.app.mention',
        ),
      }),
    );
    expect(mockUpdateMessage).toHaveBeenCalledTimes(1);
  });

  it('falls back to the Slack app mention payload user when older started-message metadata has no initiating Slack user', async () => {
    const taskRun = createTaskRun();
    const context = {};
    mockGetSlackStartedMessageData.mockResolvedValueOnce({
      ts: 'started-ts',
      agentName: 'Agent',
      workspaceDisplayName: 'App',
      workspaceOnly: false,
    });

    await slackMentionCallbacks.onStart?.(taskRun, 'task_123', context);

    expect(mockBuildStartedBlocks).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDisplayName: 'App',
        runId: 123,
        initiatingSlackUserId: 'U123',
        taskUrl: expect.stringContaining(
          '/task/task_row_123?utm_source=slack&utm_medium=link&utm_campaign=slack.app.mention',
        ),
      }),
    );
  });

  it('removes eyes reactions for SnapshotResume runs when the triggering message ts is available', async () => {
    const taskRun = createSnapshotResumeTaskRun();
    const context = {};

    await slackMentionCallbacks.onStart?.(taskRun, 'task_123', context);

    expect(mockRemoveReaction).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: '1710000000.100',
      name: 'eyes',
    });
    expect(mockUpdateMessage).toHaveBeenCalledTimes(1);
  });

  it('still removes the ack reaction when resume state pre-seeds sessionId', async () => {
    const taskRun = createSnapshotResumeTaskRun();
    const context = { sessionId: 'existing-session' };

    await slackMentionCallbacks.onStart?.(taskRun, 'task_123', context);

    expect(mockRemoveReaction).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: '1710000000.100',
      name: 'eyes',
    });
    expect(mockUpdateMessage).toHaveBeenCalledTimes(1);
  });

  it('still refreshes the started message when reaction cleanup fails', async () => {
    const taskRun = createTaskRun();
    const context = {};
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRemoveReaction.mockRejectedValueOnce(new Error('reaction failed'));

    try {
      await slackMentionCallbacks.onStart?.(taskRun, 'task_123', context);

      expect(errorSpy).toHaveBeenCalledWith(
        '[slackMentionCallbacks#onStart] Failed Slack reaction cleanup for task run 123: reaction failed',
      );
      expect(sdk.taskRuns.getSlackStartedMessageData).toHaveBeenCalledWith({
        runId: 123,
      });
      expect(mockUpdateMessage).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('retries and warns when Slack reaction cleanup returns false', async () => {
    const taskRun = createTaskRun();
    const context = {};
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockRemoveReaction.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    try {
      await slackMentionCallbacks.onStart?.(taskRun, 'task_123', context);

      expect(mockRemoveReaction).toHaveBeenNthCalledWith(1, {
        channel: 'C123',
        timestamp: '1710000000.100',
        name: 'eyes',
      });
      expect(mockRemoveReaction).toHaveBeenNthCalledWith(2, {
        channel: 'C123',
        timestamp: '1710000000.100',
        name: 'eyes',
      });
      expect(warnSpy).toHaveBeenCalledWith(
        '[slackMentionCallbacks#onStart] Slack reaction cleanup failed for task run 123; retrying once (emoji=eyes, channel=C123, timestamp=1710000000.100)',
      );
      expect(mockUpdateMessage).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not automatically mirror completion output into Slack', async () => {
    const taskRun = createTaskRun();
    const context = {};

    await slackMentionCallbacks.onMessage?.(
      taskRun,
      'task_123',
      {
        type: 'completion',
        text: 'Task finished',
        ts: 1000,
      },
      context,
    );

    expect(sdk.taskRuns.enqueueSlackPrInactivityCheck).toHaveBeenCalledWith({
      runId: 123,
      completionText: 'Task finished',
    });
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(mockAddReaction).not.toHaveBeenCalled();
  });

  it('uses the fixed acknowledgement emoji when cleaning up Slack reactions on start', async () => {
    const taskRun = {
      ...createTaskRun(),
      payload: {
        ...createTaskRun().payload,
        ackEmoji: 'hourglass',
      },
    } as TaskRun;
    const context = {};

    await slackMentionCallbacks.onStart?.(taskRun, 'task_123', context);

    expect(mockRemoveReaction).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: '1710000000.100',
      name: 'eyes',
    });
  });

  it('does not add completion emoji reactions for repeated completion callbacks', async () => {
    const taskRun = {
      ...createTaskRun(),
      payload: {
        ...createTaskRun().payload,
        completionEmoji: 'rocket',
      },
    } as TaskRun;
    const context = {};

    await slackMentionCallbacks.onMessage?.(
      taskRun,
      'task_123',
      {
        type: 'completion',
        text: 'Task finished',
        ts: 1000,
      },
      context,
    );
    await slackMentionCallbacks.onMessage?.(
      taskRun,
      'task_123',
      {
        type: 'completion',
        text: 'Task finished again',
        ts: 1000,
      },
      context,
    );

    expect(mockAddReaction).not.toHaveBeenCalled();
  });

  it('posts native Slack request_user_input blocks and stores pending state for non-secret prompts', async () => {
    const taskRun = createTaskRun();
    const context = {};

    await slackMentionCallbacks.onMessage?.(
      taskRun,
      'task_123',
      {
        type: 'request_user_input',
        request: {
          requestId: 'rui:session:turn:call',
          sessionId: 'session_1',
          turnId: 'turn_1',
          callId: 'call_1',
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
                  description: 'Use the existing app stack.',
                },
                {
                  label: 'Rust',
                  description: 'Use the OpenCode runtime.',
                },
              ],
            },
          ],
          status: 'pending',
        },
        ts: 1000,
      },
      context,
    );

    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '1710000000.123',
      blocks: [
        {
          type: 'markdown',
          text: 'native request_user_input blocks',
        },
      ],
    });
    expect(mockBuildSlackRequestUserInputBlocks).toHaveBeenCalledWith(
      expect.objectContaining({
        footerText:
          '_Reply or use the <http://localhost:13000/task/task_row_123?utm_source=slack|web app>._',
      }),
    );
    expect(sdk.taskRuns.getSlackThreadFooterText).toHaveBeenCalledWith({
      runId: 123,
      slackChannelId: 'C123',
      threadTs: '1710000000.123',
      taskUrl: 'http://localhost:13000/task/task_row_123?utm_source=slack',
    });
    expect(
      sdk.taskRuns.setPendingSlackRequestUserInput,
    ).toHaveBeenNthCalledWith(1, {
      runId: 123,
      threadId: '1710000000.123',
      requestId: 'rui:session:turn:call',
      taskId: 'task_row_123',
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
              description: 'Use the existing app stack.',
            },
            {
              label: 'Rust',
              description: 'Use the OpenCode runtime.',
            },
          ],
        },
      ],
    });
    expect(
      sdk.taskRuns.setPendingSlackRequestUserInput,
    ).toHaveBeenNthCalledWith(2, {
      runId: 123,
      threadId: '1710000000.123',
      requestId: 'rui:session:turn:call',
      taskId: 'task_row_123',
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
              description: 'Use the existing app stack.',
            },
            {
              label: 'Rust',
              description: 'Use the OpenCode runtime.',
            },
          ],
        },
      ],
      promptMessageTs: 'posted-ts',
    });
    expect(
      mockSetPendingSlackRequestUserInput.mock.invocationCallOrder[0],
    ).toBeLessThan(mockPostMessage.mock.invocationCallOrder[0]!);
  });

  it('updates native Slack request_user_input blocks when the same request id receives richer questions', async () => {
    const taskRun = createTaskRun();
    const context = {};
    const requestId = 'rui:session:turn:call';
    mockUpdateMessage.mockResolvedValueOnce(true);
    const placeholderQuestion = {
      id: 'response',
      header: 'Response',
      question: 'Provide the requested input.',
      isOther: true,
      isSecret: false,
    };
    const richQuestion = {
      id: 'language',
      header: 'Language',
      question: 'Which language should I use?',
      isOther: true,
      isSecret: false,
      options: [
        {
          label: 'TypeScript',
          description: 'Use the existing app stack.',
        },
        {
          label: 'Rust',
          description: 'Use the OpenCode runtime.',
        },
      ],
    };

    await slackMentionCallbacks.onMessage?.(
      taskRun,
      'task_123',
      {
        type: 'request_user_input',
        request: {
          requestId,
          sessionId: 'session_1',
          turnId: 'turn_1',
          callId: 'call_1',
          questions: [placeholderQuestion],
          status: 'pending',
        },
        ts: 1000,
      },
      context,
    );

    await slackMentionCallbacks.onMessage?.(
      taskRun,
      'task_123',
      {
        type: 'request_user_input',
        request: {
          requestId,
          sessionId: 'session_1',
          turnId: 'turn_1',
          callId: 'call_1',
          questions: [richQuestion],
          status: 'pending',
        },
        ts: 1001,
      },
      context,
    );

    // Placeholder OpenCode shells are skipped, so the rich question posts once
    // instead of posting a shell and then updating it.
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockUpdateMessage).not.toHaveBeenCalled();
    expect(mockBuildSlackRequestUserInputBlocks).toHaveBeenCalledTimes(1);
    expect(mockBuildSlackRequestUserInputBlocks).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId,
        questions: [richQuestion],
      }),
    );
    expect(
      sdk.taskRuns.setPendingSlackRequestUserInput,
    ).toHaveBeenLastCalledWith({
      runId: 123,
      threadId: '1710000000.123',
      requestId,
      taskId: 'task_row_123',
      questions: [richQuestion],
      promptMessageTs: 'posted-ts',
    });
  });

  it('falls back to Roomote for secret request_user_input prompts', async () => {
    const taskRun = createTaskRun();
    const context = {};
    mockSupportsIntegrationRequestUserInput.mockReturnValueOnce(false);

    await slackMentionCallbacks.onMessage?.(
      taskRun,
      'task_123',
      {
        type: 'request_user_input',
        request: {
          requestId: 'rui:session:turn:call',
          sessionId: 'session_1',
          turnId: 'turn_1',
          callId: 'call_1',
          questions: [
            {
              id: 'api_key',
              header: 'API key',
              question: 'What is the API key?',
              isOther: false,
              isSecret: true,
            },
          ],
          status: 'pending',
        },
        ts: 1000,
      },
      context,
    );

    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '1710000000.123',
      blocks: [
        {
          type: 'markdown',
          text: 'I need a private answer before I can continue. Please answer in Roomote: <http://localhost:13000/task/task_row_123?utm_source=slack|Open task>.',
        },
      ],
    });
    expect(sdk.taskRuns.setPendingSlackRequestUserInput).not.toHaveBeenCalled();
  });

  it('uses an Open setup link label when secret fallback points to /setup', async () => {
    const taskRun = createTaskRun();
    const context = {};
    mockSupportsIntegrationRequestUserInput.mockReturnValueOnce(false);
    mockBuildRequestUserInputTaskUrl.mockReturnValueOnce(
      'http://localhost:13000/setup?utm_source=slack',
    );

    await slackMentionCallbacks.onMessage?.(
      taskRun,
      'task_123',
      {
        type: 'request_user_input',
        request: {
          requestId: 'rui:session:turn:call',
          sessionId: 'session_1',
          turnId: 'turn_1',
          callId: 'call_1',
          questions: [
            {
              id: 'api_key',
              header: 'API key',
              question: 'What is the API key?',
              isOther: false,
              isSecret: true,
            },
          ],
          status: 'pending',
        },
        ts: 1000,
      },
      context,
    );

    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '1710000000.123',
      blocks: [
        {
          type: 'markdown',
          text: 'I need a private answer before I can continue. Please answer in Roomote: <http://localhost:13000/setup?utm_source=slack|Open setup>.',
        },
      ],
    });
  });

  it('clears pending Slack request_user_input state when the interactive prompt fails to post', async () => {
    const taskRun = createTaskRun();
    const context = {};
    mockPostMessage.mockResolvedValueOnce(undefined);

    await slackMentionCallbacks.onMessage?.(
      taskRun,
      'task_123',
      {
        type: 'request_user_input',
        request: {
          requestId: 'rui:session:turn:call',
          sessionId: 'session_1',
          turnId: 'turn_1',
          callId: 'call_1',
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
                  description: 'Use the existing app stack.',
                },
              ],
            },
          ],
          status: 'pending',
        },
        ts: 1000,
      },
      context,
    );

    expect(sdk.taskRuns.setPendingSlackRequestUserInput).toHaveBeenCalledTimes(
      1,
    );
    expect(sdk.taskRuns.clearPendingSlackRequestUserInput).toHaveBeenCalledWith(
      {
        runId: 123,
        threadId: '1710000000.123',
        requestId: 'rui:session:turn:call',
      },
    );
  });

  it('does not clear pending Slack request_user_input state when only the prompt metadata update fails', async () => {
    const taskRun = createTaskRun();
    const context = {};
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockSetPendingSlackRequestUserInput
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('prompt metadata failed'));

    try {
      await slackMentionCallbacks.onMessage?.(
        taskRun,
        'task_123',
        {
          type: 'request_user_input',
          request: {
            requestId: 'rui:session:turn:call',
            sessionId: 'session_1',
            turnId: 'turn_1',
            callId: 'call_1',
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
                    description: 'Use the existing app stack.',
                  },
                ],
              },
            ],
            status: 'pending',
          },
          ts: 1000,
        },
        context,
      );

      expect(
        sdk.taskRuns.clearPendingSlackRequestUserInput,
      ).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to post request_user_input fallback to Slack: prompt metadata failed',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('posts follow-up questions to Slack', async () => {
    const taskRun = createTaskRun();
    const context = {};

    await slackMentionCallbacks.onMessage?.(
      taskRun,
      'task_123',
      {
        type: 'followup',
        question: 'Need anything else?',
        suggestions: ['No'],
        ts: 1002,
      },
      context,
    );

    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '1710000000.123',
      blocks: [
        {
          type: 'markdown',
          text: '**Question:**\n\nNeed anything else?',
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: ' ' }],
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*Suggestions:*' },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'No' },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: 'Select', emoji: true },
            value: 'No',
            action_id: 'followup_answer_0',
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: '_You can also @-mention me with a custom response._',
            },
          ],
        },
      ],
    });
    expect(context).toMatchObject({
      postedFollowupTs: expect.any(Set),
    });
  });

  it('does not mirror todo updates into Slack threads', async () => {
    const taskRun = createTaskRun();
    const context = {};

    await slackMentionCallbacks.onMessage?.(
      taskRun,
      'task_123',
      {
        type: 'todo_update',
        todos: [
          {
            id: 'todo-1',
            content: 'Implement the change',
            status: 'in_progress',
          },
        ],
        ts: 1003,
      },
      context,
    );

    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(mockUpdateMessage).not.toHaveBeenCalled();
    expect(context).toEqual({});
  });

  it('clears pending request_user_input state on response events', async () => {
    const taskRun = createTaskRun();

    await slackMentionCallbacks.onMessage?.(
      taskRun,
      'task_123',
      {
        type: 'request_user_input_response',
        response: {
          requestId: 'rui:session:turn:call',
          sessionId: 'session_1',
          turnId: 'turn_1',
          callId: 'call_1',
          answers: {
            language: {
              answers: ['TypeScript'],
            },
          },
          resolution: 'submitted',
        },
        ts: 1001,
      },
      {},
    );

    expect(sdk.taskRuns.clearPendingSlackRequestUserInput).toHaveBeenCalledWith(
      {
        runId: 123,
        threadId: '1710000000.123',
        requestId: 'rui:session:turn:call',
      },
    );
  });

  it('swallows onExit cleanup failures', async () => {
    const taskRun = createTaskRun();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockClearPendingSlackRequestUserInput.mockRejectedValueOnce(
      new Error('cleanup failed'),
    );

    try {
      await expect(
        slackMentionCallbacks.onExit?.(taskRun, RunStatus.Completed, {}),
      ).resolves.toBe(undefined);
      expect(errorSpy).toHaveBeenCalledWith(
        '[slackMentionCallbacks#onExit] Failed to clear pending request_user_input state: cleanup failed',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
