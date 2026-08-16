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
    action: 'send_chat_reply',
    message: 'It coordinates incoming requests.',
    purpose: 'closeout',
    reactionName: null,
    taskPrompt: null,
    environmentId: null,
    taskMessage: null,
    integrationId: null,
    toolName: null,
    toolArguments: null,
    ...overrides,
  };
}

function chatCallbacks() {
  return {
    postSlackReply: vi.fn().mockResolvedValue(undefined),
    postSlackReaction: vi.fn().mockResolvedValue(undefined),
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

  it('answers through send_chat_reply and persists the Slack conversation', async () => {
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
    });

    expect(result).toBe('It coordinates incoming requests.');
    expect(callbacks.postSlackReply).toHaveBeenCalledWith({
      purpose: 'closeout',
      slackChannel: 'channel-1',
      slackThreadTs: '100.1',
      message: 'It coordinates incoming requests.',
    });
    expect(callbacks.postSlackReaction).not.toHaveBeenCalled();
    expect(mocks.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({ modelRole: 'primary' }),
    );
    expect(mocks.appendSessionMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'user' }),
          expect.objectContaining({ role: 'assistant' }),
        ]),
      }),
    );
  });

  it('continues working after an acknowledgement and then sends a closeout', async () => {
    mocks.generateObject
      .mockResolvedValueOnce({
        object: decision({
          message: "I'll check.",
          purpose: 'ack',
        }),
      })
      .mockResolvedValueOnce({
        object: decision({ message: 'It is configured correctly.' }),
      });
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
    });

    expect(result).toBe('It is configured correctly.');
    expect(callbacks.postSlackReply).toHaveBeenCalledTimes(2);
    expect(callbacks.postSlackReply).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ purpose: 'ack', message: "I'll check." }),
    );
    expect(callbacks.postSlackReply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        purpose: 'closeout',
        message: 'It is configured correctly.',
      }),
    );
  });

  it('can close out a lightweight turn with an emoji reaction', async () => {
    mocks.generateObject.mockResolvedValue({
      object: decision({
        action: 'send_chat_reaction_emoji',
        message: null,
        purpose: 'closeout',
        reactionName: 'thumbsup',
      }),
    });
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
    });

    expect(result).toBe('');
    expect(callbacks.postSlackReaction).toHaveBeenCalledWith({
      name: 'thumbsup',
      slackChannel: 'channel-1',
      slackMessageTs: '100.2',
    });
    expect(callbacks.postSlackReply).not.toHaveBeenCalled();
    expect(mocks.appendSessionMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'assistant' }),
        ]),
      }),
    );
  });

  it('continues working after an emoji acknowledgement', async () => {
    mocks.generateObject
      .mockResolvedValueOnce({
        object: decision({
          action: 'send_chat_reaction_emoji',
          message: null,
          purpose: 'ack',
          reactionName: 'eyes',
        }),
      })
      .mockResolvedValueOnce({
        object: decision({ message: 'I found the answer.' }),
      });
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
    });

    expect(callbacks.postSlackReaction).toHaveBeenCalledOnce();
    expect(callbacks.postSlackReply).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'closeout',
        message: 'I found the answer.',
      }),
    );
    expect(result).toBe('I found the answer.');
  });

  it('launches work, exposes the result to the loop, and then replies', async () => {
    mocks.generateObject
      .mockResolvedValueOnce({
        object: decision({
          action: 'launch_task',
          message: null,
          purpose: null,
          taskPrompt: 'Add the regression test.',
          environmentId: 'env-1',
        }),
      })
      .mockResolvedValueOnce({
        object: decision({
          message: 'I started it. [Open task](https://roomote.example/task-1)',
        }),
      });
    const launchTask = vi.fn().mockResolvedValue({
      success: true,
      taskId: 'task-1',
      taskUrl: 'https://roomote.example/task-1',
    });
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
      launchTask,
    });

    expect(launchTask).toHaveBeenCalledWith({
      prompt: 'Add the regression test.',
      environmentId: 'env-1',
    });
    expect(mocks.generateObject.mock.calls[1]?.[0]?.prompt).toContain(
      'FAST ORCHESTRATION TOOL RESULT',
    );
    expect(mocks.generateObject.mock.calls[1]?.[0]?.prompt).toContain(
      'https://roomote.example/task-1',
    );
    expect(result).toContain('[Open task]');
  });

  it('does not launch another task when one is active and asks the agent to report the result', async () => {
    mocks.generateObject
      .mockResolvedValueOnce({
        object: decision({
          action: 'launch_task',
          message: null,
          purpose: null,
          taskPrompt: 'Add the regression test.',
          environmentId: 'env-1',
        }),
      })
      .mockResolvedValueOnce({
        object: decision({ message: 'There is already an active task.' }),
      });
    const launchTask = vi.fn();
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
      activeTaskId: 'task-1',
      launchTask,
    });

    expect(launchTask).not.toHaveBeenCalled();
    expect(result).toContain('already an active task');
  });

  it('sends an explicit instruction to the active task before replying', async () => {
    mocks.generateObject
      .mockResolvedValueOnce({
        object: decision({
          action: 'send_task_message',
          message: null,
          purpose: null,
          taskMessage: 'Also add a regression test.',
        }),
      })
      .mockResolvedValueOnce({
        object: decision({ message: 'I sent that instruction.' }),
      });
    const callbacks = chatCallbacks();

    await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
      activeTaskId: 'task-1',
    });

    expect(mocks.sendTaskMessage).toHaveBeenCalledWith(
      { userId: 'user-1', apiBaseUrl: 'https://api.example.com' },
      { taskId: 'task-1', message: 'Also add a regression test.' },
    );
    expect(callbacks.postSlackReply).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'I sent that instruction.' }),
    );
  });

  it('cancels the active task before reporting the result', async () => {
    mocks.generateObject
      .mockResolvedValueOnce({
        object: decision({
          action: 'cancel_task',
          message: null,
          purpose: null,
        }),
      })
      .mockResolvedValueOnce({
        object: decision({ message: 'I canceled the active task.' }),
      });
    const callbacks = chatCallbacks();

    await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
      activeTaskId: 'task-1',
    });

    expect(mocks.cancelTask).toHaveBeenCalledWith(
      { userId: 'user-1', apiBaseUrl: 'https://api.example.com' },
      'task-1',
    );
    expect(callbacks.postSlackReply).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'I canceled the active task.' }),
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
          message: null,
          purpose: null,
          integrationId: 'github',
          toolName: 'search_code',
          toolArguments: JSON.stringify({ query: 'orchestrator' }),
        }),
      })
      .mockResolvedValueOnce({
        object: decision({ message: 'The code is in the fast-agent module.' }),
      });
    mocks.callIntegration
      .mockResolvedValueOnce({ pages: ['Fast mode uses an orchestrator.'] })
      .mockResolvedValueOnce({ matches: ['fast-agent.ts'] });
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
    });

    expect(mocks.callIntegration).toHaveBeenCalledTimes(2);
    expect(mocks.callIntegration).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: 'session-1' }),
      expect.any(Array),
      {
        integrationId: 'gbrain',
        toolName: 'query',
        args: { query: 'Matt: What does this service do?' },
      },
    );
    expect(mocks.generateObject.mock.calls[0]?.[0]?.prompt).toContain(
      'AUTOMATIC BRAIN PREFLIGHT',
    );
    expect(result).toBe('The code is in the fast-agent module.');
  });

  it('forwards JSON-encoded arguments to a follow-up Brain entity lookup', async () => {
    mocks.listIntegrations.mockResolvedValue([
      {
        id: 'gbrain',
        name: 'Brain',
        description: 'Deployment memory',
        tools: [{ name: 'query' }, { name: 'entity' }],
      },
    ]);
    mocks.generateObject
      .mockResolvedValueOnce({
        object: decision({
          action: 'call_integration',
          message: null,
          purpose: null,
          integrationId: 'gbrain',
          toolName: 'entity',
          toolArguments: JSON.stringify({ name: 'Alice Example' }),
        }),
      })
      .mockResolvedValueOnce({
        object: decision({ message: 'I found the person card.' }),
      });
    mocks.callIntegration
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ found: true });

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...chatCallbacks(),
    });

    expect(mocks.callIntegration).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.any(Array),
      {
        integrationId: 'gbrain',
        toolName: 'entity',
        args: { name: 'Alice Example' },
      },
    );
    expect(result).toBe('I found the person card.');
  });

  it('rejects an equivalent duplicate integration call and asks for a visible reply', async () => {
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
      message: null,
      purpose: null,
      integrationId: 'github',
      toolName: 'search_code',
      toolArguments: JSON.stringify({
        repository: 'acme/app',
        query: 'orchestrator',
      }),
    });
    mocks.generateObject
      .mockResolvedValueOnce({ object: repeatedCall })
      .mockResolvedValueOnce({
        object: decision({
          ...repeatedCall,
          toolArguments: JSON.stringify({
            query: 'orchestrator',
            repository: 'acme/app',
          }),
        }),
      })
      .mockResolvedValueOnce({
        object: decision({ message: 'I found the orchestrator.' }),
      });
    mocks.callIntegration.mockResolvedValue({ matches: [] });

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...chatCallbacks(),
    });

    expect(mocks.callIntegration).toHaveBeenCalledOnce();
    expect(mocks.generateObject).toHaveBeenCalledTimes(3);
    expect(result).toBe('I found the orchestrator.');
  });

  it('uses the completion hook when the model never sends a visible response', async () => {
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
        object: decision({
          action: 'call_integration',
          message: null,
          purpose: null,
          integrationId: 'github',
          toolName: 'search_code',
          toolArguments: JSON.stringify({
            query: `orchestrator-${generation}`,
          }),
        }),
      };
    });
    mocks.callIntegration.mockResolvedValue({ matches: [] });
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
    });

    expect(mocks.callIntegration).toHaveBeenCalledTimes(FAST_AGENT_MAX_STEPS);
    expect(result).toContain('within the available turn steps');
    expect(callbacks.postSlackReply).toHaveBeenCalledOnce();
    expect(callbacks.postSlackReply).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'closeout', message: result }),
    );
  });

  it('uses the completion hook when an acknowledgement is not followed by a closeout', async () => {
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
      return generation === 1
        ? {
            object: decision({
              message: "I'll take a look.",
              purpose: 'ack',
            }),
          }
        : {
            object: decision({
              action: 'call_integration',
              message: null,
              purpose: null,
              integrationId: 'github',
              toolName: 'search_code',
              toolArguments: JSON.stringify({
                query: `orchestrator-${generation}`,
              }),
            }),
          };
    });
    mocks.callIntegration.mockResolvedValue({ matches: [] });
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
    });

    expect(result).toContain('within the available turn steps');
    expect(callbacks.postSlackReply).toHaveBeenCalledTimes(2);
    expect(callbacks.postSlackReply).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ purpose: 'ack', message: "I'll take a look." }),
    );
    expect(callbacks.postSlackReply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ purpose: 'closeout', message: result }),
    );
  });

  it('posts an error closeout when inference fails after an acknowledgement', async () => {
    mocks.generateObject
      .mockResolvedValueOnce({
        object: decision({
          message: "I'll check.",
          purpose: 'ack',
        }),
      })
      .mockRejectedValueOnce(new Error('Inference failed'));
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
    });

    expect(result).toContain('hit an error');
    expect(callbacks.postSlackReply).toHaveBeenCalledTimes(2);
    expect(callbacks.postSlackReply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ purpose: 'closeout', message: result }),
    );
  });
});
