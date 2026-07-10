import { AGENT_DISPLAY_NAME, TaskPayloadKind } from '@roomote/types';

const {
  taskRunFindFirstMock,
  taskFindFirstMock,
  slackInstallationFindFirstMock,
  slackUserMappingFindFirstMock,
  environmentFindFirstMock,
} = vi.hoisted(() => ({
  taskRunFindFirstMock: vi.fn(),
  taskFindFirstMock: vi.fn(),
  slackInstallationFindFirstMock: vi.fn(),
  slackUserMappingFindFirstMock: vi.fn(),
  environmentFindFirstMock: vi.fn(),
}));

const { redisSetMock } = vi.hoisted(() => ({
  redisSetMock: vi.fn(),
}));

const { setSlackStartedMessageTsMock } = vi.hoisted(() => ({
  setSlackStartedMessageTsMock: vi.fn(),
}));

const { startSlackAppMentionTaskMock } = vi.hoisted(() => ({
  startSlackAppMentionTaskMock: vi.fn(),
}));

const { getTaskUrlMock } = vi.hoisted(() => ({
  getTaskUrlMock: vi.fn(),
}));

vi.mock('@roomote/cloud-agents', () => ({
  stripLeadingRawSlackMention: vi.fn((text: string) => text),
  stripLeadingSlackProductMention: vi.fn((text: string) => text),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildSlackRoutingContext: vi.fn(),
  classifyFollowUp: vi.fn(),
  detectSlackMcpSetupRequirement: vi.fn().mockResolvedValue(null),
  getTaskUrl: getTaskUrlMock,
  routeTask: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  taskRuns: { id: 'id' },
  tasks: { id: 'id' },
  db: {
    query: {
      taskRuns: {
        findFirst: taskRunFindFirstMock,
      },
      tasks: {
        findFirst: taskFindFirstMock,
      },
      slackInstallations: {
        findFirst: slackInstallationFindFirstMock,
      },
      slackUserMappings: {
        findFirst: slackUserMappingFindFirstMock,
      },
      environments: {
        findFirst: environmentFindFirstMock,
      },
    },
  },
  environments: { id: 'id', orgId: 'orgId' },
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  inArray: vi.fn((...args: unknown[]) => ({ inArray: args })),
  not: vi.fn((...args: unknown[]) => ({ not: args })),
  repositories: {},
  slackAuthTokens: {},
  slackInstallations: {
    teamId: 'teamId',
    isActive: 'isActive',
  },
  slackUserMappings: {
    userId: 'userId',
    slackTeamId: 'slackTeamId',
    slackUserId: 'slackUserId',
  },
}));

vi.mock('@roomote/redis', () => ({
  REDIS_KEYS: {
    PENDING_WORKSPACE_SELECTIONS: 'pending_workspace_selections',
  },
  getRedis: vi.fn(() => ({
    del: vi.fn(),
    eval: vi.fn(),
    exists: vi.fn(),
    get: vi.fn(),
    getdel: vi.fn(),
    hget: vi.fn(),
    hset: vi.fn(),
    set: redisSetMock,
  })),
}));

vi.mock('../router-debug', () => ({
  postRouterDebugMessage: vi.fn(),
}));

vi.mock('../slack-messages', () => ({
  setQueuedSlackStartedMessageTs: vi.fn(),
  setSlackStartedMessageTs: setSlackStartedMessageTsMock,
}));

vi.mock('../slack-notifier', () => ({
  SlackNotifier: vi.fn(),
}));

vi.mock('../start-slack-app-mention', () => ({
  startSlackAppMentionTask: startSlackAppMentionTaskMock,
}));

vi.mock('../video-descriptions', () => ({
  appendSlackVideoDescriptionsToText: vi.fn(
    ({ text }: { text: string }) => text,
  ),
}));

import { handleRetryFailedTask } from '../block-kit';
import type { SlackInteractivePayload } from '../types';

function buildRetryPayload(
  actionValue: string,
  slackUserId = 'U123',
): SlackInteractivePayload {
  return {
    type: 'block_actions',
    team: {
      id: 'T123',
      domain: 'acme',
    },
    user: {
      id: slackUserId,
      name: 'alice',
    },
    channel: {
      id: 'C123',
      name: 'general',
    },
    message: {
      ts: '444.555',
      thread_ts: '111.222',
    },
    actions: [
      {
        type: 'button',
        action_id: 'retry_failed_task',
        text: { text: 'Try again' },
        value: actionValue,
      },
    ],
    state: {
      values: {},
    },
    response_url: 'https://slack.test/response',
    trigger_id: 'trigger-123',
  };
}

