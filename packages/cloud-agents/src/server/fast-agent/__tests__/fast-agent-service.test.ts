const mocks = vi.hoisted(() => ({
  appendSessionMessages: vi.fn(),
  getActiveTasks: vi.fn(),
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
  getActiveFastAgentTasks: mocks.getActiveTasks,
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
  launchTask: vi.fn(),
  postSlackReply: vi.fn().mockResolvedValue(undefined),
};

function decision(overrides: Record<string, unknown> = {}) {
  return {
    action: 'send_chat_reply',
    message: 'It coordinates incoming requests.',
    purpose: 'closeout',
    reactionName: null,
    taskPrompt: null,
    environmentId: null,
    taskId: null,
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

function successfulLaunchTask(taskId = 'task-1') {
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
        taskId,
        taskUrl: `https://roomote.example/${taskId}`,
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
    mocks.getActiveTasks.mockResolvedValue([]);
    mocks.getEnvironments.mockResolvedValue([
      {
        id: 'env-1',
        name: 'App',
        repositoryNames: ['acme/app'],
      },
    ]);
    mocks.listIntegrations.mockResolvedValue([]);
    mocks.callIntegration.mockResolvedValue({ status: 'ok' });
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
      currentMessageAgentContext: 'Slack block text:\nState: New',
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
    expect(mocks.generateObject.mock.calls[0]?.[0]?.prompt).toContain(
      '<slack_message_context>\nSlack block text:\nState: New\n</slack_message_context>',
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

  it('lets the orchestration loop report a delegated task terminal error', async () => {
    mocks.generateObject.mockResolvedValueOnce({
      object: decision({
        message:
          'The task stopped because the sandbox provider rejected its credentials. Check the provider configuration before retrying.',
        purpose: 'closeout',
      }),
    });
    const callbacks = chatCallbacks();
    const event = {
      type: 'task_settled',
      taskId: 'task-1',
      runId: 42,
      status: 'failed',
      error: 'The sandbox provider rejected its credentials.',
      taskUrl: 'https://roomote.example/task/task-1',
      pullRequests: [],
    };

    const result = await answerFastAgentQuestion({
      ...baseParams,
      question: `<delegated_task_event>${JSON.stringify(event)}</delegated_task_event>`,
      platformEvent: true,
      ...callbacks,
    });

    expect(mocks.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          'The sandbox provider rejected its credentials.',
        ),
      }),
    );
    expect(result).toContain('Check the provider configuration');
    expect(callbacks.postSlackReply).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'closeout',
        message: expect.stringContaining('Check the provider configuration'),
      }),
    );
  });

  it('lets the parent retry a failed delegated task start before closing out', async () => {
    mocks.generateObject
      .mockResolvedValueOnce({
        object: decision({
          action: 'retry_task_start',
          message: null,
          purpose: null,
        }),
      })
      .mockResolvedValueOnce({
        object: decision({
          message: 'The sandbox startup looked transient, so I retried it.',
          purpose: 'closeout',
        }),
      });
    const callbacks = chatCallbacks();
    const retryTaskStart = vi.fn().mockResolvedValue({
      success: true,
      runId: 43,
    });

    const result = await answerFastAgentQuestion({
      ...baseParams,
      question:
        '<delegated_task_event>{"type":"task_settled","status":"failed","error":"HTTP 503","errorCode":null}</delegated_task_event>',
      platformEvent: true,
      retryTaskStart,
      ...callbacks,
    });

    expect(retryTaskStart).toHaveBeenCalledOnce();
    expect(mocks.generateObject.mock.calls[1]?.[0]?.prompt).toContain(
      '"success":true,"runId":43',
    );
    expect(result).toBe(
      'The sandbox startup looked transient, so I retried it.',
    );
    expect(callbacks.postSlackReply).toHaveBeenCalledOnce();
  });

  it('lets a delegated-task platform event launch a separate task', async () => {
    mocks.generateObject
      .mockResolvedValueOnce({
        object: decision({
          action: 'launch_task',
          message: null,
          purpose: null,
          taskPrompt: 'Investigate the failure with a fresh approach.',
          environmentId: 'env-1',
        }),
      })
      .mockResolvedValueOnce({
        object: decision({
          message:
            'I started a separate investigation. [Follow the task](https://roomote.example/task-2)',
        }),
      });
    const callbacks = chatCallbacks();
    const launchTask = successfulLaunchTask('task-2');

    const result = await answerFastAgentQuestion({
      ...baseParams,
      question:
        '<delegated_task_event>{"type":"task_settled","taskId":"task-1","status":"failed"}</delegated_task_event>',
      platformEvent: true,
      launchTask,
      ...callbacks,
    });

    expect(launchTask).toHaveBeenCalledWith({
      prompt: 'Investigate the failure with a fresh approach.',
      environmentId: 'env-1',
      parentSessionId: 'session-1',
      postKickoff: expect.any(Function),
    });
    expect(result).toContain('task-2');
    expect(callbacks.postSlackReply).toHaveBeenCalledOnce();
  });

  it('keeps ordinary orchestration tools available for platform events', async () => {
    mocks.listIntegrations.mockResolvedValueOnce([
      {
        id: 'deployments',
        name: 'Deployments',
        description: 'Inspect deployments',
        tools: [{ name: 'status', description: 'Get deployment status' }],
      },
    ]);
    mocks.generateObject
      .mockResolvedValueOnce({
        object: decision({
          action: 'call_integration',
          message: null,
          purpose: null,
          integrationId: 'deployments',
          toolName: 'status',
          toolArguments: '{}',
        }),
      })
      .mockResolvedValueOnce({
        object: decision({
          action: 'send_task_message',
          message: null,
          purpose: null,
          taskId: 'task-2',
          taskMessage: 'Keep working.',
        }),
      })
      .mockResolvedValueOnce({
        object: decision({
          action: 'cancel_task',
          message: null,
          purpose: null,
          taskId: 'task-2',
        }),
      })
      .mockResolvedValueOnce({
        object: decision({ message: 'I handled the task update.' }),
      });
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      question:
        '<delegated_task_event>{"type":"task_settled","taskId":"task-1","status":"failed"}</delegated_task_event>',
      platformEvent: true,
      activeTasks: [{ taskId: 'task-2', title: 'Other work' }],
      ...callbacks,
    });

    expect(mocks.callIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      expect.any(Array),
      {
        integrationId: 'deployments',
        toolName: 'status',
        args: {},
      },
    );
    expect(mocks.sendTaskMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      { taskId: 'task-2', message: 'Keep working.' },
    );
    expect(mocks.cancelTask).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      'task-2',
    );
    expect(callbacks.postSlackReply).toHaveBeenCalledOnce();
    expect(result).toBe('I handled the task update.');
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

  it('launches independent work while another delegated task is active', async () => {
    mocks.getActiveTasks.mockResolvedValueOnce([
      { taskId: 'task-1', title: 'Fix the API' },
    ]);
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
            'I delegated the regression test. [Follow the task](https://roomote.example/task-2)',
        }),
      });
    const launchTask = successfulLaunchTask('task-2');
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
      launchTask,
    });

    expect(launchTask).toHaveBeenCalledOnce();
    expect(result).toContain('task-2');
  });

  it('sends an explicit instruction to the selected active task before replying', async () => {
    mocks.generateObject
      .mockResolvedValueOnce({
        object: decision({
          action: 'send_task_message',
          message: null,
          purpose: null,
          taskMessage: 'Also add a regression test.',
          taskId: 'task-2',
        }),
      })
      .mockResolvedValueOnce({
        object: decision({ message: 'I sent that instruction.' }),
      });
    const callbacks = chatCallbacks();

    await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
      activeTasks: [
        { taskId: 'task-1', title: 'Fix the API' },
        { taskId: 'task-2', title: 'Update the docs' },
      ],
    });

    expect(mocks.sendTaskMessage).toHaveBeenCalledWith(
      { userId: 'user-1', apiBaseUrl: 'https://api.example.com' },
      { taskId: 'task-2', message: 'Also add a regression test.' },
    );
    expect(callbacks.postSlackReply).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'I sent that instruction.' }),
    );
  });

  it('preserves implicit routing when exactly one task is active', async () => {
    mocks.getActiveTasks.mockResolvedValueOnce([
      { taskId: 'task-1', title: 'Fix the API' },
    ]);
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

    await answerFastAgentQuestion({
      ...baseParams,
      ...chatCallbacks(),
    });

    expect(mocks.sendTaskMessage).toHaveBeenCalledWith(
      { userId: 'user-1', apiBaseUrl: 'https://api.example.com' },
      { taskId: 'task-1', message: 'Also add a regression test.' },
    );
  });

  it('cancels the active task before reporting the result', async () => {
    mocks.generateObject
      .mockResolvedValueOnce({
        object: decision({
          action: 'cancel_task',
          message: null,
          purpose: null,
          taskId: 'task-1',
        }),
      })
      .mockResolvedValueOnce({
        object: decision({ message: 'I canceled the active task.' }),
      });
    const callbacks = chatCallbacks();

    await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
      activeTasks: [
        { taskId: 'task-1', title: 'Fix the API' },
        { taskId: 'task-2', title: 'Update the docs' },
      ],
    });

    expect(mocks.cancelTask).toHaveBeenCalledWith(
      { userId: 'user-1', apiBaseUrl: 'https://api.example.com' },
      'task-1',
    );
    expect(mocks.cancelTask).not.toHaveBeenCalledWith(
      expect.anything(),
      'task-2',
    );
    expect(callbacks.postSlackReply).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'I canceled the active task.' }),
    );
  });

  it('asks which task the user means instead of routing an ambiguous follow-up', async () => {
    mocks.getActiveTasks.mockResolvedValueOnce([
      { taskId: 'task-1', title: 'Fix the API' },
      { taskId: 'task-2', title: 'Update the docs' },
    ]);
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
        object: decision({
          message: 'Which active task should receive that instruction?',
          purpose: 'clarification',
        }),
      });
    const callbacks = chatCallbacks();

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...callbacks,
    });

    expect(mocks.sendTaskMessage).not.toHaveBeenCalled();
    expect(result).toContain('Which active task');
    expect(callbacks.postSlackReply).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'clarification' }),
    );
    expect(mocks.generateObject.mock.calls[1]?.[0]?.prompt).toContain(
      'Multiple delegated tasks are active',
    );
  });

  it('asks which task the user means instead of canceling ambiguously', async () => {
    mocks.getActiveTasks.mockResolvedValueOnce([
      { taskId: 'task-1', title: 'Fix the API' },
      { taskId: 'task-2', title: 'Update the docs' },
    ]);
    mocks.generateObject
      .mockResolvedValueOnce({
        object: decision({
          action: 'cancel_task',
          message: null,
          purpose: null,
        }),
      })
      .mockResolvedValueOnce({
        object: decision({
          message: 'Which active task should I cancel?',
          purpose: 'clarification',
        }),
      });

    const result = await answerFastAgentQuestion({
      ...baseParams,
      ...chatCallbacks(),
    });

    expect(mocks.cancelTask).not.toHaveBeenCalled();
    expect(result).toContain('Which active task');
    expect(mocks.generateObject.mock.calls[1]?.[0]?.prompt).toContain(
      'before canceling',
    );
  });

  it('does not route task controls when no task is active', async () => {
    mocks.generateObject
      .mockResolvedValueOnce({
        object: decision({
          action: 'send_task_message',
          message: null,
          purpose: null,
          taskMessage: 'Please retry.',
        }),
      })
      .mockResolvedValueOnce({
        object: decision({ message: 'There is no active delegated task.' }),
      });

    await answerFastAgentQuestion({
      ...baseParams,
      ...chatCallbacks(),
    });

    expect(mocks.sendTaskMessage).not.toHaveBeenCalled();
    expect(mocks.cancelTask).not.toHaveBeenCalled();
  });

  it('keeps other active tasks routable after canceling one task', async () => {
    mocks.getActiveTasks.mockResolvedValueOnce([
      { taskId: 'task-1', title: 'Fix the API' },
      { taskId: 'task-2', title: 'Update the docs' },
    ]);
    mocks.generateObject
      .mockResolvedValueOnce({
        object: decision({
          action: 'cancel_task',
          message: null,
          purpose: null,
          taskId: 'task-1',
        }),
      })
      .mockResolvedValueOnce({
        object: decision({
          action: 'send_task_message',
          message: null,
          purpose: null,
          taskId: null,
          taskMessage: 'Please add the final example.',
        }),
      })
      .mockResolvedValueOnce({
        object: decision({
          message: 'I canceled the API task and updated the docs task.',
        }),
      });

    await answerFastAgentQuestion({
      ...baseParams,
      ...chatCallbacks(),
    });

    expect(mocks.cancelTask).toHaveBeenCalledWith(
      { userId: 'user-1', apiBaseUrl: 'https://api.example.com' },
      'task-1',
    );
    expect(mocks.sendTaskMessage).toHaveBeenCalledWith(
      { userId: 'user-1', apiBaseUrl: 'https://api.example.com' },
      { taskId: 'task-2', message: 'Please add the final example.' },
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
