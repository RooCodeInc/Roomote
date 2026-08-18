const {
  buildSlackRoutingContextMock,
  routeTaskMock,
  enqueueTaskMock,
  findActiveSlackTaskRunMock,
  classifyFollowUpMock,
  resolveRoutingFollowUpMock,
  getTaskUrlMock,
  repositoriesFindManyMock,
  environmentsFindManyMock,
  environmentsFindFirstMock,
  selectLimitMock,
  dbUpdateWhereMock,
  evalMock,
  hsetMock,
  redisSetMock,
  redisGetMock,
  redisGetdelMock,
  redisHgetMock,
  redisDelMock,
  hasMessageInThreadMock,
  fetchThreadMessagesMock,
  normalizeIncomingTextMock,
  getChannelNameMock,
  postMessageMock,
  updateMessageMock,
  addReactionMock,
  removeReactionMock,
  postRouterDebugMessageMock,
  postRouterFallbackDebugMessageMock,
  setSlackStartedMessageTsMock,
  deliveryTrackerCommitMock,
} = vi.hoisted(() => ({
  buildSlackRoutingContextMock: vi.fn(),
  routeTaskMock: vi.fn(),
  enqueueTaskMock: vi.fn(),
  findActiveSlackTaskRunMock: vi.fn(),
  classifyFollowUpMock: vi.fn(),
  resolveRoutingFollowUpMock: vi.fn(),
  getTaskUrlMock: vi.fn(),
  repositoriesFindManyMock: vi.fn(),
  environmentsFindManyMock: vi.fn(),
  environmentsFindFirstMock: vi.fn(),
  selectLimitMock: vi.fn(),
  dbUpdateWhereMock: vi.fn(),
  evalMock: vi.fn(),
  hsetMock: vi.fn(),
  redisSetMock: vi.fn(),
  redisGetMock: vi.fn(),
  redisGetdelMock: vi.fn(),
  redisHgetMock: vi.fn(),
  redisDelMock: vi.fn(),
  hasMessageInThreadMock: vi.fn(),
  fetchThreadMessagesMock: vi.fn(),
  normalizeIncomingTextMock: vi.fn(),
  getChannelNameMock: vi.fn(),
  postMessageMock: vi.fn(),
  updateMessageMock: vi.fn(),
  addReactionMock: vi.fn(),
  removeReactionMock: vi.fn(),
  postRouterDebugMessageMock: vi.fn(),
  postRouterFallbackDebugMessageMock: vi.fn(),
  setSlackStartedMessageTsMock: vi.fn(),
  deliveryTrackerCommitMock: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildSlackRoutingContext: buildSlackRoutingContextMock,
  routeTask: routeTaskMock,
  enqueueTask: enqueueTaskMock,
  classifyFollowUp: classifyFollowUpMock,
  resolveRoutingFollowUp: resolveRoutingFollowUpMock,
  detectSlackMcpSetupRequirement: vi.fn().mockResolvedValue(null),
  getRoutingAutoConfirmDelayMs: vi.fn(() => 0),
  getTaskUrl: getTaskUrlMock,
}));

vi.mock('../find-active-slack-task-run', () => ({
  findActiveSlackTaskRun: findActiveSlackTaskRunMock,
}));

