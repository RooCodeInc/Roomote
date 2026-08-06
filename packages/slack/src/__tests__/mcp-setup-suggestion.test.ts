const {
  buildSlackRoutingContextMock,
  detectSlackMcpSetupRequirementMock,
  routeTaskMock,
  repositoriesFindManyMock,
  environmentsFindManyMock,
  hasMessageInThreadMock,
  fetchThreadMessagesMock,
  normalizeIncomingTextMock,
  postMessageMock,
  updateMessageMock,
  redisSetMock,
  redisGetdelMock,
  redisGetMock,
  redisHsetMock,
  redisEvalMock,
  deliveryTrackerTrackMock,
  deliveryTrackerCommitMock,
  maybeNotifyManagerChannelForMcpSetupRequirementMock,
} = vi.hoisted(() => ({
  buildSlackRoutingContextMock: vi.fn(),
  detectSlackMcpSetupRequirementMock: vi.fn(),
  routeTaskMock: vi.fn(),
  repositoriesFindManyMock: vi.fn(),
  environmentsFindManyMock: vi.fn(),
  hasMessageInThreadMock: vi.fn(),
  fetchThreadMessagesMock: vi.fn(),
  normalizeIncomingTextMock: vi.fn(),
  postMessageMock: vi.fn(),
  updateMessageMock: vi.fn(),
  redisSetMock: vi.fn(),
  redisGetdelMock: vi.fn(),
  redisGetMock: vi.fn(),
  redisHsetMock: vi.fn(),
  redisEvalMock: vi.fn(),
  deliveryTrackerTrackMock: vi.fn(),
  deliveryTrackerCommitMock: vi.fn(),
  maybeNotifyManagerChannelForMcpSetupRequirementMock: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildSlackRoutingContext: buildSlackRoutingContextMock,
  detectSlackMcpSetupRequirement: detectSlackMcpSetupRequirementMock,
  routeTask: routeTaskMock,
  classifyFollowUp: vi.fn(),
  getTaskUrl: vi.fn(),
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
      R_APP_URL: 'https://app.example.com',
      TRPC_URL: 'https://api.example.com',
    },
  };
});

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  db: {
    query: {
      repositories: { findMany: repositoriesFindManyMock },
      environments: { findMany: environmentsFindManyMock, findFirst: vi.fn() },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(),
        })),
      })),
    })),
  },
  environments: { orgId: 'orgId' },
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  inArray: vi.fn((...args: unknown[]) => ({ inArray: args })),
  not: vi.fn((...args: unknown[]) => ({ not: args })),
  repositories: { orgId: 'orgId', isActive: 'isActive' },
  recordTaskKickoffMessageBestEffort: vi.fn().mockResolvedValue(undefined),
  slackInstallations: { teamId: 'teamId' },
  slackUserMappings: { slackUserId: 'slackUserId', slackTeamId: 'slackTeamId' },
  taskRuns: { id: 'id' },
}));

vi.mock('@roomote/redis', () => ({
  REDIS_KEYS: {
    PENDING_WORKSPACE_SELECTIONS: 'pending_workspace_selections',
  },
  getRedis: vi.fn(() => ({
    eval: redisEvalMock,
    exists: vi.fn().mockResolvedValue(0),
    get: redisGetMock,
    getdel: redisGetdelMock,
    hset: redisHsetMock,
    set: redisSetMock,
    del: vi.fn(),
  })),
}));

vi.mock('../slack-thread-delivery-tracker', () => ({
  SlackThreadDeliveryTracker: vi.fn().mockImplementation(function () {
    return {
      track: deliveryTrackerTrackMock,
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
      postMessage: postMessageMock,
      updateMessage: updateMessageMock,
    };
  }),
}));

vi.mock('../start-slack-app-mention', () => ({
  startSlackAppMentionTask: vi.fn(),
}));

vi.mock('../router-debug', () => ({
  postRouterDebugMessage: vi.fn(),
  postRouterFallbackDebugMessage: vi.fn(),
}));

