const mocks = vi.hoisted(() => ({
  appendSessionMessages: vi.fn(),
  getSession: vi.fn(),
  getEnvironments: vi.fn(),
  generateObject: vi.fn(),
  listIntegrations: vi.fn(),
  callIntegration: vi.fn(),
  sendTaskMessage: vi.fn(),
  cancelTask: vi.fn(),
}));

vi.mock('../fast-agent-session', () => ({
  appendFastAgentSessionMessages: mocks.appendSessionMessages,
  getOrCreateFastAgentSession: mocks.getSession,
}));

vi.mock('../../router', () => ({
  getAvailableEnvironments: mocks.getEnvironments,
}));

vi.mock('../../non-task-provider-usage', () => ({
  NON_TASK_INFERENCE_SURFACES: {
    fastAgentQuestionAnswering: 'fast_agent_question_answering',
  },
  generateTrackedNonTaskObject: mocks.generateObject,
}));

vi.mock('../fast-agent-integration-broker', () => ({
  listFastAgentIntegrations: mocks.listIntegrations,
  callFastAgentIntegration: mocks.callIntegration,
}));

vi.mock('../fast-agent-tasks', () => ({
  sendFastAgentTaskMessage: mocks.sendTaskMessage,
  cancelFastAgentTask: mocks.cancelTask,
}));

import {
  answerFastAgentQuestion,
  FAST_AGENT_MAX_STEPS,
} from '../fast-agent-service';

const baseParams = {
  question: 'What does this service do?',
  userId: 'user-1',
  apiBaseUrl: 'https://api.example.com',
  slackTeamId: 'team-1',
  slackChannel: 'channel-1',
  slackThreadTs: '100.1',
  currentMessageTs: '100.2',
  senderDisplayName: 'Matt',
};

function decision(overrides: Record<string, unknown> = {}) {
  return {
    action: 'respond',
    response: 'It coordinates incoming requests.',
    taskPrompt: null,
    environmentId: null,
    taskMessage: null,
    integrationId: null,
    toolName: null,
    toolArguments: null,
    ...overrides,
  };
}