describe('handleRetryFailedTask', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({ ok: true });
    getTaskUrlMock.mockReturnValue('https://app.roomote.dev/tasks/task-77');
    startSlackAppMentionTaskMock.mockResolvedValue({
      id: 77,
      taskId: 'task-77',
      reusedExistingRun: false,
    });
    slackInstallationFindFirstMock.mockResolvedValue({
      id: 'slack-inst-1',
      botAccessToken: 'xoxb-test',
      isActive: true,
    });
    slackUserMappingFindFirstMock.mockResolvedValue({
      userId: 'user-1',
    });
    environmentFindFirstMock.mockResolvedValue({
      id: 'env-1',
      name: 'App',
      config: {
        repositories: [{ repository: 'owner/repo' }],
      },
    });
    taskFindFirstMock.mockResolvedValue({
      initiatorUserId: 'user-1',
    });
    setSlackStartedMessageTsMock.mockResolvedValue(undefined);
    redisSetMock.mockResolvedValue('OK');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('restarts the failed Slack task for the original requester', async () => {
    taskRunFindFirstMock.mockResolvedValue({
      id: 42,
      taskId: 'task-42',
      payloadKind: TaskPayloadKind.SlackAppMention,
      actingUserId: 'user-1',
      payload: {
        channel: 'C123',
        user: 'U123',
        text: 'please retry this',
        ts: '111.222',
        thread_ts: '111.222',
        repo: 'owner/repo',
        environmentId: 'env-1',
        readinessMessage: 'Warming up the workspace.',
        images: ['https://example.com/image.png'],
        threadMessages: [
          { ts: '111.200', text: 'Earlier thread context', user: 'U123' },
        ],
      },
    });

    await handleRetryFailedTask(
      buildRetryPayload(JSON.stringify({ runId: 42 })),
    );

    expect(startSlackAppMentionTaskMock).toHaveBeenCalledWith({
      initiator: {
        kind: 'user',
        externalId: 'U123',
        matchedUserId: 'user-1',
      },
      trigger: 'manual',
      channel: 'C123',
      teamId: 'T123',
      teamDomain: undefined,
      slackUserId: 'U123',
      text: 'please retry this',
      agentPromptText: undefined,
      ackEmoji: undefined,
      completionEmoji: undefined,
      ts: '111.222',
      threadTs: '111.222',
      repo: 'owner/repo',
      environmentId: 'env-1',
      readinessMessage: 'Warming up the workspace.',
      images: ['https://example.com/image.png'],
      threadMessages: [
        { ts: '111.200', text: 'Earlier thread context', user: 'U123' },
      ],
      latestOwnBotReplyText: undefined,
      latestOwnBotReplyTs: undefined,
      webPath: undefined,
      queuedStartedMessage: {
        ts: '444.555',
        agentName: 'Agent',
        workspaceDisplayName: 'App',
        workspaceOnly: false,
        initiatingSlackUserId: 'U123',
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.test/response',
      expect.objectContaining({
        body: JSON.stringify({
          replace_original: true,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: 'Getting started on your task in `App`',
              },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: {
                    type: 'plain_text',
                    text: 'Follow',
                    emoji: false,
                  },
                  action_id: 'follow_task',
                  url: 'https://app.roomote.dev/tasks/task-77',
                },
                {
                  type: 'button',
                  text: {
                    type: 'plain_text',
                    text: 'Cancel',
                    emoji: false,
                  },
                  action_id: 'cancel_task',
                  value: JSON.stringify({
                    taskId: 'task-77',
                    slackUserId: 'U123',
                  }),
                },
              ],
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: 'Warming up the workspace.',
              },
            },
          ],
        }),
      }),
    );
    expect(setSlackStartedMessageTsMock).toHaveBeenCalledWith(77, '444.555', {
      agentName: AGENT_DISPLAY_NAME,
      initiatingSlackUserId: 'U123',
      workspaceDisplayName: 'App',
      workspaceOnly: false,
    });
    expect(redisSetMock).toHaveBeenCalledWith(
      'last_workspace:user-1',
      'env:env-1',
      'EX',
      30 * 24 * 60 * 60,
    );
  });

  it('retries the failed Slack task when a different Slack user clicks Try again', async () => {
    taskRunFindFirstMock.mockResolvedValue({
      id: 42,
      taskId: 'task-42',
      payloadKind: TaskPayloadKind.SlackAppMention,
      actingUserId: 'user-1',
      payload: {
        channel: 'C123',
        user: 'U123',
        text: 'please retry this',
        ts: '111.222',
        thread_ts: '111.222',
        repo: 'owner/repo',
      },
    });

    await handleRetryFailedTask(
      buildRetryPayload(JSON.stringify({ runId: 42 }), 'U456'),
    );

    expect(startSlackAppMentionTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initiator: {
          kind: 'user',
          externalId: 'U123',
          matchedUserId: 'user-1',
        },
        trigger: 'manual',
        channel: 'C123',
        teamId: 'T123',
        slackUserId: 'U123',
        text: 'please retry this',
        repo: 'owner/repo',
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.test/response',
      expect.any(Object),
    );
    const retryResponse = fetchMock.mock.calls[0]?.[1];
    const responseBody =
      typeof retryResponse?.body === 'string'
        ? JSON.parse(retryResponse.body)
        : null;
    const actionsBlock = responseBody?.blocks?.find(
      (block: { type?: string }) => block.type === 'actions',
    );
    const cancelButton = actionsBlock?.elements?.find(
      (element: { action_id?: string }) => element.action_id === 'cancel_task',
    );

    expect(cancelButton?.value).toBe(
      JSON.stringify({
        taskId: 'task-77',
        slackUserId: 'U123',
      }),
    );
    expect(setSlackStartedMessageTsMock).toHaveBeenCalledWith(
      77,
      '444.555',
      expect.objectContaining({
        agentName: AGENT_DISPLAY_NAME,
        initiatingSlackUserId: 'U123',
        workspaceOnly: false,
      }),
    );
  });

  it('posts an error when the original failed job cannot be found', async () => {
    taskRunFindFirstMock.mockResolvedValue(null);

    await handleRetryFailedTask(
      buildRetryPayload(JSON.stringify({ runId: 42 })),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.test/response',
      expect.objectContaining({
        body: JSON.stringify({
          replace_original: false,
          text: 'I could not find the failed task to retry.',
        }),
      }),
    );
  });

  it('posts a fallback error when the retry attempt fails', async () => {
    taskRunFindFirstMock.mockResolvedValue({
      id: 42,
      taskId: 'task-42',
      payloadKind: TaskPayloadKind.SlackAppMention,
      actingUserId: 'user-1',
      payload: {
        channel: 'C123',
        user: 'U123',
        text: 'please retry this',
        ts: '111.222',
        thread_ts: '111.222',
        repo: 'owner/repo',
      },
    });
    startSlackAppMentionTaskMock.mockRejectedValue(new Error('queue failed'));

    await handleRetryFailedTask(
      buildRetryPayload(JSON.stringify({ runId: 42 })),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.test/response',
      expect.objectContaining({
        body: JSON.stringify({
          replace_original: false,
          text: 'I hit another issue while trying that again. Please retry from a fresh Slack mention.',
        }),
      }),
    );
  });

  it('posts an error when the original environment is no longer available', async () => {
    environmentFindFirstMock.mockResolvedValue(null);
    taskRunFindFirstMock.mockResolvedValue({
      id: 42,
      taskId: 'task-42',
      payloadKind: TaskPayloadKind.SlackAppMention,
      actingUserId: 'user-1',
      payload: {
        channel: 'C123',
        user: 'U123',
        text: 'please retry this',
        ts: '111.222',
        thread_ts: '111.222',
        repo: 'owner/repo',
        environmentId: 'env-1',
      },
    });

    await handleRetryFailedTask(
      buildRetryPayload(JSON.stringify({ runId: 42 })),
    );

    expect(startSlackAppMentionTaskMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.test/response',
      expect.objectContaining({
        body: JSON.stringify({
          replace_original: false,
          text: 'The environment used for this task is no longer available. Please send a fresh Slack message in another workspace.',
        }),
      }),
    );
  });
});