vi.mock('../slack-messages', () => ({
  setQueuedSlackStartedMessageTs: vi.fn(),
  setSlackStartedMessageTs: vi.fn(),
}));

vi.mock('../manager-mcp-setup', () => ({
  maybeNotifyManagerChannelForMcpSetupRequirement:
    maybeNotifyManagerChannelForMcpSetupRequirementMock,
}));

import { SlackNotifier } from '../slack-notifier';
import { showTaskConfiguration } from '../block-kit';
import {
  buildSlackMcpSetupSuggestionBlocks,
  buildSlackMcpSetupSuggestionText,
} from '../mcp-setup-suggestion';

const SETUP_REQUIREMENT = {
  serviceId: 'notion',
  serviceName: 'Notion',
  reason: 'user_auth_required',
  canConfigure: true,
  settingsUrl:
    'https://app.example.com/settings/personal?service=notion&source=slack-mcp-interrupt',
  copyVariant: 'user_auth_required',
} as const;

describe('Slack MCP setup suggestion flow', () => {
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
    hasMessageInThreadMock.mockResolvedValue(true);
    fetchThreadMessagesMock.mockResolvedValue([]);
    normalizeIncomingTextMock.mockImplementation(async (text: string) => text);
    postMessageMock.mockResolvedValue('999.000');
    updateMessageMock.mockResolvedValue(true);
    redisSetMock.mockResolvedValue('OK');
    redisGetMock.mockResolvedValue(null);
    redisGetdelMock.mockResolvedValue(null);
    redisHsetMock.mockResolvedValue(1);
    redisEvalMock.mockResolvedValue(null);
    deliveryTrackerCommitMock.mockResolvedValue(undefined);
    maybeNotifyManagerChannelForMcpSetupRequirementMock.mockResolvedValue({
      posted: false,
      reason: 'missing_manager_channel',
    });
    buildSlackRoutingContextMock.mockResolvedValue({
      availableEnvironments: [],
    });
    routeTaskMock.mockResolvedValue({
      status: 'fallback',
      reason: 'fallback',
    });
  });

  it('posts a non-blocking suggestion and keeps routing when setup is required', async () => {
    detectSlackMcpSetupRequirementMock.mockResolvedValue(SETUP_REQUIREMENT);

    const slack = new SlackNotifier('xoxb-test');

    await showTaskConfiguration({
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> review https://www.notion.so/acme/spec-123',
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

    expect(detectSlackMcpSetupRequirementMock).toHaveBeenCalledWith(
      '<@BOT> review https://www.notion.so/acme/spec-123',
      expect.objectContaining({
        userId: 'user_1',
      }),
    );
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '111.222',
        blocks: [
          expect.objectContaining({
            type: 'context',
            elements: [
              expect.objectContaining({
                type: 'mrkdwn',
                text: expect.stringContaining('link your Notion account'),
              }),
            ],
          }),
        ],
      }),
    );
    expect(deliveryTrackerTrackMock).toHaveBeenCalledWith('999.000');
    // Routing must proceed despite the missing setup.
    expect(buildSlackRoutingContextMock).toHaveBeenCalledTimes(1);
    expect(routeTaskMock).toHaveBeenCalledTimes(1);
  });

  it('notifies the manager channel while continuing the task', async () => {
    const setupRequirement = {
      serviceId: 'sentry',
      serviceName: 'Sentry',
      reason: 'deployment_disabled',
      canConfigure: true,
      settingsUrl:
        'https://app.example.com/settings/integrations?highlight=sentry-mcp&source=slack-mcp-interrupt',
      copyVariant: 'deployment_disabled_admin',
    };
    detectSlackMcpSetupRequirementMock.mockResolvedValue(setupRequirement);

    const slack = new SlackNotifier('xoxb-test');

    await showTaskConfiguration({
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> review https://acme.sentry.io/issues/123',
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

    expect(
      maybeNotifyManagerChannelForMcpSetupRequirementMock,
    ).toHaveBeenCalledWith({
      triggeredByUserId: 'user_1',
      triggeredBySlackUserId: 'U123',
      requirement: setupRequirement,
      slack,
    });
    expect(routeTaskMock).toHaveBeenCalledTimes(1);
  });

  it('does not post a suggestion when routing resolves to a platform answer', async () => {
    detectSlackMcpSetupRequirementMock.mockResolvedValue(SETUP_REQUIREMENT);
    routeTaskMock.mockResolvedValue({
      status: 'platform_answer',
      result: { answer: 'Roomote supports Notion via MCP.' },
    });

    const slack = new SlackNotifier('xoxb-test');

    await showTaskConfiguration({
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> does Roomote support https://www.notion.so?',
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

    const suggestionPosts = postMessageMock.mock.calls.filter((call) =>
      JSON.stringify(call[0]).includes('That looks like a'),
    );
    expect(suggestionPosts).toHaveLength(0);
    expect(
      maybeNotifyManagerChannelForMcpSetupRequirementMock,
    ).not.toHaveBeenCalled();
  });

  it('does not post a suggestion when no setup is required', async () => {
    detectSlackMcpSetupRequirementMock.mockResolvedValue(null);

    const slack = new SlackNotifier('xoxb-test');

    await showTaskConfiguration({
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@BOT> review this please',
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

    expect(
      maybeNotifyManagerChannelForMcpSetupRequirementMock,
    ).not.toHaveBeenCalled();
    const suggestionPosts = postMessageMock.mock.calls.filter((call) => {
      const message = call[0] as { blocks?: Array<{ type?: string }> };
      return message.blocks?.some((block) => block.type === 'context');
    });
    expect(suggestionPosts).toHaveLength(0);
    expect(routeTaskMock).toHaveBeenCalledTimes(1);
  });

  it('keeps routing when setup detection fails', async () => {
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    try {
      detectSlackMcpSetupRequirementMock.mockRejectedValue(
        new Error('detection down'),
      );

      const slack = new SlackNotifier('xoxb-test');

      await showTaskConfiguration({
        event: {
          type: 'app_mention',
          channel: 'C123',
          user: 'U123',
          text: '<@BOT> review https://www.notion.so/acme/spec-123',
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

      expect(routeTaskMock).toHaveBeenCalledTimes(1);
      expect(
        maybeNotifyManagerChannelForMcpSetupRequirementMock,
      ).not.toHaveBeenCalled();
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });
});

describe('buildSlackMcpSetupSuggestionText', () => {
  it.each([
    [
      'user_auth_required',
      '<https://app.example.com/settings|link your Zero account>',
    ],
    [
      'deployment_disabled_admin',
      '<https://app.example.com/settings|enable the Zero integration>',
    ],
    [
      'deployment_auth_required_admin',
      '<https://app.example.com/settings|finish connecting Zero>',
    ],
    ['deployment_disabled_non_admin', 'ask a'],
    ['deployment_auth_required_non_admin', 'ask a'],
  ] as const)('renders the %s variant', (copyVariant, expected) => {
    const text = buildSlackMcpSetupSuggestionText({
      serviceId: 'zero',
      serviceName: 'Zero',
      settingsUrl: 'https://app.example.com/settings',
      copyVariant,
    });

    expect(text).toContain('That looks like a Zero link');
    expect(text).toContain(expected);
  });

  it('builds a single context block', () => {
    const blocks = buildSlackMcpSetupSuggestionBlocks({
      serviceId: 'zero',
      serviceName: 'Zero',
      settingsUrl: 'https://app.example.com/settings',
      copyVariant: 'user_auth_required',
    });

    expect(blocks).toEqual([
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: buildSlackMcpSetupSuggestionText({
              serviceId: 'zero',
              serviceName: 'Zero',
              settingsUrl: 'https://app.example.com/settings',
              copyVariant: 'user_auth_required',
            }),
          },
        ],
      },
    ]);
  });
});