vi.mock('@roomote/cloud-agents', () => ({
  appendAttachmentTextsToPromptText: vi.fn(
    (input: { text: string; attachmentTexts?: string[] }) =>
      [
        input.text.trim(),
        ...(input.attachmentTexts ?? []).filter(
          (attachmentText) => attachmentText.trim().length > 0,
        ),
      ]
        .filter(Boolean)
        .join('\n\n'),
  ),
  stripLeadingRawSlackMention: vi.fn((text: string) => text),
  stripLeadingSlackProductMention: vi.fn((text: string) => text),
}));

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: {
      APP_ENV: 'production',
      R_APP_URL: 'https://app.example.com',
      TRPC_URL: 'https://api.example.com',
    },
  };
});

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  taskRuns: { id: 'id' },
  db: {
    query: {
      repositories: {
        findMany: repositoriesFindManyMock,
      },
      environments: {
        findMany: environmentsFindManyMock,
        findFirst: environmentsFindFirstMock,
      },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: selectLimitMock,
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: dbUpdateWhereMock,
      })),
    })),
  },
  environments: { id: 'id', orgId: 'orgId', isEval: 'isEval' },
  repositories: { orgId: 'orgId', isActive: 'isActive' },
  slackInstallations: { teamId: 'teamId' },
  slackUserMappings: { slackTeamId: 'slackTeamId', slackUserId: 'slackUserId' },
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  inArray: vi.fn((...args: unknown[]) => ({ inArray: args })),
  not: vi.fn((...args: unknown[]) => ({ not: args })),
  recordTaskKickoffMessageBestEffort: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@roomote/redis', () => ({
  REDIS_KEYS: {
    PENDING_WORKSPACE_SELECTIONS: 'pending_workspace_selections',
  },
  getRedis: vi.fn(() => ({
    eval: evalMock,
    hset: hsetMock,
    set: redisSetMock,
    del: redisDelMock,
    get: redisGetMock,
    getdel: redisGetdelMock,
    hget: redisHgetMock,
    exists: vi.fn(),
  })),
}));

vi.mock('../router-debug', () => ({
  postRouterDebugMessage: postRouterDebugMessageMock,
  postRouterFallbackDebugMessage: postRouterFallbackDebugMessageMock,
}));

vi.mock('../slack-messages', () => ({
  setQueuedSlackStartedMessageTs: vi.fn(),
  setSlackStartedMessageTs: setSlackStartedMessageTsMock,
}));

vi.mock('../slack-thread-delivery-tracker', () => ({
  SlackThreadDeliveryTracker: vi.fn().mockImplementation(function () {
    return {
      track: vi.fn(),
      trackAll: vi.fn(),
      commit: deliveryTrackerCommitMock,
    };
  }),
}));

vi.mock('../slack-notifier', () => ({
  SlackNotifier: vi.fn().mockImplementation(function () {
    return {
      hasMessageInThread: hasMessageInThreadMock,
      fetchThreadMessages: fetchThreadMessagesMock,
      getMessagePermalink: vi.fn().mockResolvedValue(null),
      normalizeIncomingText: normalizeIncomingTextMock,
      getChannelName: getChannelNameMock,
      postMessage: postMessageMock,
      updateMessage: updateMessageMock,
      addReaction: addReactionMock,
      removeReaction: removeReactionMock,
      deleteMessage: vi.fn(),
    };
  }),
}));

import { SlackNotifier } from '../slack-notifier';
import {
  handleTaskConfiguration,
  handleRoutingRejectNo,
  handleSlackRoutingCorrection,
  showTaskConfiguration,
  SLACK_ROUTING_UNAVAILABLE_NOTICE,
} from '../block-kit';

