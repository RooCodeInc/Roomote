const mocks = vi.hoisted(() => ({
  appendSessionMessages: vi.fn(),
  getActiveTaskId: vi.fn(),
  getSession: vi.fn(),
  getEnvironments: vi.fn(),
  generateObject: vi.fn(),
  listIntegrations: vi.fn(),
  callIntegration: vi.fn(),
  sendTaskMessage: vi.fn(),
  cancelTask: vi.fn(),
  getUserIdentity: vi.fn(),
}));

vi.mock('../fast-agent-session', () => ({
  appendFastAgentSessionMessages: mocks.appendSessionMessages,
  getActiveFastAgentTaskId: mocks.getActiveTaskId,
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

vi.mock('../fast-agent-user-identity', () => ({
  getFastAgentUserIdentity: mocks.getUserIdentity,
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
  senderSlackUserId: 'U123',
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

function successfulLaunchTask() {
  return vi.fn(
    async ({
      postKickoff,
    }: {
      postKickoff: (task: {
        taskId: string;
        taskUrl?: string;
      }) => Promise<void>;
    }) => {
      const task = {
        taskId: 'task-1',
        taskUrl: 'https://roomote.example/task-1',
      };
      await postKickoff(task);
      return { success: true as const, ...task };
    },
  );
}

describe('answerFastAgentQuestion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ id: 'session-1', messages: [] });
    mocks.getActiveTaskId.mockResolvedValue(null);
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
    mocks.getUserIdentity.mockResolvedValue({
      displayName: 'Matt Rubens',
      githubLogin: 'mrubens',
    });
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
    expect(mocks.generateObject.mock.calls[0]?.[0]?.prompt).toContain(
      '<slack_message ts="100.2" sender_slack_id="U123" sender_name="Matt" sender_github="mrubens">',
    );
    expect(mocks.generateObject).toHaveBeenCalledOnce();
    expect(
      mocks.generateObject.mock.calls[0]?.[0]?.schema.description,
    ).toContain('single next Fast mode orchestration action');
    expect(mocks.appendSessionMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'user' }),
          expect.objectContaining({ role: 'assistant' }),
        ]),
      }),
    );
  });

  it('drops an acknowledgement that is immediately replaced by a closeout', async () => {
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
    expect(callbacks.postSlackReply).toHaveBeenCalledOnce();
    expect(callbacks.postSlackReply).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'closeout',
        message: 'It is configured correctly.',
      }),
    );
  });

  it('interleaves multiple Slack replies with integration work before closeout', async () => {
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
          message: "I'll trace that path.",
          purpose: 'ack',
        }),
      })
      .mockResolvedValueOnce({
        object: decision({
          action: 'call_integration',
          message: null,
          purpose: null,
          integrationId: 'github',
          toolName: 'search_code',
          toolArguments: JSON.stringify({ query: 'fast agent' }),
        }),
      })
      .mockResolvedValueOnce({
        object: decision({
          message: 'I found the orchestration boundary and am checking it.',
          purpose: 'progress',
        }),
      })
      .mockResolvedValueOnce({
        object: decision({ message: 'The lifecycle is configured correctly.' }),
      });
    mocks.callIntegration.mockResolvedValue({ matches: ['fast-agent.ts'] });
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
    });

    expect(result).toBe('The lifecycle is configured correctly.');
    expect(mocks.generateObject).toHaveBeenCalledTimes(4);
    expect(mocks.callIntegration).toHaveBeenCalledOnce();
    expect(mocks.callIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      expect.any(Array),
      {
        integrationId: 'github',
        toolName: 'search_code',
        args: { query: 'fast agent' },
      },
    );
    expect(callbacks.postSlackReply).toHaveBeenCalledTimes(2);
    expect(callbacks.postSlackReply).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ purpose: 'ack' }),
    );
    expect(callbacks.postSlackReply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ purpose: 'closeout' }),
    );
    expect(mocks.generateObject.mock.calls[1]?.[0]?.prompt).toContain(
      'The turn is still open',
    );
    expect(mocks.generateObject.mock.calls[3]?.[0]?.prompt).toContain(
      'Purpose: progress',
    );
  });

  it('ends the turn after a clarification reply', async () => {
    mocks.generateObject.mockResolvedValueOnce({
      object: decision({
        message: 'Which repository should I inspect?',
        purpose: 'clarification',
      }),
    });
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
    });

    expect(result).toBe('Which repository should I inspect?');
    expect(mocks.generateObject).toHaveBeenCalledOnce();
    expect(callbacks.postSlackReply).toHaveBeenCalledOnce();
    expect(callbacks.postSlackReply).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'clarification' }),
    );
  });

  it('allows at most one terminal reply for a delegated-task platform event', async () => {
    mocks.generateObject
      .mockResolvedValueOnce({
        object: decision({
          message: 'Visual proof is ready.',
          purpose: 'progress',
          imageArtifactIds: ['artifact-1'],
        }),
      })
      .mockResolvedValueOnce({
        object: decision({
          message: 'The hedgehog is visible in the selection screen.',
          purpose: 'closeout',
          imageArtifactIds: ['artifact-1'],
        }),
      });
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      question:
        '<delegated_task_event>{"type":"artifact_published"}</delegated_task_event>',
      platformEvent: true,
      ...callbacks,
    });

    expect(result).toBe('The hedgehog is visible in the selection screen.');
    expect(callbacks.postSlackReply).toHaveBeenCalledOnce();
    expect(callbacks.postSlackReply).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'closeout',
        imageArtifactIds: ['artifact-1'],
      }),
    );
    expect(mocks.generateObject.mock.calls[1]?.[0]?.prompt).toContain(
      'may emit at most one chat reply',
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
      purpose: 'closeout',
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
    expect(callbacks.postSlackReaction).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'ack' }),
    );
    expect(callbacks.postSlackReply).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'closeout',
        message: 'I found the answer.',
      }),
    );
    expect(result).toBe('I found the answer.');
  });

  it('posts one parent kickoff and ends the turn when launching work', async () => {
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
          message:
            'I delegated the regression test and will report the result here. [Follow the task](https://roomote.example/task-1)',
        }),
      });
    const launchTask = successfulLaunchTask();
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
      launchTask,
    });

    expect(launchTask).toHaveBeenCalledWith({
      prompt: 'Add the regression test.',
      environmentId: 'env-1',
      parentSessionId: 'session-1',
      postKickoff: expect.any(Function),
    });
    expect(mocks.generateObject).toHaveBeenCalledTimes(2);
    expect(callbacks.postSlackReply).toHaveBeenCalledOnce();
    expect(callbacks.postSlackReply).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'closeout',
        message:
          'I delegated the regression test and will report the result here. [Follow the task](https://roomote.example/task-1)',
      }),
    );
    expect(result).toContain('[Follow the task]');
  });

  it('reports a queue failure after a persisted parent kickoff without duplicating session history', async () => {
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
          message:
            'I delegated the regression test. [Follow the task](https://roomote.example/task-1)',
        }),
      });
    const launchTask = vi.fn(
      async ({
        postKickoff,
      }: {
        postKickoff: (task: {
          taskId: string;
          taskUrl?: string;
        }) => Promise<void>;
      }) => {
        await postKickoff({
          taskId: 'task-1',
          taskUrl: 'https://roomote.example/task-1',
        });
        throw new Error('queue unavailable');
      },
    );
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
      launchTask,
    });

    expect(callbacks.postSlackReply).toHaveBeenCalledTimes(2);
    expect(result).toContain('could not be queued');
    expect(mocks.appendSessionMessages).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: [
              expect.objectContaining({
                text: 'I posted the task kickoff, but the task could not be queued. Please retry.',
              }),
            ],
          }),
        ],
      }),
    );
  });

  it('fails the launch when the parent kickoff cannot be persisted', async () => {
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
          message:
            'I delegated the regression test. [Follow the task](https://roomote.example/task-1)',
        }),
      });
    mocks.appendSessionMessages.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
      launchTask: successfulLaunchTask(),
    });

    expect(callbacks.postSlackReply).toHaveBeenCalledTimes(2);
    expect(result).toBe(
      'I hit an error while handling that request. Please try again in a moment.',
    );
  });

  it('does not launch another task when one is active and asks the agent to report the result', async () => {
    mocks.getActiveTaskId.mockResolvedValueOnce('task-1');
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
        args: {
          query: 'Matt Rubens @mrubens: What does this service do?',
        },
      },
    );
    expect(mocks.generateObject.mock.calls[0]?.[0]?.prompt).toContain(
      'AUTOMATIC BRAIN PREFLIGHT',
    );
    expect(result).toBe('The code is in the fast-agent module.');
  });

  it('keeps Slack sender context unlinked when persisted identity lookup fails', async () => {
    mocks.getUserIdentity.mockRejectedValueOnce(new Error('database offline'));
    mocks.listIntegrations.mockResolvedValue([
      {
        id: 'gbrain',
        name: 'Brain',
        description: 'Deployment memory',
        tools: [{ name: 'query' }],
      },
    ]);
    mocks.callIntegration.mockResolvedValue({ results: [] });

    await answerFastAgentQuestion({
      ...baseParams,
      ...chatCallbacks(),
    });

    expect(mocks.callIntegration).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Array),
      {
        integrationId: 'gbrain',
        toolName: 'query',
        args: { query: 'What does this service do?' },
      },
    );
    const prompt = mocks.generateObject.mock.calls[0]?.[0]?.prompt;
    expect(prompt).toContain(
      '<slack_message ts="100.2" sender_slack_id="U123" sender_name="Matt">',
    );
    expect(prompt).not.toContain('sender_github=');
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
    expect(callbacks.postSlackReply).toHaveBeenCalledOnce();
    expect(callbacks.postSlackReply).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'closeout', message: result }),
    );
  });

  it('posts an error closeout when inference fails before any visible reply', async () => {
    mocks.generateObject.mockRejectedValueOnce(new Error('Inference failed'));
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
    });

    expect(result).toContain('hit an error');
    expect(callbacks.postSlackReply).toHaveBeenCalledOnce();
    expect(callbacks.postSlackReply).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'closeout', message: result }),
    );
  });

  it('retries a transient inference transport failure before closing out', async () => {
    mocks.generateObject
      .mockRejectedValueOnce(
        new Error(
          'OpenCode structured prompt failed (model openai/example): TypeError: fetch failed',
        ),
      )
      .mockResolvedValueOnce({ object: decision() });
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
    });

    expect(mocks.generateObject).toHaveBeenCalledTimes(2);
    expect(result).toBe('It coordinates incoming requests.');
    expect(callbacks.postSlackReply).toHaveBeenCalledOnce();
    expect(callbacks.postSlackReply).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'closeout', message: result }),
    );
  });

  it('reports a model connection failure after the transient retry fails', async () => {
    mocks.generateObject.mockRejectedValue(
      new Error(
        'OpenCode structured prompt failed (model openai/example): TypeError: fetch failed',
      ),
    );
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
    });

    expect(mocks.generateObject).toHaveBeenCalledTimes(2);
    expect(result).toBe(
      'Fast mode could not reach the model after retrying. Please try again in a moment.',
    );
    expect(callbacks.postSlackReply).toHaveBeenCalledOnce();
    expect(callbacks.postSlackReply).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'closeout', message: result }),
    );
  });
});