describe('answerFastAgentQuestion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ id: 'session-1', messages: [] });
    mocks.getEnvironments.mockResolvedValue([
      {
        id: 'env-1',
        name: 'App',
        repositoryNames: ['acme/app'],
      },
    ]);
    mocks.listIntegrations.mockResolvedValue([]);
    mocks.generateObject.mockResolvedValue({ object: decision() });
    mocks.sendTaskMessage.mockResolvedValue({ success: true });
    mocks.cancelTask.mockResolvedValue({ success: true });
  });

  it('answers directly and persists the Slack conversation', async () => {
    const postSlackReply = vi.fn().mockResolvedValue(undefined);

    const result = await answerFastAgentQuestion({
      ...baseParams,
      postSlackReply,
    });

    expect(result).toBe('It coordinates incoming requests.');
    expect(mocks.getSession).toHaveBeenCalledWith({
      userId: 'user-1',
      slackTeamId: 'team-1',
      slackChannel: 'channel-1',
      slackThreadTs: '100.1',
    });
    expect(postSlackReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'It coordinates incoming requests.' }),
    );
    expect(mocks.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({ modelRole: 'primary' }),
    );
    expect(mocks.appendSessionMessages).toHaveBeenCalledOnce();
  });

  it('launches selected execution work through the Slack-owned callback', async () => {
    mocks.generateObject.mockResolvedValue({
      object: decision({
        action: 'launch_task',
        response: "I'll start that in App.",
        taskPrompt: 'Add the regression test.',
        environmentId: 'env-1',
      }),
    });
    const launchTask = vi.fn().mockResolvedValue({
      success: true,
      taskId: 'task-1',
      taskUrl: 'https://roomote.example/tasks/task-1',
    });

    const result = await answerFastAgentQuestion({
      ...baseParams,
      launchTask,
      postSlackReply: vi.fn().mockResolvedValue(undefined),
    });

    expect(launchTask).toHaveBeenCalledWith({
      prompt: 'Add the regression test.',
      environmentId: 'env-1',
    });
    expect(result).toContain('[Open task]');
  });

  it('does not launch or message another task when a task is already active', async () => {
    mocks.generateObject.mockResolvedValue({
      object: decision({
        action: 'launch_task',
        response: "I'll start that in App.",
        taskPrompt: 'Add the regression test.',
        environmentId: 'env-1',
      }),
    });
    const launchTask = vi.fn();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      activeTaskId: 'task-1',
      launchTask,
      postSlackReply: vi.fn().mockResolvedValue(undefined),
    });

    expect(launchTask).not.toHaveBeenCalled();
    expect(mocks.sendTaskMessage).not.toHaveBeenCalled();
    expect(result).toContain('already an active task');
  });

  it('sends only an explicit task instruction to the active task', async () => {
    mocks.generateObject.mockResolvedValue({
      object: decision({
        action: 'send_task_message',
        response: 'I sent that update.',
        taskMessage: 'Also add a regression test.',
      }),
    });

    await answerFastAgentQuestion({
      ...baseParams,
      activeTaskId: 'task-1',
      postSlackReply: vi.fn().mockResolvedValue(undefined),
    });

    expect(mocks.sendTaskMessage).toHaveBeenCalledWith(
      { userId: 'user-1', apiBaseUrl: 'https://api.example.com' },
      { taskId: 'task-1', message: 'Also add a regression test.' },
    );
  });

  it('runs a Brain preflight before deciding and can chain another integration', async () => {
    mocks.listIntegrations.mockResolvedValue([
      {
        id: 'gbrain',
        name: 'Brain',
        description: 'Deployment memory',
        tools: [{ name: 'query' }],
      },
      {
        id: 'github',
        name: 'GitHub',
        description: 'Repositories',
        tools: [{ name: 'search_code' }],
      },
    ]);
    mocks.generateObject
      .mockResolvedValueOnce({
        object: decision({
          action: 'call_integration',
          response: '',
          integrationId: 'github',
          toolName: 'search_code',
          toolArguments: { query: 'orchestrator' },
        }),
      })
      .mockResolvedValueOnce({
        object: decision({ response: 'The code is in the fast-agent module.' }),
      });
    mocks.callIntegration
      .mockResolvedValueOnce({ pages: ['Fast mode uses an orchestrator.'] })
      .mockResolvedValueOnce({ matches: ['fast-agent.ts'] });

    const result = await answerFastAgentQuestion({
      ...baseParams,
      postSlackReply: vi.fn().mockResolvedValue(undefined),
    });

    expect(mocks.callIntegration).toHaveBeenCalledTimes(2);
    expect(mocks.callIntegration).toHaveBeenNthCalledWith(
      1,
      {
        userId: 'user-1',
        apiBaseUrl: 'https://api.example.com',
        sessionId: 'session-1',
        slackTeamId: 'team-1',
        slackChannel: 'channel-1',
        slackThreadTs: '100.1',
        slackMessageTs: '100.2',
      },
      expect.any(Array),
      {
        integrationId: 'gbrain',
        toolName: 'query',
        args: { query: 'Matt: What does this service do?' },
      },
    );
    expect(mocks.callIntegration).toHaveBeenNthCalledWith(
      2,
      {
        userId: 'user-1',
        apiBaseUrl: 'https://api.example.com',
        sessionId: 'session-1',
        slackTeamId: 'team-1',
        slackChannel: 'channel-1',
        slackThreadTs: '100.1',
        slackMessageTs: '100.2',
      },
      expect.any(Array),
      {
        integrationId: 'github',
        toolName: 'search_code',
        args: { query: 'orchestrator' },
      },
    );
    expect(mocks.generateObject).toHaveBeenCalledTimes(2);
    expect(mocks.generateObject.mock.calls[0]?.[0]?.prompt).toContain(
      'AUTOMATIC BRAIN PREFLIGHT',
    );
    expect(mocks.generateObject.mock.calls[0]?.[0]?.prompt).toContain(
      'Fast mode uses an orchestrator.',
    );
    expect(result).toBe('The code is in the fast-agent module.');
  });

  it('rejects an equivalent duplicate integration call and requires a response', async () => {
    mocks.listIntegrations.mockResolvedValue([
      {
        id: 'github',
        name: 'GitHub',
        description: 'Repositories',
        tools: [{ name: 'search_code' }],
      },
    ]);
    const repeatedCall = decision({
      action: 'call_integration',
      response: '',
      integrationId: 'github',
      toolName: 'search_code',
      toolArguments: { repository: 'acme/app', query: 'orchestrator' },
    });
    mocks.generateObject
      .mockResolvedValueOnce({ object: repeatedCall })
      .mockResolvedValueOnce({
        object: decision({
          ...repeatedCall,
          toolArguments: { query: 'orchestrator', repository: 'acme/app' },
        }),
      })
      .mockResolvedValueOnce({
        object: decision({ response: 'I found the orchestrator.' }),
      });
    mocks.callIntegration.mockResolvedValue({ matches: [] });

    const result = await answerFastAgentQuestion({
      ...baseParams,
      postSlackReply: vi.fn().mockResolvedValue(undefined),
    });

    expect(mocks.callIntegration).toHaveBeenCalledOnce();
    expect(mocks.generateObject).toHaveBeenCalledTimes(3);
    expect(result).toBe('I found the orchestrator.');
  });

  it('posts a fallback when forced-final structured output fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.listIntegrations.mockResolvedValue([
      {
        id: 'github',
        name: 'GitHub',
        description: 'Repositories',
        tools: [{ name: 'search_code' }],
      },
    ]);
    const repeatedCall = decision({
      action: 'call_integration',
      response: '',
      integrationId: 'github',
      toolName: 'search_code',
      toolArguments: { query: 'orchestrator' },
    });
    mocks.generateObject
      .mockResolvedValueOnce({ object: repeatedCall })
      .mockResolvedValueOnce({ object: repeatedCall })
      .mockRejectedValueOnce(new Error('No object generated'));
    mocks.callIntegration.mockResolvedValue({ matches: [] });
    const postSlackReply = vi.fn().mockResolvedValue(undefined);

    const result = await answerFastAgentQuestion({
      ...baseParams,
      postSlackReply,
    });

    expect(mocks.callIntegration).toHaveBeenCalledOnce();
    expect(result).toContain('within the available turn steps');
    expect(postSlackReply).toHaveBeenCalledWith({
      type: 'final_answer',
      slackChannel: 'channel-1',
      slackThreadTs: '100.1',
      text: result,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Final decision generation failed'),
    );
    warn.mockRestore();
  });

  it('reserves the final overall step for a response', async () => {
    mocks.listIntegrations.mockResolvedValue([
      {
        id: 'github',
        name: 'GitHub',
        description: 'Repositories',
        tools: [{ name: 'search_code' }],
      },
    ]);
    let generation = 0;
    mocks.generateObject.mockImplementation(async () => {
      generation += 1;
      return {
        object:
          generation < FAST_AGENT_MAX_STEPS
            ? decision({
                action: 'call_integration',
                response: '',
                integrationId: 'github',
                toolName: 'search_code',
                toolArguments: { query: `orchestrator-${generation}` },
              })
            : decision({ response: 'Here is what I found.' }),
      };
    });
    mocks.callIntegration.mockResolvedValue({ matches: [] });

    const result = await answerFastAgentQuestion({
      ...baseParams,
      postSlackReply: vi.fn().mockResolvedValue(undefined),
    });

    expect(mocks.callIntegration).toHaveBeenCalledTimes(
      FAST_AGENT_MAX_STEPS - 1,
    );
    expect(mocks.generateObject).toHaveBeenCalledTimes(FAST_AGENT_MAX_STEPS);
    expect(result).toBe('Here is what I found.');

    const finalSchema = mocks.generateObject.mock.calls.at(-1)?.[0]?.schema;
    expect(
      finalSchema.safeParse(decision({ action: 'call_integration' })).success,
    ).toBe(false);
  });
});