describe('Slack deleted-mention suppression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repositoriesFindManyMock.mockResolvedValue([
      {
        name: 'App Repo',
        fullName: 'owner/repo',
        description: 'repo',
      },
    ]);
    environmentsFindManyMock.mockResolvedValue([
      {
        id: 'env_1',
        name: 'App',
        description: 'App env',
        config: { repositories: [{ repository: 'owner/repo' }] },
      },
    ]);
    environmentsFindFirstMock.mockResolvedValue({
      id: 'env_1',
      name: 'App',
      config: { repositories: [{ repository: 'owner/repo' }] },
    });
    buildSlackRoutingContextMock.mockResolvedValue({
      availableEnvironments: [{}],
    });
    routeTaskMock.mockResolvedValue({
      status: 'routed',
      result: {
        workspace: {
          type: 'environment',
          id: 'env_1',
        },
        workspaceOnly: true,
        reasoning: 'Use the App workspace.',
        debug: {
          phase: 'direct',
          toolsUsed: [],
          needsExternalLookup: false,
          confidence: 0.95,
          workspaceRemapped: false,
        },
      },
    });
    findActiveSlackTaskRunMock.mockResolvedValue(null);
    enqueueTaskMock.mockResolvedValue({ id: 42, taskId: 'task_123' });
    normalizeIncomingTextMock.mockImplementation(async (text: string) => text);
    getChannelNameMock.mockResolvedValue('eng-routing');
    fetchThreadMessagesMock.mockResolvedValue([]);
    hasMessageInThreadMock.mockResolvedValue(true);
    postMessageMock.mockResolvedValue('999.000');
    updateMessageMock.mockResolvedValue(true);
    addReactionMock.mockResolvedValue(true);
    removeReactionMock.mockResolvedValue(true);
    dbUpdateWhereMock.mockResolvedValue(undefined);
    hsetMock.mockResolvedValue(1);
    redisSetMock.mockResolvedValue('OK');
    redisGetMock.mockResolvedValue(null);
    redisGetdelMock.mockResolvedValue(null);
    redisHgetMock.mockResolvedValue(null);
    redisDelMock.mockResolvedValue(1);
    classifyFollowUpMock.mockResolvedValue({
      intent: 'correct',
      reasoning: 'user supplied a correction',
    });
    resolveRoutingFollowUpMock.mockImplementation(
      async (input: {
        suggestion: Record<string, unknown> | null;
        userResponse: string;
        userId?: string | null;
        correctionMessage?: { user: string; text: string };
        buildCorrectionContext: () => Promise<Record<string, unknown>>;
      }) => {
        const classification = await classifyFollowUpMock({
          suggestedWorkspace:
            input.suggestion?.workspaceDisplayName ?? 'the workspace picker',
          userResponse: input.userResponse,
          userId: input.userId,
        });
        if (classification.intent !== 'correct') {
          return { intent: classification.intent };
        }
        const context = await input.buildCorrectionContext();
        return {
          intent: 'correct',
          routingDecision: await routeTaskMock({
            ...context,
            ...(input.suggestion
              ? { previousSuggestion: input.suggestion }
              : {}),
          }),
        };
      },
    );
    setSlackStartedMessageTsMock.mockResolvedValue(undefined);
    deliveryTrackerCommitMock.mockResolvedValue(undefined);
    getTaskUrlMock.mockReturnValue('https://app.example.com/task/task_123');
  });

  it('does not start an immediate routed task after the source message is deleted', async () => {
    hasMessageInThreadMock.mockResolvedValue(false);
    const slack = new SlackNotifier('xoxb-test');

    const result = await showTaskConfiguration({
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> investigate this',
        ts: '111.222',
      },
      slackInstallation: {
        teamId: 'T123',
      } as never,
      userMapping: {
        userId: 'user_1',
      } as never,
      slack: slack as never,
    });

    expect(result).toEqual({ routingUsed: false, threadId: '111.222' });
    expect(hasMessageInThreadMock).toHaveBeenCalledWith({
      channel: 'C123',
      threadTs: '111.222',
      messageTs: '111.222',
    });
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(postMessageMock).not.toHaveBeenCalled();
    expect(hsetMock).not.toHaveBeenCalled();
  });

  it('asks the user to create an environment when no repositories are configured', async () => {
    repositoriesFindManyMock.mockResolvedValue([]);
    const slack = new SlackNotifier('xoxb-test');

    const result = await showTaskConfiguration({
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> investigate this',
        ts: '111.222',
      },
      slackInstallation: {
        teamId: 'T123',
      } as never,
      userMapping: {
        userId: 'user_1',
      } as never,
      slack: slack as never,
    });

    expect(result).toEqual({ routingUsed: false, threadId: '111.222' });
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Roomote needs an environment before it can start Slack tasks.',
        blocks: expect.arrayContaining([
          expect.objectContaining({
            text: expect.objectContaining({
              text: expect.stringContaining(
                'create an environment with at least one repository',
              ),
            }),
          }),
        ]),
      }),
    );
    expect(
      JSON.stringify(postMessageMock.mock.calls.at(-1)?.[0] ?? {}),
    ).not.toMatch(/Cloud Agents|background agents/);
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });

  it('starts immediate routed tasks without passing pre-classified requested work kind', async () => {
    const slack = new SlackNotifier('xoxb-test');

    const result = await showTaskConfiguration({
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> investigate this',
        ts: '111.222',
      },
      slackInstallation: {
        teamId: 'T123',
      } as never,
      userMapping: {
        userId: 'user_1',
      } as never,
      slack: slack as never,
    });

    expect(result).toEqual({
      routingUsed: true,
      threadId: '111.222',
      startedImmediately: true,
    });
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: expect.objectContaining({
          slackThreadTs: '111.222',
        }),
      }),
      expect.anything(),
    );
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.not.objectContaining({
          requestedWorkKindDecision: expect.anything(),
        }),
      }),
      expect.anything(),
    );
  });

  it('includes existing replies when a task starts from the thread root', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      {
        user: 'U123',
        text: '<@BOT> investigate this',
        ts: '111.222',
      },
      {
        user: 'U456',
        text: '<@BOT> use the failure details in this reply',
        ts: '111.333',
      },
    ]);
    const slack = new SlackNotifier('xoxb-test');

    await showTaskConfiguration({
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> investigate this',
        ts: '111.222',
      },
      slackInstallation: {
        teamId: 'T123',
        botUserId: 'BOT',
      } as never,
      userMapping: {
        userId: 'user_1',
      } as never,
      slack: slack as never,
    });

    expect(fetchThreadMessagesMock).toHaveBeenCalledWith({
      channel: 'C123',
      threadTs: '111.222',
    });
    expect(buildSlackRoutingContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadMessages: [
          { user: 'U123', text: '<@BOT> investigate this' },
          {
            user: 'U456',
            text: '<@BOT> use the failure details in this reply',
          },
        ],
      }),
    );
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            threadMessages: [
              expect.objectContaining({ ts: '111.222' }),
              expect.objectContaining({ ts: '111.333' }),
            ],
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it('includes root-thread replies after manual workspace selection', async () => {
    const originalEvent = {
      type: 'app_mention',
      channel: 'C123',
      user: 'U123',
      text: '<@BOT> investigate this',
      ts: '111.222',
    };
    evalMock.mockResolvedValueOnce(JSON.stringify(originalEvent));
    selectLimitMock
      .mockResolvedValueOnce([
        {
          teamId: 'T123',
          teamDomain: 'acme',
          botUserId: 'BOT',
          botAccessToken: 'xoxb-test',
        },
      ])
      .mockResolvedValueOnce([{ userId: 'user_1' }]);
    fetchThreadMessagesMock.mockResolvedValue([
      { ...originalEvent },
      {
        type: 'message',
        user: 'U456',
        text: '<@BOT> use the failure details in this reply',
        ts: '111.333',
      },
    ]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await handleTaskConfiguration({
        type: 'block_actions',
        team: { id: 'T123', domain: 'acme' },
        user: { id: 'U123', name: 'alice' },
        channel: { id: 'C123', name: 'engineering' },
        message: { ts: '999.000', thread_ts: '111.222' },
        actions: [],
        state: {
          values: {
            workspace_selection: {
              workspace_selection: {
                type: 'static_select',
                selected_option: {
                  text: { text: 'App' },
                  value: 'env:env_1',
                },
              },
            },
          },
        },
        response_url: 'https://slack.test/response',
        trigger_id: 'trigger-1',
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchThreadMessagesMock).toHaveBeenCalledWith({
      channel: 'C123',
      threadTs: '111.222',
    });
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            threadMessages: [
              expect.objectContaining({ ts: '111.222' }),
              expect.objectContaining({ ts: '111.333' }),
            ],
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it('filters eval environments out of the workspace picker query', async () => {
    const slack = new SlackNotifier('xoxb-test');

    await showTaskConfiguration({
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> investigate this',
        ts: '111.222',
      },
      slackInstallation: {
        teamId: 'T123',
      } as never,
      userMapping: {
        userId: 'user_1',
      } as never,
      slack: slack as never,
    });

    expect(environmentsFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          eq: ['isEval', false],
        },
      }),
    );
  });

  it('includes processed video descriptions in routing and the launched task text', async () => {
    const slack = new SlackNotifier('xoxb-test');

    await showTaskConfiguration({
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> investigate this',
        ts: '111.222',
        processedVideoDescriptions: [
          'The user opens the modal and a permission error is shown.',
        ],
      },
      slackInstallation: {
        teamId: 'T123',
      } as never,
      userMapping: {
        userId: 'user_1',
      } as never,
      slack: slack as never,
    });

    expect(buildSlackRoutingContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelName: 'eng-routing',
        videoDescriptions: [
          'The user opens the modal and a permission error is shown.',
        ],
      }),
    );
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            text: '<@BOT> investigate this\n\nVideo attachment descriptions:\n- Video 1: The user opens the modal and a permission error is shown.',
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it('removes the eyes reaction after posting a platform answer during initial routing', async () => {
    routeTaskMock.mockResolvedValue({
      status: 'platform_answer',
      result: {
        answer:
          '**I can help here.**\n- Ask me where to start\n- I can route deeper work',
      },
    });

    const slack = new SlackNotifier('xoxb-test');

    const result = await showTaskConfiguration({
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> what can you do?',
        ts: '111.222',
      },
      slackInstallation: {
        teamId: 'T123',
      } as never,
      userMapping: {
        userId: 'user_1',
      } as never,
      slack: slack as never,
    });

    expect(result).toEqual({ routingUsed: false, threadId: '111.222' });
    expect(postMessageMock).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '111.222',
      text: '**I can help here.**\n- Ask me where to start\n- I can route deeper work',
      blocks: [
        {
          type: 'markdown',
          text: '**I can help here.**\n- Ask me where to start\n- I can route deeper work',
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: '_Learn more in the <https://docs.roomote.dev|docs>._',
            },
          ],
        },
      ],
    });
    expect(removeReactionMock).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: '111.222',
      name: 'eyes',
    });
    expect(addReactionMock).not.toHaveBeenCalled();
  });

  it('adds and removes the eyes reaction around platform answers for routing corrections', async () => {
    const originalEvent = {
      type: 'app_mention',
      channel: 'C123',
      user: 'U123',
      text: '<@BOT> do this in app',
      ts: '111.222',
    };

    evalMock
      .mockResolvedValueOnce(
        JSON.stringify({
          agentName: 'Roomote',
          workspaceOnly: true,
          workspaceValue: 'env:env_1',
          workspaceDisplayName: 'App',
          workspaceType: 'environment',
          teamId: 'T123',
          slackUserId: 'U123',
          channel: 'C123',
          threadMessages: [],
          confirmMessageTs: '999.000',
          confirmNonce: 'nonce-1',
        }),
      )
      .mockResolvedValueOnce(JSON.stringify(originalEvent));
    routeTaskMock.mockResolvedValue({
      status: 'platform_answer',
      result: {
        answer:
          '**I can help with that.**\n- I route coding work\n- I support Slack, GitHub, and Linear',
      },
    });

    const slack = new SlackNotifier('xoxb-test');

    const result = await handleSlackRoutingCorrection({
      threadId: '111.222',
      correctionText: 'Actually, what can you do?',
      event: originalEvent as never,
      slackInstallation: {
        teamId: 'T123',
      } as never,
      userMapping: {
        userId: 'user_1',
      } as never,
      slack: slack as never,
    });

    expect(result).toEqual({ handled: true });
    expect(getChannelNameMock).toHaveBeenCalledWith('C123');
    expect(buildSlackRoutingContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelName: 'eng-routing',
      }),
    );
    expect(addReactionMock).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: '111.222',
      name: 'eyes',
    });
    expect(updateMessageMock).toHaveBeenCalledWith({
      channel: 'C123',
      ts: '999.000',
      message: {
        text: '**I can help with that.**\n- I route coding work\n- I support Slack, GitHub, and Linear',
        blocks: [
          {
            type: 'markdown',
            text: '**I can help with that.**\n- I route coding work\n- I support Slack, GitHub, and Linear',
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '_Learn more in the <https://docs.roomote.dev|docs>._',
              },
            ],
          },
        ],
      },
    });
    expect(removeReactionMock).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: '111.222',
      name: 'eyes',
    });
  });

  it('stores and shows the warning when falling back to the manual workspace picker', async () => {
    const slack = new SlackNotifier('xoxb-test');

    await showTaskConfiguration({
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> investigate this',
        ts: '111.222',
      },
      slackInstallation: {
        teamId: 'T123',
      } as never,
      userMapping: {
        userId: 'user_1',
      } as never,
      slack: slack as never,
      skipRouting: true,
    });

    expect(hsetMock).toHaveBeenCalledWith(
      'pending_workspace_selections',
      '111.222',
      expect.stringContaining('"text":"<@BOT> investigate this"'),
    );
  });

  it('includes root-thread replies when skipped routing starts the only workspace immediately', async () => {
    environmentsFindManyMock.mockResolvedValue([]);
    fetchThreadMessagesMock.mockResolvedValue([
      {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> investigate this',
        ts: '111.222',
      },
      {
        type: 'message',
        user: 'U456',
        text: '<@BOT> use these failure details too',
        ts: '111.333',
      },
    ]);
    const slack = new SlackNotifier('xoxb-test');

    const result = await showTaskConfiguration({
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> investigate this',
        ts: '111.222',
      },
      slackInstallation: {
        teamId: 'T123',
        botUserId: 'BOT',
      } as never,
      userMapping: {
        userId: 'user_1',
      } as never,
      slack: slack as never,
      skipRouting: true,
    });

    expect(result).toEqual({
      routingUsed: false,
      threadId: '111.222',
      startedImmediately: true,
    });
    expect(fetchThreadMessagesMock).toHaveBeenCalledWith({
      channel: 'C123',
      threadTs: '111.222',
    });
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            threadMessages: [
              expect.objectContaining({ ts: '111.222' }),
              expect.objectContaining({ ts: '111.333' }),
            ],
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it('warns in the picker and posts fallback diagnostics when routing fails with an exception', async () => {
    routeTaskMock.mockResolvedValueOnce({
      status: 'fallback',
      reason: 'OpenCode structured prompt failed: APIError: Key limit exceeded',
      cause: 'exception',
    });
    const slack = new SlackNotifier('xoxb-test');

    await showTaskConfiguration({
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> investigate this',
        ts: '111.222',
      },
      slackInstallation: {
        teamId: 'T123',
      } as never,
      userMapping: {
        userId: 'user_1',
      } as never,
      slack: slack as never,
    });

    expect(postRouterFallbackDebugMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'Slack C123',
        reason:
          'OpenCode structured prompt failed: APIError: Key limit exceeded',
        cause: 'exception',
      }),
    );
    expect(JSON.stringify(postMessageMock.mock.calls)).toContain(
      SLACK_ROUTING_UNAVAILABLE_NOTICE,
    );
  });

  it('treats a thrown routeTask error as an exception fallback with a warning', async () => {
    routeTaskMock.mockRejectedValueOnce(new Error('router transport failed'));
    const slack = new SlackNotifier('xoxb-test');

    await showTaskConfiguration({
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> investigate this',
        ts: '111.222',
      },
      slackInstallation: {
        teamId: 'T123',
      } as never,
      userMapping: {
        userId: 'user_1',
      } as never,
      slack: slack as never,
    });

    expect(postRouterFallbackDebugMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'router transport failed',
        cause: 'exception',
      }),
    );
    expect(JSON.stringify(postMessageMock.mock.calls)).toContain(
      SLACK_ROUTING_UNAVAILABLE_NOTICE,
    );
  });

  it('does not blame the routing infrastructure when Slack context setup fails', async () => {
    getChannelNameMock.mockRejectedValueOnce(
      new Error('channels.info unavailable'),
    );
    const slack = new SlackNotifier('xoxb-test');

    await showTaskConfiguration({
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> investigate this',
        ts: '111.222',
      },
      slackInstallation: {
        teamId: 'T123',
      } as never,
      userMapping: {
        userId: 'user_1',
      } as never,
      slack: slack as never,
    });

    expect(routeTaskMock).not.toHaveBeenCalled();
    expect(postRouterFallbackDebugMessageMock).not.toHaveBeenCalled();
    expect(JSON.stringify(postMessageMock.mock.calls)).not.toContain(
      SLACK_ROUTING_UNAVAILABLE_NOTICE,
    );
  });

  it('shows the plain picker without a warning when the router declined to pick', async () => {
    routeTaskMock.mockResolvedValueOnce({
      status: 'fallback',
      reason:
        'Could not map routed environment "Unknown" to an available environment.',
      cause: 'model_decision',
    });
    const slack = new SlackNotifier('xoxb-test');

    await showTaskConfiguration({
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> investigate this',
        ts: '111.222',
      },
      slackInstallation: {
        teamId: 'T123',
      } as never,
      userMapping: {
        userId: 'user_1',
      } as never,
      slack: slack as never,
    });

    expect(postRouterFallbackDebugMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'model_decision' }),
    );
    expect(JSON.stringify(postMessageMock.mock.calls)).not.toContain(
      SLACK_ROUTING_UNAVAILABLE_NOTICE,
    );
  });

  it('shows the routing-unavailable warning above the picker when the caller passes one', async () => {
    const slack = new SlackNotifier('xoxb-test');

    await showTaskConfiguration({
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> investigate this',
        ts: '111.222',
      },
      slackInstallation: {
        teamId: 'T123',
      } as never,
      userMapping: {
        userId: 'user_1',
      } as never,
      slack: slack as never,
      skipRouting: true,
      routingFailureNoticeText: SLACK_ROUTING_UNAVAILABLE_NOTICE,
    });

    expect(routeTaskMock).not.toHaveBeenCalled();
    expect(JSON.stringify(postMessageMock.mock.calls)).toContain(
      SLACK_ROUTING_UNAVAILABLE_NOTICE,
    );
  });

  it('drops the rejected environment kickoff before showing the manual picker', async () => {
    evalMock.mockResolvedValueOnce(
      JSON.stringify({
        agentName: 'Default',
        workspaceValue: 'env_1',
        workspaceDisplayName: 'App',
        kickoffMessage: 'Investigating the issue in App.',
        workspaceType: 'environment',
        teamId: 'T123',
        slackUserId: 'U123',
        channel: 'C123',
        confirmNonce: 'nonce-1',
      }),
    );
    redisHgetMock.mockResolvedValueOnce(
      JSON.stringify({
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> investigate this',
        ts: '111.222',
      }),
    );
    selectLimitMock
      .mockResolvedValueOnce([{ teamId: 'T123', botAccessToken: 'xoxb-test' }])
      .mockResolvedValueOnce([{ userId: 'user_1' }]);

    await handleRoutingRejectNo({
      team: { id: 'T123' },
      user: { id: 'U123' },
      message: { ts: 'routing-message-1' },
      actions: [
        {
          type: 'button',
          value: JSON.stringify({
            threadId: '111.222',
            confirmNonce: 'nonce-1',
          }),
        },
      ],
    } as never);

    const rewrittenPrefill = JSON.parse(
      redisSetMock.mock.calls[0]?.[1] as string,
    );
    expect(rewrittenPrefill).toMatchObject({
      workspaceValue: 'env_1',
      workspaceDisplayName: 'App',
      confirmNonce: expect.any(String),
    });
    expect(rewrittenPrefill.confirmNonce).not.toBe('nonce-1');
    expect(rewrittenPrefill).not.toHaveProperty('kickoffMessage');
  });

  it.each([
    ['returns a fallback', 'fallback'],
    ['throws', 'error'],
  ] as const)(
    'drops the corrected environment kickoff when rerouting %s',
    async (_description, outcome) => {
      const originalEvent = {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> investigate this',
        ts: '111.222',
      };
      evalMock
        .mockResolvedValueOnce(
          JSON.stringify({
            agentName: 'Default',
            workspaceValue: 'env_1',
            workspaceDisplayName: 'App',
            kickoffMessage: 'Investigating the issue in App.',
            workspaceType: 'environment',
            teamId: 'T123',
            slackUserId: 'U123',
            channel: 'C123',
            confirmMessageTs: '999.000',
            confirmNonce: 'nonce-1',
          }),
        )
        .mockResolvedValueOnce(JSON.stringify(originalEvent));
      if (outcome === 'error') {
        routeTaskMock.mockRejectedValueOnce(new Error('router unavailable'));
      } else {
        routeTaskMock.mockResolvedValueOnce({
          status: 'fallback',
          reason: 'No confident route',
        });
      }

      const result = await handleSlackRoutingCorrection({
        threadId: '111.222',
        correctionText: 'Use a different environment',
        event: originalEvent as never,
        slackInstallation: { teamId: 'T123' } as never,
        userMapping: { userId: 'user_1' } as never,
        slack: new SlackNotifier('xoxb-test') as never,
      });

      expect(result).toEqual({ handled: true });
      const rewrittenPrefill = JSON.parse(
        redisSetMock.mock.calls[0]?.[1] as string,
      );
      expect(rewrittenPrefill).toMatchObject({
        workspaceValue: 'env_1',
        workspaceDisplayName: 'App',
        confirmNonce: expect.any(String),
      });
      expect(rewrittenPrefill.confirmNonce).not.toBe('nonce-1');
      expect(rewrittenPrefill).not.toHaveProperty('kickoffMessage');
    },
  );

  it('starts immediately when all repositories are the only fallback workspace option', async () => {
    environmentsFindManyMock.mockResolvedValue([]);
    routeTaskMock.mockResolvedValueOnce({
      status: 'fallback',
      reason: 'No environments are available for routing.',
    });
    const slack = new SlackNotifier('xoxb-test');

    const result = await showTaskConfiguration({
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> what time is it',
        ts: '111.222',
      },
      slackInstallation: {
        teamId: 'T123',
      } as never,
      userMapping: {
        userId: 'user_1',
      } as never,
      slack: slack as never,
    });

    expect(result).toEqual({
      routingUsed: false,
      threadId: '111.222',
      startedImmediately: true,
    });
    expect(hsetMock).not.toHaveBeenCalled();
    expect(enqueueTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            repo: '__all_repositories__',
            text: '<@BOT> what time is it',
          }),
        }),
      }),
      expect.anything(),
    );
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: expect.arrayContaining([
          expect.objectContaining({
            text: expect.objectContaining({
              text: 'Getting started on your task in all repos',
            }),
          }),
        ]),
      }),
    );
  });

  it('ignores routing corrections from a different Slack user', async () => {
    const originalEvent = {
      type: 'app_mention',
      channel: 'C123',
      user: 'U456',
      text: '<@BOT> use the other repo',
      ts: '111.222',
    };

    evalMock.mockResolvedValue(null);

    const slack = new SlackNotifier('xoxb-test');

    const result = await handleSlackRoutingCorrection({
      threadId: '111.222',
      correctionText: 'Actually send it elsewhere',
      event: originalEvent as never,
      slackInstallation: {
        teamId: 'T123',
      } as never,
      userMapping: {
        userId: 'user_2',
      } as never,
      slack: slack as never,
    });

    expect(result).toEqual({ handled: false });
    expect(evalMock).toHaveBeenCalledTimes(1);
    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(postMessageMock).not.toHaveBeenCalled();
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });
});
