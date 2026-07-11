const {
  buildSlackRoutingContextMock,
  detectSlackMcpSetupRequirementMock,
  routeTaskMock,
  repositoriesFindManyMock,
  environmentsFindManyMock,
  selectLimitMock,
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
  deliveryTrackerCommitMock,
  maybeNotifyManagerChannelForMcpSetupRequirementMock,
} = vi.hoisted(() => ({
  buildSlackRoutingContextMock: vi.fn(),
  detectSlackMcpSetupRequirementMock: vi.fn(),
  routeTaskMock: vi.fn(),
  repositoriesFindManyMock: vi.fn(),
  environmentsFindManyMock: vi.fn(),
  selectLimitMock: vi.fn(),
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
          limit: selectLimitMock,
        })),
      })),
    })),
  },
  environments: { orgId: 'orgId' },
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  inArray: vi.fn((...args: unknown[]) => ({ inArray: args })),
  not: vi.fn((...args: unknown[]) => ({ not: args })),
  repositories: { orgId: 'orgId', isActive: 'isActive' },
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
import {
  handleSlackMcpSetupConfigure,
  handleSlackMcpSetupIgnore,
  showTaskConfiguration,
} from '../block-kit';

describe('Slack MCP setup interruption flow', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts an interrupt instead of routing when setup is required', async () => {
    detectSlackMcpSetupRequirementMock.mockResolvedValue({
      serviceId: 'notion',
      serviceName: 'Notion',
      reason: 'user_auth_required',
      canConfigure: true,
      settingsUrl:
        'https://app.example.com/settings/personal?service=notion&source=slack-mcp-interrupt',
      copyVariant: 'user_auth_required',
    });

    const slack = new SlackNotifier('xoxb-test');

    const result = await showTaskConfiguration({
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

    expect(result).toEqual({ routingUsed: false, threadId: '111.222' });
    expect(detectSlackMcpSetupRequirementMock).toHaveBeenCalledWith(
      '<@BOT> review https://www.notion.so/acme/spec-123',
      expect.objectContaining({
        userId: 'user_1',
      }),
    );
    expect(fetchThreadMessagesMock).not.toHaveBeenCalled();
    expect(routeTaskMock).not.toHaveBeenCalled();
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: expect.arrayContaining([
          expect.objectContaining({ type: 'section' }),
          expect.objectContaining({
            type: 'actions',
            elements: expect.arrayContaining([
              expect.objectContaining({
                action_id: 'mcp_setup_configure',
                value: expect.any(String),
              }),
              expect.objectContaining({
                action_id: 'mcp_setup_ignore',
                value: expect.any(String),
              }),
            ]),
          }),
        ]),
      }),
    );
  });

  it('notifies the manager channel when org setup is required while keeping the requester prompt', async () => {
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

    const result = await showTaskConfiguration({
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

    expect(result).toEqual({ routingUsed: false, threadId: '111.222' });
    expect(
      maybeNotifyManagerChannelForMcpSetupRequirementMock,
    ).toHaveBeenCalledWith({
      triggeredByUserId: 'user_1',
      triggeredBySlackUserId: 'U123',
      requirement: setupRequirement,
      slack,
    });
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '111.222',
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: 'actions',
            elements: expect.arrayContaining([
              expect.objectContaining({ action_id: 'mcp_setup_configure' }),
            ]),
          }),
        ]),
      }),
    );
  });

  it('clears the interrupt and replaces the prompt after Configure', async () => {
    redisEvalMock.mockResolvedValueOnce(
      JSON.stringify({
        copyVariant: 'user_auth_required',
        nonce: 'nonce-123',
      }),
    );

    await handleSlackMcpSetupConfigure({
      type: 'block_actions',
      team: { id: 'T123', domain: 'acme' },
      user: { id: 'U123', name: 'alice' },
      channel: { id: 'C123', name: 'general' },
      message: { ts: '111.222' },
      actions: [
        {
          type: 'button',
          action_id: 'mcp_setup_configure',
          text: { text: 'Configure' },
          value: 'nonce-123',
        },
      ],
      state: { values: {} },
      response_url: 'https://slack.test/response',
      trigger_id: 'trigger-123',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.test/response',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining(
          'Finish setup in the web app, then send this request again.',
        ),
      }),
    );
    expect(redisEvalMock).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'slack:mcp-setup-interrupt:111.222',
      'nonce-123',
      'U123',
    );
  });

  it('continues into the normal routing path when Ignore is clicked', async () => {
    detectSlackMcpSetupRequirementMock.mockResolvedValue(null);
    redisEvalMock.mockResolvedValueOnce(
      JSON.stringify({
        threadId: '111.222',
        teamId: 'T123',
        slackUserId: 'U123',
        channel: 'C123',
        originalEvent: {
          type: 'app_mention',
          channel: 'C123',
          user: 'U123',
          text: '<@BOT> ignore and continue',
          ts: '111.222',
        },
        normalizedTaskText: '<@BOT> ignore and continue',
        serviceId: 'notion',
        serviceName: 'Notion',
        reason: 'user_auth_required',
        canConfigure: true,
        settingsUrl:
          'https://app.example.com/settings/personal?service=notion&source=slack-mcp-interrupt',
        copyVariant: 'user_auth_required',
        originalMessageTs: '111.222',
        nonce: 'nonce-123',
      }),
    );
    selectLimitMock
      .mockResolvedValueOnce([
        {
          teamId: 'T123',
          botAccessToken: 'xoxb-test',
        },
      ])
      .mockResolvedValueOnce([
        {
          userId: 'user_1',
        },
      ]);

    await handleSlackMcpSetupIgnore({
      type: 'block_actions',
      team: { id: 'T123', domain: 'acme' },
      user: { id: 'U123', name: 'alice' },
      channel: { id: 'C123', name: 'general' },
      message: { ts: '111.222' },
      actions: [
        {
          type: 'button',
          action_id: 'mcp_setup_ignore',
          text: { text: 'Ignore' },
          value: 'nonce-123',
        },
      ],
      state: { values: {} },
      response_url: 'https://slack.test/response',
      trigger_id: 'trigger-123',
    });

    expect(detectSlackMcpSetupRequirementMock).not.toHaveBeenCalled();
    expect(buildSlackRoutingContextMock).toHaveBeenCalledTimes(1);
    expect(updateMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        ts: '111.222',
      }),
    );
    expect(redisEvalMock).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'slack:mcp-setup-interrupt:111.222',
      'nonce-123',
      'U123',
    );
  });

  it('ignores stale Configure clicks when nonce does not match', async () => {
    redisEvalMock.mockResolvedValueOnce(null);

    await handleSlackMcpSetupConfigure({
      type: 'block_actions',
      team: { id: 'T123', domain: 'acme' },
      user: { id: 'U123', name: 'alice' },
      channel: { id: 'C123', name: 'general' },
      message: { ts: '111.222' },
      actions: [
        {
          type: 'button',
          action_id: 'mcp_setup_configure',
          text: { text: 'Configure' },
          value: 'stale-nonce',
        },
      ],
      state: { values: {} },
      response_url: 'https://slack.test/response',
      trigger_id: 'trigger-123',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(selectLimitMock).not.toHaveBeenCalled();
  });

  it('ignores Ignore clicks from other Slack users', async () => {
    redisEvalMock.mockResolvedValueOnce(null);

    await handleSlackMcpSetupIgnore({
      type: 'block_actions',
      team: { id: 'T123', domain: 'acme' },
      user: { id: 'U999', name: 'teammate' },
      channel: { id: 'C123', name: 'general' },
      message: { ts: '111.222' },
      actions: [
        {
          type: 'button',
          action_id: 'mcp_setup_ignore',
          text: { text: 'Ignore' },
          value: 'nonce-123',
        },
      ],
      state: { values: {} },
      response_url: 'https://slack.test/response',
      trigger_id: 'trigger-123',
    });

    expect(redisEvalMock).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'slack:mcp-setup-interrupt:111.222',
      'nonce-123',
      'U999',
    );
    expect(selectLimitMock).not.toHaveBeenCalled();
    expect(buildSlackRoutingContextMock).not.toHaveBeenCalled();
    expect(updateMessageMock).not.toHaveBeenCalled();
  });
});
