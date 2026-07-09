const {
  buildSlackRoutingContextMock,
  routeTaskMock,
  enqueueCloudTaskMock,
  findActiveSlackJobMock,
  classifyFollowUpMock,
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
  setSlackStartedMessageTsMock,
  deliveryTrackerCommitMock,
  getSlackEmojiPreferencesForDeploymentMock,
} = vi.hoisted(() => ({
  buildSlackRoutingContextMock: vi.fn(),
  routeTaskMock: vi.fn(),
  enqueueCloudTaskMock: vi.fn(),
  findActiveSlackJobMock: vi.fn(),
  classifyFollowUpMock: vi.fn(),
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
  setSlackStartedMessageTsMock: vi.fn(),
  deliveryTrackerCommitMock: vi.fn(),
  getSlackEmojiPreferencesForDeploymentMock: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildSlackRoutingContext: buildSlackRoutingContextMock,
  routeTask: routeTaskMock,
  enqueueCloudTask: enqueueCloudTaskMock,
  classifyFollowUp: classifyFollowUpMock,
  detectSlackMcpSetupRequirement: vi.fn().mockResolvedValue(null),
  getTaskUrl: getTaskUrlMock,
}));

vi.mock('../find-active-slack-job', () => ({
  findActiveSlackJob: findActiveSlackJobMock,
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
      ROOMOTE_APP_URL: 'https://app.example.com',
      TRPC_URL: 'https://api.example.com',
    },
  };
});

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  cloudJobs: { id: 'id' },
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
  getSlackEmojiPreferencesForDeployment:
    getSlackEmojiPreferencesForDeploymentMock,
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  inArray: vi.fn((...args: unknown[]) => ({ inArray: args })),
  not: vi.fn((...args: unknown[]) => ({ not: args })),
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
    exists: vi.fn(),
  })),
}));

vi.mock('../router-debug', () => ({
  postRouterDebugMessage: postRouterDebugMessageMock,
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
  handleSlackRoutingCorrection,
  showTaskConfiguration,
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
      availableAgents: [{}],
      availableEnvironments: [{}],
    });
    routeTaskMock.mockResolvedValue({
      status: 'routed',
      result: {
        agentType: 'standard_task',
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
    findActiveSlackJobMock.mockResolvedValue(null);
    enqueueCloudTaskMock.mockResolvedValue({ id: 42, taskId: 'task_123' });
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
    redisDelMock.mockResolvedValue(1);
    classifyFollowUpMock.mockResolvedValue({
      intent: 'correct',
      reasoning: 'user supplied a correction',
    });
    setSlackStartedMessageTsMock.mockResolvedValue(undefined);
    deliveryTrackerCommitMock.mockResolvedValue(undefined);
    getSlackEmojiPreferencesForDeploymentMock.mockResolvedValue({
      slackAckEmoji: 'eyes',
      slackCompletionEmoji: 'white_check_mark',
      slackSummonEmoji: null,
    });
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
    expect(enqueueCloudTaskMock).not.toHaveBeenCalled();
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
    expect(enqueueCloudTaskMock).not.toHaveBeenCalled();
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
    expect(enqueueCloudTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: expect.objectContaining({
          slackThreadTs: '111.222',
        }),
      }),
      expect.anything(),
    );
    expect(enqueueCloudTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.not.objectContaining({
          requestedWorkKindDecision: expect.anything(),
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
    expect(enqueueCloudTaskMock).toHaveBeenCalledWith(
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

  it('starts immediately when all repositories is the only fallback workspace option', async () => {
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
    expect(enqueueCloudTaskMock).toHaveBeenCalledWith(
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
              text: 'Getting started on your task in `all repos`',
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
    expect(enqueueCloudTaskMock).not.toHaveBeenCalled();
  });
});
