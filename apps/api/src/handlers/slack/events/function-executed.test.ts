const {
  completeFunctionErrorMock,
  completeFunctionSuccessMock,
  getSlackAutomationLaunchIdentityMock,
  redisGetMock,
  redisSetMock,
  startFastAgentResponseMock,
  lookupSlackUserMappingMock,
  getOrCreateFastAgentSessionMock,
  getSessionForFastConversationMock,
  contextPostMessageMock,
} = vi.hoisted(() => ({
  completeFunctionErrorMock: vi.fn(),
  completeFunctionSuccessMock: vi.fn(),
  getSlackAutomationLaunchIdentityMock: vi.fn(),
  redisGetMock: vi.fn(),
  redisSetMock: vi.fn(),
  startFastAgentResponseMock: vi.fn(),
  lookupSlackUserMappingMock: vi.fn(),
  getOrCreateFastAgentSessionMock: vi.fn(),
  getSessionForFastConversationMock: vi.fn(),
  contextPostMessageMock: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    get: redisGetMock,
    set: redisSetMock,
  }),
}));

vi.mock('@roomote/env', () => ({
  Env: { R_APP_URL: 'https://app.example.com', TRPC_URL: null },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  getOrCreateFastAgentSession: getOrCreateFastAgentSessionMock,
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  db: { query: { slackUserMappings: { findFirst: vi.fn(async () => null) } } },
  slackUserMappings: {},
  getSessionForFastConversation: getSessionForFastConversationMock,
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: vi.fn(function SlackNotifier() {
    return {
      completeFunctionError: completeFunctionErrorMock,
      completeFunctionSuccess: completeFunctionSuccessMock,
    };
  }),
  resolveSlackReactionNames: vi.fn(async () => ({
    ackEmoji: 'eyes',
    completionEmoji: 'white_check_mark',
  })),
}));

vi.mock('../helpers/launch-identity.js', () => ({
  getSlackAutomationLaunchIdentity: getSlackAutomationLaunchIdentityMock,
}));

vi.mock('../helpers/user-mapping.js', () => ({
  lookupSlackUserMapping: lookupSlackUserMappingMock,
}));

vi.mock('./message-entry.js', () => ({
  startFastAgentResponse: startFastAgentResponseMock,
}));

const context = {
  slackInstallation: {
    botUserId: 'B123',
    teamId: 'T123',
    teamDomain: 'acme-team',
  },
  slack: { postMessage: contextPostMessageMock },
  teamId: 'T123',
} as never;

function workflowEvent(inputs: Record<string, string>) {
  return {
    type: 'function_executed',
    function_execution_id: 'Fn123',
    bot_access_token: 'xoxb-workflow',
    function: { callback_id: 'start_roomote_task' },
    inputs,
  } as never;
}

describe('function-executed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisGetMock.mockResolvedValue(null);
    redisSetMock.mockResolvedValue('OK');
    completeFunctionErrorMock.mockResolvedValue(true);
    completeFunctionSuccessMock.mockResolvedValue(true);
    getSlackAutomationLaunchIdentityMock.mockResolvedValue({
      launchUserId: 'user_installer',
      slackUserId: 'U_INSTALLER',
    });
    lookupSlackUserMappingMock.mockResolvedValue({
      activeMapping: null,
      hasInactiveMapping: false,
    });
    startFastAgentResponseMock.mockResolvedValue({
      accepted: true,
      abort: vi.fn(),
    });
    getOrCreateFastAgentSessionMock.mockResolvedValue({ id: 'fast-1' });
    getSessionForFastConversationMock.mockResolvedValue({ id: 'session-1' });
    contextPostMessageMock.mockResolvedValue('222.000');
  });

  it('enters Fast in the workflow thread under the linked prompt author', async () => {
    lookupSlackUserMappingMock.mockResolvedValue({
      activeMapping: {
        userId: 'user_author',
        slackUserId: 'U123',
        slackTeamId: 'T123',
      },
      hasInactiveMapping: false,
    });
    const { processSlackWorkflowFunctionExecuted } =
      await import('./function-executed.js');

    await processSlackWorkflowFunctionExecuted({
      functionEvent: workflowEvent({
        prompt: 'Investigate router behavior',
        channel_id: 'C123',
        message_ts: '111.000',
        prompt_author_id: 'U123',
      }),
      context,
    });

    expect(contextPostMessageMock).not.toHaveBeenCalled();
    expect(startFastAgentResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_author',
        teamId: 'T123',
        continuation: true,
        directedAtRoomote: true,
        event: expect.objectContaining({
          type: 'app_mention',
          channel: 'C123',
          user: 'U123',
          text: 'Investigate router behavior',
          ts: '111.000',
          thread_ts: '111.000',
        }),
      }),
    );
    expect(startFastAgentResponseMock.mock.calls[0]?.[0]).not.toHaveProperty(
      'delegatedTaskInitiator',
    );
    expect(getOrCreateFastAgentSessionMock).toHaveBeenCalledWith({
      userId: 'user_author',
      conversation: {
        surface: 'slack',
        workspaceId: 'T123',
        conversationId: '111.000',
        replyTarget: { channelId: 'C123', threadId: '111.000' },
      },
    });
    expect(completeFunctionSuccessMock).toHaveBeenCalledWith({
      functionExecutionId: 'Fn123',
      outputs: {
        task_id: '',
        task_url: 'https://app.example.com/sessions/session-1',
        session_id: 'session-1',
        session_url: 'https://app.example.com/sessions/session-1',
      },
    });
    expect(completeFunctionErrorMock).not.toHaveBeenCalled();
  });

  it('posts the prompt as a thread root and enters Fast under the automation identity when the step has no thread or author', async () => {
    const { processSlackWorkflowFunctionExecuted } =
      await import('./function-executed.js');

    await processSlackWorkflowFunctionExecuted({
      functionEvent: workflowEvent({
        prompt: 'Investigate router behavior',
        channel_id: 'C123',
      }),
      context,
    });

    expect(contextPostMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        text: expect.stringContaining('Investigate router behavior'),
      }),
    );
    expect(startFastAgentResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_installer',
        delegatedTaskInitiator: { kind: 'automation', key: 'slack_workflow' },
        event: expect.objectContaining({
          user: 'U_INSTALLER',
          ts: '222.000',
          thread_ts: '222.000',
        }),
      }),
    );
    expect(completeFunctionSuccessMock).toHaveBeenCalledWith(
      expect.objectContaining({ functionExecutionId: 'Fn123' }),
    );
  });

  it('fails the step when Fast does not accept the request', async () => {
    startFastAgentResponseMock.mockResolvedValue({
      accepted: false,
      reason: 'Fast session is busy.',
    });
    const { processSlackWorkflowFunctionExecuted } =
      await import('./function-executed.js');

    await processSlackWorkflowFunctionExecuted({
      functionEvent: workflowEvent({
        prompt: 'Investigate router behavior',
        channel_id: 'C123',
        message_ts: '111.000',
      }),
      context,
    });

    expect(completeFunctionErrorMock).toHaveBeenCalledWith({
      functionExecutionId: 'Fn123',
      error: expect.stringContaining('Fast session is busy.'),
    });
    expect(completeFunctionSuccessMock).not.toHaveBeenCalled();
  });
});
