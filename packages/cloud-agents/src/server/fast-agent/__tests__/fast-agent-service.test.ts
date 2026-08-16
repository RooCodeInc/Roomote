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

import { answerFastAgentQuestion } from '../fast-agent-service';

const baseParams = {
  question: 'What does this service do?',
  userId: 'user-1',
  apiBaseUrl: 'https://api.example.com',
  slackTeamId: 'team-1',
  slackChannel: 'channel-1',
  slackThreadTs: '100.1',
  currentMessageTs: '100.2',
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

  it('allows one brokered integration call and then requires a response', async () => {
    mocks.listIntegrations.mockResolvedValue([
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
    mocks.callIntegration.mockResolvedValue({ matches: ['fast-agent.ts'] });

    const result = await answerFastAgentQuestion({
      ...baseParams,
      postSlackReply: vi.fn().mockResolvedValue(undefined),
    });

    expect(mocks.callIntegration).toHaveBeenCalledOnce();
    expect(mocks.generateObject).toHaveBeenCalledTimes(2);
    expect(result).toBe('The code is in the fast-agent module.');
  });
});
